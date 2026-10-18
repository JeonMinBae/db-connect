use std::path::{Path, PathBuf};

use crate::error::{AppError, AppResult};

/// tmp 파일에 쓴 뒤 rename 해서 쓰는 도중 종료돼도 파일이 깨지지 않게 한다.
pub fn write_atomic(path: &Path, bytes: &[u8]) -> AppResult<()> {
    if let Some(parent) = path.parent() {
        std::fs::create_dir_all(parent)?;
    }
    let tmp = path.with_extension("tmp");
    std::fs::write(&tmp, bytes)?;
    std::fs::rename(&tmp, path)?;
    Ok(())
}

/// 경로 조각으로 쓰는 id는 영숫자, '-', '_'만 허용한다.
pub fn safe_id(id: &str) -> AppResult<&str> {
    if !id.is_empty() && id.chars().all(|c| c.is_ascii_alphanumeric() || c == '-' || c == '_') {
        Ok(id)
    } else {
        Err(AppError::user(format!("잘못된 id: {id}")))
    }
}

pub fn console_path(dir: &Path, conn_id: &str, console_id: &str) -> AppResult<PathBuf> {
    Ok(dir.join("consoles").join(safe_id(conn_id)?).join(format!("{}.sql", safe_id(console_id)?)))
}

pub fn workspace_path(dir: &Path) -> PathBuf {
    dir.join("workspace.json")
}

pub fn read_optional(path: &Path) -> AppResult<Option<String>> {
    match std::fs::read_to_string(path) {
        Ok(s) => Ok(Some(s)),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.into()),
    }
}
