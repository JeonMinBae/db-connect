//! 원격 파일 접속 공통 계층. 프로토콜별 세션은 `Session` enum 으로 디스패치한다.
pub mod io;
pub mod known_hosts;
pub mod ops;
pub mod path;
pub mod picks;
pub mod sftp;
pub mod text;
pub mod transfer;
#[cfg(test)]
#[path = "it.rs"]
mod remote_it;

use std::path::{Path, PathBuf};
use std::sync::atomic::AtomicU64;
use std::sync::Arc;

use futures_util::future::BoxFuture;
use serde::{Deserialize, Serialize};
use tokio::io::{AsyncRead, AsyncWrite};
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::store::config::{ConnectionConfig, Driver};

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
}

impl Session {
    pub async fn open(cfg: &ConnectionConfig, secret: Option<&str>, data_dir: &Path) -> AppResult<Self> {
        match cfg.driver {
            Driver::Sftp => Ok(Self::Sftp(sftp::SftpSession::open(cfg, secret, data_dir).await?)),
            Driver::Ftp | Driver::S3 => Err(AppError::user("파일 접속은 아직 지원하지 않습니다")),
            _ => Err(AppError::user("파일 접속이 아닙니다")),
        }
    }

    pub async fn list(&mut self, path: &str) -> AppResult<Vec<Entry>> {
        match self {
            Self::Sftp(s) => s.list(path).await,
        }
    }

    pub async fn stat(&mut self, path: &str) -> AppResult<Option<(Entry, Stamp)>> {
        match self {
            Self::Sftp(s) => s.stat(path).await,
        }
    }

    pub async fn mkdir(&mut self, path: &str) -> AppResult<()> {
        match self {
            Self::Sftp(s) => s.mkdir(path).await,
        }
    }

    pub async fn rename(&mut self, from: &str, to: &str) -> AppResult<()> {
        match self {
            Self::Sftp(s) => s.rename(from, to).await,
        }
    }

    pub async fn remove_file(&mut self, path: &str) -> AppResult<()> {
        match self {
            Self::Sftp(s) => s.remove_file(path).await,
        }
    }

    pub async fn remove_dir(&mut self, path: &str) -> AppResult<()> {
        match self {
            Self::Sftp(s) => s.remove_dir(path).await,
        }
    }

    pub async fn is_link(&mut self, path: &str) -> AppResult<bool> {
        match self {
            Self::Sftp(s) => s.is_link(path).await,
        }
    }

    /// 메모리로 읽는다. limit 보다 크면 사용자 오류.
    pub async fn read_all(&mut self, path: &str, limit: u64) -> AppResult<Vec<u8>> {
        match self {
            Self::Sftp(s) => s.read_all(path, limit).await,
        }
    }

    /// 파일을 만들거나 비우고 bytes 로 채운다.
    pub async fn write_all(&mut self, path: &str, bytes: &[u8]) -> AppResult<()> {
        match self {
            Self::Sftp(s) => s.write_all(path, bytes).await,
        }
    }

    pub async fn upload(&mut self, path: &str, reader: impl AsyncRead + Unpin + Send, len: u64, counter: Arc<AtomicU64>) -> AppResult<()> {
        match self {
            Self::Sftp(s) => s.upload(path, reader, len, counter).await,
        }
    }

    pub async fn download(&mut self, path: &str, writer: impl AsyncWrite + Unpin + Send, counter: Arc<AtomicU64>) -> AppResult<()> {
        match self {
            Self::Sftp(s) => s.download(path, writer, counter).await,
        }
    }
}

pub struct RemoteConn {
    pub cfg: ConnectionConfig,
    secret: Option<String>,
    data_dir: PathBuf,
    browse: Mutex<Option<Session>>,
}

impl RemoteConn {
    pub async fn open(cfg: ConnectionConfig, secret: Option<String>, data_dir: PathBuf) -> AppResult<Self> {
        let s = Session::open(&cfg, secret.as_deref(), &data_dir).await?;
        Ok(Self { cfg, secret, data_dir, browse: Mutex::new(Some(s)) })
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

/// 접속 테스트: 세션을 열고 루트 목록까지 읽어 본다.
pub async fn test(cfg: &ConnectionConfig, secret: Option<&str>, data_dir: &Path) -> AppResult<String> {
    let mut s = Session::open(cfg, secret, data_dir).await?;
    s.list("/").await?;
    Ok(match cfg.driver {
        Driver::Sftp => "SFTP 접속 성공".to_string(),
        _ => "접속 성공".to_string(),
    })
}
