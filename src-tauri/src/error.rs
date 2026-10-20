use serde::ser::SerializeStruct;

#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")]
    Db(#[from] sqlx::Error),
    #[error("{0}")]
    Io(#[from] std::io::Error),
    #[error("{0}")]
    Keyring(#[from] keyring::Error),
    #[error("{0}")]
    Json(#[from] serde_json::Error),
    #[error("{0}")]
    Redis(#[from] redis::RedisError),
    #[error("{0}")]
    Mongo(#[from] mongodb::error::Error),
    #[error("{0}")]
    User(String),
    /// Submit 중 영향 행 수가 1이 아닌 문장이 있어 전체 롤백됨
    #[error("{message}")]
    Submit { message: String, change_index: usize, affected: u64 },
    /// 원격 파일 서버 오류
    #[error("{0}")]
    Remote(String),
    /// 원격 세션이 끊김 (RemoteConn::run 이 한 번 재접속해 재시도한다)
    #[error("{0}")]
    Disconnected(String),
    /// 호스트 키를 처음 보거나 저장된 값과 다름 (사용자가 신뢰하면 재시도)
    #[error("{}", if *changed { "호스트 키가 이전과 다릅니다" } else { "처음 접속하는 호스트입니다" })]
    HostKey { host: String, port: u16, fingerprint: String, changed: bool },
}

impl AppError {
    pub fn user(msg: impl Into<String>) -> Self {
        Self::User(msg.into())
    }
}

impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        let kind = match self {
            Self::Db(_) => "db",
            Self::Io(_) => "io",
            Self::Keyring(_) => "keyring",
            Self::Json(_) => "json",
            Self::Redis(_) => "redis",
            Self::Mongo(_) => "mongo",
            Self::User(_) => "user",
            Self::Submit { .. } => "submit",
            Self::Remote(_) | Self::Disconnected(_) => "remote",
            Self::HostKey { .. } => "hostkey",
        };
        let mut st = s.serialize_struct("AppError", 6)?;
        st.serialize_field("kind", kind)?;
        st.serialize_field("message", &self.to_string())?;
        if let Self::Submit { change_index, affected, .. } = self {
            st.serialize_field("change_index", change_index)?;
            st.serialize_field("affected", affected)?;
        }
        if let Self::HostKey { host, port, fingerprint, changed } = self {
            st.serialize_field("host", host)?;
            st.serialize_field("port", port)?;
            st.serialize_field("fingerprint", fingerprint)?;
            st.serialize_field("changed", changed)?;
        }
        st.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
