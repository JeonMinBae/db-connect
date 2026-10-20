use std::path::Path;

use super::{config, secrets};

/// db-connect 시절 identifier. app_data_dir 의 형제 폴더로 남아 있다
const LEGACY_DIR: &str = "com.dbconnect.app";

/// db-connect 에서 data-connector 로 이름을 바꾸며 남은 데이터(폴더, 비밀번호)를 한 번 옮긴다.
/// 새 폴더가 이미 있으면 아무것도 하지 않는다. 비밀번호를 먼저 옮기고 폴더를 마지막에 옮겨야
/// 중간에 실패해도 다음 실행에서 다시 시도된다
pub fn legacy_data(dir: &Path) {
    let Some(old) = dir.parent().map(|p| p.join(LEGACY_DIR)) else { return };
    if dir.exists() || !old.is_dir() {
        return;
    }
    for c in config::load(&old).unwrap_or_default() {
        if let Err(e) = secrets::migrate_legacy(&c.id) {
            eprintln!("비밀번호 이전 실패 ({}): {e}", c.id);
            return;
        }
    }
    if let Err(e) = std::fs::rename(&old, dir) {
        eprintln!("데이터 폴더 이전 실패: {e}");
    }
}
