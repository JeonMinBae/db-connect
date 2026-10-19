use std::path::{Path, PathBuf};
use std::sync::{Arc, Mutex};
use std::time::Duration;

use russh::client;
use russh::keys::{self, HashAlg, PrivateKeyWithHashAlg, PublicKeyOrCertificate};
use russh_sftp::client::error::Error as SftpError;
use russh_sftp::protocol::StatusCode;

use super::known_hosts::{self, Verdict};
use super::{path, Entry, Stamp};
use crate::error::{AppError, AppResult};
use crate::store::config::ConnectionConfig;

const CONNECT_TIMEOUT: Duration = Duration::from_secs(10);

struct Handler {
    host: String,
    port: u16,
    data_dir: PathBuf,
    rejected: Arc<Mutex<Option<AppError>>>,
}

impl client::Handler for Handler {
    type Error = russh::Error;

    async fn check_server_key(&mut self, key: &PublicKeyOrCertificate) -> Result<bool, Self::Error> {
        let fp = key.public_key().fingerprint(HashAlg::Sha256).to_string(); // "SHA256:..."
        let (host, port) = (self.host.clone(), self.port);
        let err = match known_hosts::check(&self.data_dir, &host, port, &fp) {
            Ok(Verdict::Trusted) => return Ok(true),
            Ok(Verdict::Unknown) => AppError::HostKey { host, port, fingerprint: fp, changed: false },
            Ok(Verdict::Changed) => AppError::HostKey { host, port, fingerprint: fp, changed: true },
            Err(e) => e,
        };
        // russh 는 false 만 돌려받으므로 이유는 따로 꺼내 open() 에서 돌려준다
        *self.rejected.lock().unwrap() = Some(err);
        Ok(false)
    }
}

pub struct SftpSession {
    sftp: russh_sftp::client::SftpSession,
    /// 드롭되면 연결이 닫히므로 세션과 같이 들고 있는다
    _handle: client::Handle<Handler>,
}

fn ssh_err(e: russh::Error) -> AppError {
    use russh::Error as E;
    match e {
        E::Disconnect | E::HUP | E::SendError | E::RecvError | E::IO(_) | E::ConnectionTimeout | E::KeepaliveTimeout | E::InactivityTimeout => {
            AppError::Disconnected(e.to_string())
        }
        e => AppError::Remote(e.to_string()),
    }
}

fn sftp_err(e: SftpError) -> AppError {
    match e {
        SftpError::Status(s) => AppError::Remote(s.error_message),
        SftpError::IO(m) => AppError::Disconnected(m),
        SftpError::Timeout => AppError::Disconnected("응답 시간이 초과되었습니다".into()),
        e => AppError::Remote(e.to_string()),
    }
}

/// "localhost" 는 ::1 부터 시도돼 Docker 등에서 지연되므로 IPv4 로 접속한다 (db/pool.rs 와 같은 이유).
/// 호스트 키 기록에는 사용자가 입력한 host 를 그대로 쓴다.
fn connect_host(host: &str) -> &str {
    if host.eq_ignore_ascii_case("localhost") {
        "127.0.0.1"
    } else {
        host
    }
}

impl SftpSession {
    pub async fn open(cfg: &ConnectionConfig, secret: Option<&str>, data_dir: &Path) -> AppResult<Self> {
        let rejected = Arc::new(Mutex::new(None));
        let r = tokio::time::timeout(CONNECT_TIMEOUT, Self::connect(cfg, secret, data_dir, rejected.clone()))
            .await
            .unwrap_or_else(|_| Err(AppError::Remote("접속 시간이 초과되었습니다".into())));
        match r {
            // 호스트 키 거부는 russh 에서 일반 오류로 올라오므로 핸들러가 남긴 사유를 우선한다
            Err(e) => Err(rejected.lock().unwrap().take().unwrap_or(e)),
            ok => ok,
        }
    }

    async fn connect(cfg: &ConnectionConfig, secret: Option<&str>, data_dir: &Path, rejected: Arc<Mutex<Option<AppError>>>) -> AppResult<Self> {
        let handler = Handler { host: cfg.host.clone(), port: cfg.port, data_dir: data_dir.to_path_buf(), rejected };
        let mut handle = client::connect(Arc::new(client::Config::default()), (connect_host(&cfg.host), cfg.port), handler)
            .await
            .map_err(ssh_err)?;

        let secret = secret.filter(|s| !s.is_empty());
        let auth = match cfg.ssh_key_path.as_deref().filter(|p| !p.is_empty()) {
            Some(key_path) => {
                let key = keys::load_secret_key(key_path, secret)
                    .map_err(|e| AppError::user(format!("개인키를 읽을 수 없습니다 (경로·passphrase 확인): {e}")))?;
                let hash = handle.best_supported_rsa_hash().await.map_err(ssh_err)?.flatten();
                handle.authenticate_publickey(&cfg.user, PrivateKeyWithHashAlg::new(Arc::new(key), hash)).await
            }
            None => handle.authenticate_password(&cfg.user, secret.unwrap_or("")).await,
        }
        .map_err(ssh_err)?;
        if !auth.success() {
            return Err(AppError::user("인증에 실패했습니다. 사용자·비밀번호(또는 키)를 확인하세요."));
        }

        let channel = handle.channel_open_session().await.map_err(ssh_err)?;
        channel.request_subsystem(true, "sftp").await.map_err(ssh_err)?;
        let sftp = russh_sftp::client::SftpSession::new(channel.into_stream()).await.map_err(sftp_err)?;
        Ok(Self { sftp, _handle: handle })
    }

    pub async fn list(&mut self, dir: &str) -> AppResult<Vec<Entry>> {
        let dir = path::normalize(dir);
        let rd = self.sftp.read_dir(dir.clone()).await.map_err(sftp_err)?;
        let mut out = Vec::new();
        for e in rd {
            let name = e.file_name();
            if name == "." || name == ".." {
                continue;
            }
            let mut m = e.metadata();
            // 심볼릭 링크는 가리키는 대상 기준으로 폴더 여부를 정한다 (깨진 링크는 그대로 둔다)
            if m.is_symlink() {
                if let Ok(t) = self.sftp.metadata(path::join(&dir, &name)).await {
                    m = t;
                }
            }
            out.push(entry_of(name, &m));
        }
        Ok(out)
    }

    pub async fn stat(&mut self, p: &str) -> AppResult<Option<(Entry, Stamp)>> {
        let p = path::normalize(p);
        match self.sftp.metadata(p.clone()).await {
            Ok(m) => {
                let e = entry_of(path::name(&p).to_string(), &m);
                let stamp = Stamp { size: e.size, mtime: e.mtime, etag: None };
                Ok(Some((e, stamp)))
            }
            Err(SftpError::Status(s)) if s.status_code == StatusCode::NoSuchFile => Ok(None),
            Err(e) => Err(sftp_err(e)),
        }
    }

    pub async fn mkdir(&mut self, p: &str) -> AppResult<()> {
        self.sftp.create_dir(path::normalize(p)).await.map_err(sftp_err)
    }

    pub async fn rename(&mut self, from: &str, to: &str) -> AppResult<()> {
        self.sftp.rename(path::normalize(from), path::normalize(to)).await.map_err(sftp_err)
    }

    pub async fn remove_file(&mut self, p: &str) -> AppResult<()> {
        self.sftp.remove_file(path::normalize(p)).await.map_err(sftp_err)
    }

    pub async fn remove_dir(&mut self, p: &str) -> AppResult<()> {
        self.sftp.remove_dir(path::normalize(p)).await.map_err(sftp_err)
    }

    /// stat 은 링크를 따라가므로, 재귀 삭제가 링크 대상 안으로 들어가지 않게 따로 확인한다
    pub async fn is_link(&mut self, p: &str) -> AppResult<bool> {
        Ok(self.sftp.symlink_metadata(path::normalize(p)).await.map_err(sftp_err)?.is_symlink())
    }
}

fn entry_of(name: String, m: &russh_sftp::protocol::FileAttributes) -> Entry {
    Entry {
        name,
        dir: m.is_dir(),
        size: m.size.unwrap_or(0),
        mtime: m.mtime.map(|t| i64::from(t) * 1000),
        perm: m.permissions.map(|p| p & 0o7777),
    }
}
