use tauri::{AppHandle, State};

use crate::commands::edit::pick_path;
use crate::error::AppResult;
use crate::remote::known_hosts;
use crate::state::AppState;

/// 사용자가 확인한 호스트 키를 저장한다 (이후 접속은 이 지문과 비교)
#[tauri::command]
pub fn remote_trust_host(state: State<'_, AppState>, host: String, port: u16, fingerprint: String) -> AppResult<()> {
    known_hosts::trust(&state.data_dir, &host, port, &fingerprint)
}

/// 개인키 파일을 백엔드 대화상자로 고른다. 취소하면 None.
#[tauri::command]
pub async fn pick_key_file(app: AppHandle) -> AppResult<Option<String>> {
    Ok(pick_path(&app, None).await?.map(|p| p.to_string_lossy().into_owned()))
}
