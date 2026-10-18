use tauri::State;

use crate::error::AppResult;
use crate::state::AppState;
use crate::store::files::{console_path, read_optional, workspace_path, write_atomic};

#[tauri::command]
pub fn load_console(state: State<'_, AppState>, conn_id: String, console_id: String) -> AppResult<Option<String>> {
    read_optional(&console_path(&state.data_dir, &conn_id, &console_id)?)
}

#[tauri::command]
pub fn save_console(state: State<'_, AppState>, conn_id: String, console_id: String, text: String) -> AppResult<()> {
    write_atomic(&console_path(&state.data_dir, &conn_id, &console_id)?, text.as_bytes())
}

#[tauri::command]
pub fn delete_console(state: State<'_, AppState>, conn_id: String, console_id: String) -> AppResult<()> {
    match std::fs::remove_file(console_path(&state.data_dir, &conn_id, &console_id)?) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => Err(e.into()),
        _ => Ok(()),
    }
}

#[tauri::command]
pub fn load_workspace(state: State<'_, AppState>) -> AppResult<Option<serde_json::Value>> {
    match read_optional(&workspace_path(&state.data_dir))? {
        Some(s) => Ok(serde_json::from_str(&s).ok()),
        None => Ok(None),
    }
}

#[tauri::command]
pub fn save_workspace(state: State<'_, AppState>, workspace: serde_json::Value) -> AppResult<()> {
    write_atomic(&workspace_path(&state.data_dir), &serde_json::to_vec(&workspace)?)
}
