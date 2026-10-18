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
        };
        let mut st = s.serialize_struct("AppError", 4)?;
        st.serialize_field("kind", kind)?;
        st.serialize_field("message", &self.to_string())?;
        if let Self::Submit { change_index, affected, .. } = self {
            st.serialize_field("change_index", change_index)?;
            st.serialize_field("affected", affected)?;
        }
        st.end()
    }
}

pub type AppResult<T> = Result<T, AppError>;
