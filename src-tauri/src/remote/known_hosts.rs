//! 앱 전용 known_hosts. `{data_dir}/known_hosts.json` 에 `"host:port" → "SHA256:<base64>"` 로 저장한다.
use std::collections::BTreeMap;
use std::path::Path;

use crate::error::AppResult;
use crate::store::files::write_atomic;

#[derive(Debug, PartialEq)]
pub enum Verdict {
    Trusted,
    Unknown,
    Changed,
}

fn key(host: &str, port: u16) -> String {
    format!("{}:{port}", host.to_ascii_lowercase())
}

fn load(dir: &Path) -> AppResult<BTreeMap<String, String>> {
    match std::fs::read(dir.join("known_hosts.json")) {
        Ok(b) => Ok(serde_json::from_slice(&b)?),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(BTreeMap::new()),
        Err(e) => Err(e.into()),
    }
}

pub fn check(dir: &Path, host: &str, port: u16, fingerprint: &str) -> AppResult<Verdict> {
    let map = load(dir)?;
    Ok(match map.get(&key(host, port)) {
        None => Verdict::Unknown,
        Some(f) if f == fingerprint => Verdict::Trusted,
        Some(_) => Verdict::Changed,
    })
}

pub fn trust(dir: &Path, host: &str, port: u16, fingerprint: &str) -> AppResult<()> {
    let mut map = load(dir)?;
    map.insert(key(host, port), fingerprint.to_string());
    write_atomic(&dir.join("known_hosts.json"), &serde_json::to_vec_pretty(&map)?)
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn tofu_flow() {
        let d = tempfile::tempdir().unwrap();
        assert_eq!(check(d.path(), "h", 22, "SHA256:a").unwrap(), Verdict::Unknown);
        trust(d.path(), "h", 22, "SHA256:a").unwrap();
        assert_eq!(check(d.path(), "h", 22, "SHA256:a").unwrap(), Verdict::Trusted);
        assert_eq!(check(d.path(), "H", 22, "SHA256:a").unwrap(), Verdict::Trusted);
        assert_eq!(check(d.path(), "h", 22, "SHA256:b").unwrap(), Verdict::Changed);
        assert_eq!(check(d.path(), "h", 2222, "SHA256:a").unwrap(), Verdict::Unknown);
    }
}
