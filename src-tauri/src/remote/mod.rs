//! 원격 파일 접속 공통 계층. 프로토콜별 세션은 `Session` enum 으로 디스패치한다.
pub mod ftp;
pub mod io;
pub mod known_hosts;
pub mod ops;
pub mod path;
pub mod picks;
pub mod s3;
pub mod sftp;
pub mod text;
pub mod transfer;
#[cfg(test)]
#[path = "it.rs"]
mod remote_it;

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;
use std::time::Duration;

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::store::config::{ConnectionConfig, Driver, FtpTls};

#[derive(Serialize, Clone, Debug)]
pub struct Entry {
    pub name: String,
    pub dir: bool,
    pub size: u64,
    /// epoch ms (서버가 주지 않으면 None)
    pub mtime: Option<i64>,
    /// 유닉스 권한 비트 (S3 는 None)
    pub perm: Option<u32>,
}

/// 편집 충돌 감지용: 열 때와 저장 직전 값을 비교한다 (S3 는 etag 만 비교)
#[derive(Serialize, Deserialize, Clone, Debug, PartialEq)]
pub struct Stamp {
    pub size: u64,
    pub mtime: Option<i64>,
    pub etag: Option<String>,
}

pub enum Session {
    Sftp(sftp::SftpSession),
    Ftp(ftp::FtpSession),
    S3(s3::S3Session),
}

impl Session {
    pub async fn open(cfg: &ConnectionConfig, secret: Option<&str>, data_dir: &Path) -> AppResult<Self> {
        match cfg.driver {
            Driver::Sftp => Ok(Self::Sftp(sftp::SftpSession::open(cfg, secret, data_dir).await?)),
            Driver::Ftp => Ok(Self::Ftp(ftp::FtpSession::open(cfg, secret).await?)),
            Driver::S3 => Ok(Self::S3(s3::S3Session::open(cfg, secret).await?)),
            _ => Err(AppError::user("파일 접속이 아닙니다")),
        }
    }

    /// FTP 유휴 연결 유지용 (SFTP 는 russh 가 자체 keepalive)
    pub async fn noop(&mut self) -> AppResult<()> {
        match self {
            Self::Sftp(_) | Self::S3(_) => Ok(()),
            Self::Ftp(s) => s.noop().await,
        }
    }

    pub async fn list(&mut self, path: &str) -> AppResult<Vec<Entry>> {
        match self {
            Self::Sftp(s) => s.list(path).await,
            Self::Ftp(s) => s.list(path).await,
            Self::S3(s) => s.list(path).await,
        }
    }

    pub async fn stat(&mut self, path: &str) -> AppResult<Option<(Entry, Stamp)>> {
        match self {
            Self::Sftp(s) => s.stat(path).await,
            Self::Ftp(s) => s.stat(path).await,
            Self::S3(s) => s.stat(path).await,
        }
    }

    pub async fn mkdir(&mut self, path: &str) -> AppResult<()> {
        match self {
            Self::Sftp(s) => s.mkdir(path).await,
            Self::Ftp(s) => s.mkdir(path).await,
            Self::S3(s) => s.mkdir(path).await,
        }
    }

    pub async fn rename(&mut self, from: &str, to: &str) -> AppResult<()> {
        match self {
            Self::Sftp(s) => s.rename(from, to).await,
            Self::Ftp(s) => s.rename(from, to).await,
            Self::S3(s) => s.rename(from, to).await,
        }
    }

    pub async fn chmod(&mut self, path: &str, mode: u32) -> AppResult<()> {
        match self {
            Self::Sftp(s) => s.chmod(path, mode).await,
            Self::Ftp(s) => s.chmod(path, mode).await,
            Self::S3(s) => s.chmod(path, mode).await,
        }
    }

    /// S3 전용 서버 복사. FTP/SFTP 는 transfer 의 stream_copy 를 쓴다.
    pub async fn server_copy(&mut self, from: &str, to: &str) -> AppResult<()> {
        match self {
            Self::S3(s) => s.server_copy(from, to).await,
            _ => Err(AppError::user("서버 복사는 S3 접속에서만 사용할 수 있습니다")),
        }
    }

    pub async fn remove_file(&mut self, path: &str) -> AppResult<()> {
        match self {
            Self::Sftp(s) => s.remove_file(path).await,
            Self::Ftp(s) => s.remove_file(path).await,
            Self::S3(s) => s.remove_file(path).await,
        }
    }

    pub async fn remove_dir(&mut self, path: &str) -> AppResult<()> {
        match self {
            Self::Sftp(s) => s.remove_dir(path).await,
            Self::Ftp(s) => s.remove_dir(path).await,
            Self::S3(s) => s.remove_dir(path).await,
        }
    }

    pub async fn is_link(&mut self, path: &str) -> AppResult<bool> {
        match self {
            Self::Sftp(s) => s.is_link(path).await,
            Self::Ftp(s) => s.is_link(path).await,
            Self::S3(s) => s.is_link(path).await,
        }
    }

    /// 메모리로 읽는다. limit 보다 크면 사용자 오류.
    pub async fn read_all(&mut self, path: &str, limit: u64) -> AppResult<Vec<u8>> {
        match self {
            Self::Sftp(s) => s.read_all(path, limit).await,
            Self::Ftp(s) => s.read_all(path, limit).await,
            Self::S3(s) => s.read_all(path, limit).await,
        }
    }

    /// 파일을 만들거나 비우고 bytes 로 채운다.
    pub async fn write_all(&mut self, path: &str, bytes: &[u8]) -> AppResult<()> {
        match self {
            Self::Sftp(s) => s.write_all(path, bytes).await,
            Self::Ftp(s) => s.write_all(path, bytes).await,
            Self::S3(s) => s.write_all(path, bytes).await,
        }
    }

    pub async fn upload(&mut self, path: &str, reader: impl AsyncRead + Unpin + Send, counter: Arc<AtomicU64>) -> AppResult<()> {
        match self {
            Self::Sftp(s) => s.upload(path, reader, counter).await,
            Self::Ftp(s) => s.upload(path, reader, counter).await,
            Self::S3(s) => s.upload(path, reader, counter).await,
        }
    }

    /// S3 객체의 Content-Type. S3 가 아니면 None.
    pub async fn content_type(&mut self, path: &str) -> AppResult<Option<String>> {
        match self {
            Self::S3(s) => s.content_type(path).await,
            _ => Ok(None),
        }
    }

    /// 접속 간 복사용 업로드. S3 만 content_type 을 쓰고 나머지는 upload 와 같다.
    pub async fn upload_typed(&mut self, path: &str, reader: impl AsyncRead + Unpin + Send, counter: Arc<AtomicU64>, content_type: &str) -> AppResult<()> {
        match self {
            Self::S3(s) => s.upload_typed(path, reader, counter, content_type).await,
            _ => self.upload(path, reader, counter).await,
        }
    }

    /// S3 전용: 사전서명 GET URL
    pub async fn presign(&mut self, path: &str, expires_secs: u32) -> AppResult<String> {
        match self {
            Self::S3(s) => s.presign(path, expires_secs).await,
            _ => Err(AppError::user("S3 접속에서만 사용할 수 있습니다")),
        }
    }

    pub async fn download(&mut self, path: &str, writer: impl AsyncWrite + Unpin + Send, counter: Arc<AtomicU64>) -> AppResult<()> {
        match self {
            Self::Sftp(s) => s.download(path, writer, counter).await,
            Self::Ftp(s) => s.download(path, writer, counter).await,
            Self::S3(s) => s.download(path, writer, counter).await,
        }
    }
}

pub struct RemoteConn {
    pub cfg: ConnectionConfig,
    secret: Option<String>,
    data_dir: PathBuf,
    browse: Arc<Mutex<Option<Session>>>,
    /// FTP 탐색 세션 NOOP 태스크 (drop 시 중단)
    keepalive: Option<tokio::task::AbortHandle>,
}

impl RemoteConn {
    pub async fn open(cfg: ConnectionConfig, secret: Option<String>, data_dir: PathBuf) -> AppResult<Self> {
        let s = Session::open(&cfg, secret.as_deref(), &data_dir).await?;
        let browse = Arc::new(Mutex::new(Some(s)));
        let keepalive = (cfg.driver == Driver::Ftp).then(|| spawn_keepalive(browse.clone()));
        Ok(Self { cfg, secret, data_dir, browse, keepalive })
    }

    /// 전송 작업용 새 세션 (탐색 세션과 독립)
    pub async fn session(&self) -> AppResult<Session> {
        Session::open(&self.cfg, self.secret.as_deref(), &self.data_dir).await
    }

    pub fn check_write(&self) -> AppResult<()> {
        if self.cfg.read_only {
            Err(AppError::user("읽기 전용 접속입니다"))
        } else {
            Ok(())
        }
    }

    /// 탐색 세션으로 실행한다. 끊김 오류면 한 번 다시 접속해 재시도한다.
    /// f 가 만드는 future 는 세션만 빌린다: 인자는 클로저 안에서 clone 해 move 할 것.
    pub async fn run<T>(&self, f: impl for<'a> Fn(&'a mut Session) -> BoxFuture<'a, AppResult<T>>) -> AppResult<T> {
        let mut g = self.browse.lock().await;
        if g.is_none() {
            *g = Some(self.session().await?);
        }
        match f(g.as_mut().unwrap()).await {
            Err(AppError::Disconnected(_)) => {
                *g = None; // 재접속이 실패해도 죽은 세션을 남기지 않는다
                *g = Some(self.session().await?);
                f(g.as_mut().unwrap()).await
            }
            r => r,
        }
    }
}

impl Drop for RemoteConn {
    fn drop(&mut self) {
        if let Some(h) = &self.keepalive {
            h.abort();
        }
    }
}

const KEEPALIVE_EVERY: Duration = Duration::from_secs(60);

/// 60초마다 탐색 세션이 놀고 있으면(try_lock 성공) NOOP 을 보낸다. 실패하면 슬롯을 비워 run 이 재접속하게 한다.
fn spawn_keepalive(browse: Arc<Mutex<Option<Session>>>) -> tokio::task::AbortHandle {
    tokio::spawn(async move {
        loop {
            tokio::time::sleep(KEEPALIVE_EVERY).await;
            let Ok(mut g) = browse.try_lock() else { continue };
            let Some(s) = g.as_mut() else { continue };
            let ok = matches!(tokio::time::timeout(Duration::from_secs(10), s.noop()).await, Ok(Ok(())));
            if !ok {
                *g = None;
            }
        }
    })
    .abort_handle()
}

/// 다른 접속이지만 같은 FTP/SFTP 서버·계정이라 같은 경로가 같은 파일인지 (호스트 별칭은 구분하지 못한다).
/// S3 는 업로드가 완료 시점에 객체를 바꾸므로 읽던 원본이 깨지지 않아 보지 않는다.
pub fn same_file_space(a: &ConnectionConfig, b: &ConnectionConfig) -> bool {
    a.driver == b.driver && matches!(a.driver, Driver::Ftp | Driver::Sftp) && a.host.eq_ignore_ascii_case(&b.host) && a.port == b.port && a.user == b.user
}

/// 접속 테스트: 세션을 열고 루트 목록까지 읽어 본다.
pub async fn test(cfg: &ConnectionConfig, secret: Option<&str>, data_dir: &Path) -> AppResult<String> {
    let mut s = Session::open(cfg, secret, data_dir).await?;
    s.list("/").await?;
    Ok(match cfg.driver {
        Driver::Sftp => "SFTP 접속 성공".to_string(),
        Driver::Ftp if cfg.ftp_tls != FtpTls::None => "FTPS 접속 성공".to_string(),
        Driver::Ftp => "FTP 접속 성공".to_string(),
        Driver::S3 => "S3 접속 성공".to_string(),
        _ => "접속 성공".to_string(),
    })
}
