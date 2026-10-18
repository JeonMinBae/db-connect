use std::path::{Path, PathBuf};

use serde::{Deserialize, Serialize};

use crate::error::{AppError, AppResult};
use crate::store::files::write_atomic;

#[derive(Serialize, Deserialize, Clone, Copy, Debug, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Driver {
    Postgres,
    Mysql,
    Sqlite,
    Redis,
    Mongodb,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum SslMode {
    Disable,
    #[default]
    Prefer,
    Require,
    VerifyCa,
    VerifyFull,
}

#[derive(Serialize, Deserialize, Clone, Debug)]
#[serde(default)]
pub struct ConnectionConfig {
    pub id: String,
    pub name: String,
    pub driver: Driver,
    pub host: String,
    pub port: u16,
    pub database: String,
    pub user: String,
    pub ssl_mode: SslMode,
    pub ssl_root_cert: Option<String>,
    pub sqlite_path: String,
    pub read_only: bool,
    pub color: Option<String>,
    /// Redis: 기본 DB 번호 (콘솔의 시작 DB)
    pub redis_db: u8,
    /// Redis: 키 트리의 폴더 구분자
    pub key_separator: String,
    /// MongoDB: 연결 문자열 (비밀번호는 키체인에 따로 둔다)
    pub mongo_uri: String,
}

impl Default for ConnectionConfig {
    fn default() -> Self {
        Self {
            id: String::new(),
            name: String::new(),
            driver: Driver::Postgres,
            host: "localhost".into(),
            port: 5432,
            database: String::new(),
            user: String::new(),
            ssl_mode: SslMode::default(),
            ssl_root_cert: None,
            sqlite_path: String::new(),
            read_only: false,
            color: None,
            redis_db: 0,
            key_separator: ":".into(),
            mongo_uri: String::new(),
        }
    }
}

fn file(dir: &Path) -> PathBuf {
    dir.join("connections.json")
}

pub fn load(dir: &Path) -> AppResult<Vec<ConnectionConfig>> {
    match std::fs::read(file(dir)) {
        Ok(bytes) => Ok(serde_json::from_slice(&bytes)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(vec![]),
        Err(e) => Err(e.into()),
    }
}

fn save(dir: &Path, list: &[ConnectionConfig]) -> AppResult<()> {
    write_atomic(&file(dir), &serde_json::to_vec_pretty(list)?)
}

pub fn get(dir: &Path, id: &str) -> AppResult<ConnectionConfig> {
    load(dir)?
        .into_iter()
        .find(|c| c.id == id)
        .ok_or_else(|| AppError::user(format!("접속 설정을 찾을 수 없습니다: {id}")))
}

pub fn upsert(dir: &Path, cfg: ConnectionConfig) -> AppResult<()> {
    let mut list = load(dir)?;
    match list.iter_mut().find(|c| c.id == cfg.id) {
        Some(slot) => *slot = cfg,
        None => list.push(cfg),
    }
    save(dir, &list)
}

pub fn remove(dir: &Path, id: &str) -> AppResult<()> {
    let mut list = load(dir)?;
    list.retain(|c| c.id != id);
    save(dir, &list)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(id: &str, name: &str) -> ConnectionConfig {
        ConnectionConfig { id: id.into(), name: name.into(), ..Default::default() }
    }

    #[test]
    fn upsert_and_remove() {
        let dir = tempfile::tempdir().unwrap();
        assert!(load(dir.path()).unwrap().is_empty());
        upsert(dir.path(), cfg("a", "one")).unwrap();
        upsert(dir.path(), cfg("b", "two")).unwrap();
        upsert(dir.path(), cfg("a", "uno")).unwrap();
        let list = load(dir.path()).unwrap();
        assert_eq!(list.len(), 2);
        assert_eq!(get(dir.path(), "a").unwrap().name, "uno");
        remove(dir.path(), "a").unwrap();
        assert_eq!(load(dir.path()).unwrap().len(), 1);
        assert!(get(dir.path(), "a").is_err());
    }

    #[test]
    fn no_password_field() {
        let dir = tempfile::tempdir().unwrap();
        upsert(dir.path(), cfg("a", "one")).unwrap();
        let text = std::fs::read_to_string(dir.path().join("connections.json")).unwrap();
        assert!(!text.contains("password"));
    }
}
