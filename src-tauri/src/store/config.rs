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
    Ftp,
    Sftp,
    S3,
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

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum FtpTls {
    #[default]
    None,
    Explicit,
    Implicit,
}

#[derive(Serialize, Deserialize, Clone, Copy, Debug, Default, PartialEq, Eq)]
#[serde(rename_all = "kebab-case")]
pub enum FsEncoding {
    #[default]
    Utf8,
    EucKr,
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
    /// FTP: 암호화 방식
    pub ftp_tls: FtpTls,
    /// FTPS: 자체서명 등 검증 실패 인증서 허용
    pub tls_insecure: bool,
    /// FTP: 서버 파일명 인코딩
    pub fs_encoding: FsEncoding,
    /// SFTP: 개인키 파일 (None 이면 비밀번호 인증, 키체인 값은 passphrase 로 쓴다)
    pub ssh_key_path: Option<String>,
    /// S3: endpoint URL (AWS 는 비워 두면 region 으로 만든다)
    pub s3_endpoint: String,
    pub s3_region: String,
    /// S3: 비우면 루트에 버킷 목록
    pub s3_bucket: String,
    /// S3: 시작 접두어 (앞뒤 '/' 없이 저장)
    pub s3_prefix: String,
    pub s3_path_style: bool,
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
            ftp_tls: FtpTls::default(),
            tls_insecure: false,
            fs_encoding: FsEncoding::default(),
            ssh_key_path: None,
            s3_endpoint: String::new(),
            s3_region: String::new(),
            s3_bucket: String::new(),
            s3_prefix: String::new(),
            s3_path_style: false,
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

/// ids 순서대로 정렬한다. ids에 없는 접속은 기존 순서를 지켜 뒤에 둔다 (sort_by_key는 안정 정렬)
pub fn reorder(dir: &Path, ids: &[String]) -> AppResult<()> {
    let mut list = load(dir)?;
    list.sort_by_key(|c| ids.iter().position(|id| *id == c.id).unwrap_or(usize::MAX));
    save(dir, &list)
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg(id: &str, name: &str) -> ConnectionConfig {
        ConnectionConfig { id: id.into(), name: name.into(), ..Default::default() }
    }

    #[test]
    fn old_json_reads_with_defaults() {
        let json = r#"[{"id":"a","name":"pg","driver":"postgres","host":"h","port":5432}]"#;
        let list: Vec<ConnectionConfig> = serde_json::from_str(json).unwrap();
        assert_eq!(list[0].ftp_tls, FtpTls::None);
        assert_eq!(list[0].fs_encoding, FsEncoding::Utf8);
        assert!(list[0].ssh_key_path.is_none());
    }

    #[test]
    fn remote_drivers_roundtrip() {
        for (d, s) in [(Driver::Ftp, "\"ftp\""), (Driver::Sftp, "\"sftp\""), (Driver::S3, "\"s3\"")] {
            assert_eq!(serde_json::to_string(&d).unwrap(), s);
            assert_eq!(serde_json::from_str::<Driver>(s).unwrap(), d);
        }
        assert_eq!(serde_json::to_string(&FsEncoding::EucKr).unwrap(), "\"euc-kr\"");
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
    fn reorder_keeps_unknown_at_end() {
        let dir = tempfile::tempdir().unwrap();
        for id in ["a", "b", "c", "d"] {
            upsert(dir.path(), cfg(id, id)).unwrap();
        }
        reorder(dir.path(), &["c".into(), "a".into(), "x".into()]).unwrap();
        let ids: Vec<_> = load(dir.path()).unwrap().into_iter().map(|c| c.id).collect();
        assert_eq!(ids, ["c", "a", "b", "d"]);
    }

    #[test]
    fn no_password_field() {
        let dir = tempfile::tempdir().unwrap();
        upsert(dir.path(), cfg("a", "one")).unwrap();
        let text = std::fs::read_to_string(dir.path().join("connections.json")).unwrap();
        assert!(!text.contains("password"));
    }
}
