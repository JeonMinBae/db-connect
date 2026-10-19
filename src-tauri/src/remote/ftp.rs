use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use suppaftp::async_native_tls::TlsConnector;
use suppaftp::list::{File, ListParser};
use suppaftp::tokio::{AsyncNativeTlsConnector, AsyncNativeTlsFtpStream};
use suppaftp::types::FileType;
use suppaftp::{Encoding, FtpError};
use tokio::io::{AsyncRead, AsyncReadExt, AsyncWrite, AsyncWriteExt};

use super::io::Counting;
use super::{path, Entry, Stamp};
use crate::error::{AppError, AppResult};
use crate::store::config::{ConnectionConfig, FsEncoding, FtpTls};

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

/// 서버 파일명이 EUC-KR 일 때 제어 연결 명령·목록 줄을 변환한다.
#[derive(Debug)]
struct EucKr;

impl Encoding for EucKr {
    fn decode(&self, bytes: &[u8]) -> String {
        encoding_rs::EUC_KR.decode_without_bom_handling(bytes).0.into_owned()
    }

    fn encode(&self, text: &str) -> std::io::Result<Vec<u8>> {
        let (b, _, bad) = encoding_rs::EUC_KR.encode(text);
        if bad {
            return Err(std::io::Error::new(std::io::ErrorKind::InvalidInput, "EUC-KR 로 표현할 수 없는 문자가 있습니다"));
        }
        Ok(b.into_owned())
    }
}

pub struct FtpSession {
    ftp: AsyncNativeTlsFtpStream,
    /// MLSD 가 500/502 로 거부된 서버는 이후 LIST 만 쓴다
    no_mlsd: bool,
}

/// FTP 응답 코드 (UnexpectedResponse 일 때만)
fn code(e: &FtpError) -> Option<u32> {
    match e {
        FtpError::UnexpectedResponse(r) => Some(r.status as u32),
        _ => None,
    }
}

fn reply_text(r: &suppaftp::types::Response) -> String {
    String::from_utf8_lossy(&r.body).trim().to_string()
}

fn ftp_err(e: FtpError) -> AppError {
    match &e {
        FtpError::ConnectionError(_) => AppError::Disconnected(e.to_string()),
        // 421: 서버가 제어 연결을 닫는 중
        FtpError::UnexpectedResponse(r) if r.status as u32 == 421 => AppError::Disconnected(reply_text(r)),
        FtpError::UnexpectedResponse(r) => AppError::Remote(reply_text(r)),
        _ => AppError::Remote(e.to_string()),
    }
}

/// "localhost" 는 ::1 부터 시도돼 지연되므로 IPv4 로 접속한다 (sftp.rs 와 같은 이유).
/// TLS 도메인 검증에는 입력한 host 를 그대로 쓴다.
fn connect_host(host: &str) -> &str {
    if host.eq_ignore_ascii_case("localhost") {
        "127.0.0.1"
    } else {
        host
    }
}

fn connector(cfg: &ConnectionConfig) -> AsyncNativeTlsConnector {
    let mut c = TlsConnector::new();
    if cfg.tls_insecure {
        c = c.danger_accept_invalid_certs(true).danger_accept_invalid_hostnames(true);
    }
    AsyncNativeTlsConnector::from(c)
}

impl FtpSession {
    pub async fn open(cfg: &ConnectionConfig, secret: Option<&str>) -> AppResult<Self> {
        tokio::time::timeout(CONNECT_TIMEOUT, Self::connect(cfg, secret))
            .await
            .unwrap_or_else(|_| Err(AppError::Remote("접속 시간이 초과되었습니다".into())))
    }

    async fn connect(cfg: &ConnectionConfig, secret: Option<&str>) -> AppResult<Self> {
        let addr = (connect_host(&cfg.host).to_string(), cfg.port);
        let mut ftp = match cfg.ftp_tls {
            FtpTls::None => AsyncNativeTlsFtpStream::connect(addr).await,
            FtpTls::Explicit => {
                let s = AsyncNativeTlsFtpStream::connect(addr).await.map_err(ftp_err)?;
                s.into_secure(connector(cfg), &cfg.host).await
            }
            FtpTls::Implicit => AsyncNativeTlsFtpStream::connect_secure_implicit(addr, connector(cfg), &cfg.host).await,
        }
        .map_err(ftp_err)?;
        // 사설망 뒤 서버가 PASV 로 내부 IP 를 알려 줘도 접속한 주소로 데이터 연결을 맺는다
        ftp.set_passive_nat_workaround(true);
        if cfg.fs_encoding == FsEncoding::EucKr {
            ftp.set_encoding(EucKr).await;
        }
        ftp.login(cfg.user.as_str(), secret.unwrap_or("")).await.map_err(|e| match code(&e) {
            Some(530) => AppError::user("인증에 실패했습니다. 사용자·비밀번호를 확인하세요."),
            _ => ftp_err(e),
        })?;
        // 기본 전송 타입이 ASCII 라 줄바꿈이 변환되므로 바이너리로 고정한다
        ftp.transfer_type(FileType::Binary).await.map_err(ftp_err)?;
        if cfg.fs_encoding == FsEncoding::Utf8 {
            // 서버가 지원할 때만 UTF-8 파일명으로 맞춘다 (미지원이어도 무시)
            let _ = ftp.opts("UTF8", Some("ON")).await;
        }
        Ok(Self { ftp, no_mlsd: false })
    }

    pub async fn noop(&mut self) -> AppResult<()> {
        self.ftp.noop().await.map_err(ftp_err)
    }

    /// (항목, 링크 여부). 링크는 가리키는 대상이 폴더면 dir 로 본다.
    async fn list_raw(&mut self, dir: &str) -> Result<Vec<(Entry, bool)>, FtpError> {
        let dir = path::normalize(dir);
        let mut files: Vec<(File, Option<u32>)> = Vec::new();
        let mut done = false;
        if !self.no_mlsd {
            match self.ftp.mlsd(Some(&dir)).await {
                Ok(lines) => {
                    for l in lines {
                        let lower = l.to_ascii_lowercase();
                        if lower.contains("type=cdir") || lower.contains("type=pdir") {
                            continue;
                        }
                        if let Ok(f) = ListParser::parse_mlsd(&l) {
                            files.push((f, mlsd_mode(&l)));
                        }
                    }
                    done = true;
                }
                Err(e) if matches!(code(&e), Some(500 | 502)) => self.no_mlsd = true,
                Err(e) => return Err(e),
            }
        }
        if !done {
            for l in self.ftp.list(Some(&dir)).await? {
                if let Ok(f) = File::try_from(l.as_str()) {
                    files.push((f, None));
                }
            }
        }
        let mut out = Vec::new();
        for (f, perm) in files {
            let name = f.name().to_string();
            if name == "." || name == ".." || name.is_empty() {
                continue;
            }
            let link = f.is_symlink();
            let mut is_dir = f.is_directory();
            if link {
                // LIST 는 링크 대상 종류를 알려 주지 않으므로 CWD 로 확인한다
                if self.ftp.cwd(path::join(&dir, &name)).await.is_ok() {
                    is_dir = true;
                    let _ = self.ftp.cwd("/").await;
                }
            }
            let mtime = (f.modified() != SystemTime::UNIX_EPOCH)
                .then(|| f.modified().duration_since(UNIX_EPOCH).ok().map(|d| d.as_millis() as i64))
                .flatten();
            out.push((Entry { name, dir: is_dir, size: f.size() as u64, mtime, perm }, link));
        }
        Ok(out)
    }

    pub async fn list(&mut self, dir: &str) -> AppResult<Vec<Entry>> {
        Ok(self.list_raw(dir).await.map_err(ftp_err)?.into_iter().map(|(e, _)| e).collect())
    }

    async fn find(&mut self, p: &str) -> AppResult<Option<(Entry, bool)>> {
        let p = path::normalize(p);
        if p == "/" {
            return Ok(Some((Entry { name: String::new(), dir: true, size: 0, mtime: None, perm: None }, false)));
        }
        let name = path::name(&p).to_string();
        match self.list_raw(&path::parent(&p)).await {
            // 부모가 없으면 대상도 없다
            Err(e) if code(&e) == Some(550) => Ok(None),
            Err(e) => Err(ftp_err(e)),
            Ok(v) => Ok(v.into_iter().find(|(e, _)| e.name == name)),
        }
    }

    pub async fn stat(&mut self, p: &str) -> AppResult<Option<(Entry, Stamp)>> {
        Ok(self.find(p).await?.map(|(e, _)| {
            let stamp = Stamp { size: e.size, mtime: e.mtime, etag: None };
            (e, stamp)
        }))
    }

    pub async fn mkdir(&mut self, p: &str) -> AppResult<()> {
        self.ftp.mkdir(path::normalize(p)).await.map_err(ftp_err)
    }

    pub async fn rename(&mut self, from: &str, to: &str) -> AppResult<()> {
        self.ftp.rename(path::normalize(from), path::normalize(to)).await.map_err(ftp_err)
    }

    pub async fn chmod(&mut self, p: &str, mode: u32) -> AppResult<()> {
        let p = path::normalize(p);
        // 제어 채널 한 줄이므로 줄바꿈이 섞인 경로로 명령이 끼어들지 못하게 거부한다
        if p.contains(['\r', '\n']) {
            return Err(AppError::user("경로에 줄바꿈을 쓸 수 없습니다"));
        }
        self.ftp.site(format!("CHMOD {:o} {p}", mode & 0o7777)).await.map_err(ftp_err)?;
        Ok(())
    }

    pub async fn remove_file(&mut self, p: &str) -> AppResult<()> {
        self.ftp.rm(path::normalize(p)).await.map_err(ftp_err)
    }

    pub async fn remove_dir(&mut self, p: &str) -> AppResult<()> {
        self.ftp.rmdir(path::normalize(p)).await.map_err(ftp_err)
    }

    pub async fn is_link(&mut self, p: &str) -> AppResult<bool> {
        Ok(self.find(p).await?.is_some_and(|(_, link)| link))
    }

    pub async fn upload(&mut self, p: &str, reader: impl AsyncRead + Unpin + Send, _len: u64, counter: Arc<AtomicU64>) -> AppResult<()> {
        let mut data = self.ftp.put_with_stream(path::normalize(p)).await.map_err(ftp_err)?;
        let mut r = Counting::new(reader, counter);
        // 복사가 실패하면 data 가 drop 되며 전송이 중단 처리된다
        tokio::io::copy(&mut r, &mut data).await.map_err(|e| AppError::Remote(e.to_string()))?;
        data.finish().await.map_err(ftp_err)
    }

    pub async fn download(&mut self, p: &str, writer: impl AsyncWrite + Unpin + Send, counter: Arc<AtomicU64>) -> AppResult<()> {
        let mut data = self.ftp.retr_as_stream(path::normalize(p)).await.map_err(ftp_err)?;
        let mut w = Counting::new(writer, counter);
        tokio::io::copy(&mut data, &mut w).await.map_err(|e| AppError::Remote(e.to_string()))?;
        w.flush().await.map_err(|e| AppError::Remote(e.to_string()))?;
        data.finish().await.map_err(ftp_err)
    }

    pub async fn read_all(&mut self, p: &str, limit: u64) -> AppResult<Vec<u8>> {
        let p = path::normalize(p);
        // SIZE 미지원 서버는 읽으면서 limit 에서 끊는다
        if let Ok(n) = self.ftp.size(&p).await {
            if n as u64 > limit {
                return Err(AppError::user("파일이 너무 큽니다"));
            }
        }
        let mut data = self.ftp.retr_as_stream(&p).await.map_err(ftp_err)?;
        let mut buf = Vec::new();
        (&mut data).take(limit + 1).read_to_end(&mut buf).await.map_err(|e| AppError::Remote(e.to_string()))?;
        if buf.len() as u64 > limit {
            return Err(AppError::user("파일이 너무 큽니다"));
        }
        data.finish().await.map_err(ftp_err)?;
        Ok(buf)
    }

    pub async fn write_all(&mut self, p: &str, bytes: &[u8]) -> AppResult<()> {
        self.upload(p, bytes, bytes.len() as u64, Default::default()).await
    }
}

/// MLSD 줄의 "UNIX.mode=0755" 사실 (없으면 None)
fn mlsd_mode(line: &str) -> Option<u32> {
    let facts = line.split("; ").next()?;
    facts.split(';').find_map(|f| {
        let (k, v) = f.split_once('=')?;
        if k.eq_ignore_ascii_case("unix.mode") {
            u32::from_str_radix(v, 8).ok().map(|m| m & 0o7777)
        } else {
            None
        }
    })
}
