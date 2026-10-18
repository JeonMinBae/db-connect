use serde::Serialize;
use tauri::{AppHandle, Emitter, State};

use crate::commands::edit::pick_path;
use crate::db::export::{self, ExportRequest};
use crate::error::AppResult;
use crate::state::AppState;

#[derive(Serialize, Clone)]
struct Progress<'a> {
    exec_id: &'a str,
    rows: u64,
}

#[derive(Serialize)]
pub struct ExportResult {
    pub path: String,
    pub rows: u64,
}

/// 저장 대화상자를 연 뒤 쿼리 전체 결과를 CSV로 쓴다. 대화상자를 취소하면 None.
#[tauri::command]
pub async fn export_csv(app: AppHandle, state: State<'_, AppState>, req: ExportRequest) -> AppResult<Option<ExportResult>> {
    let Some(path) = pick_path(&app, Some(req.file_name.clone())).await? else { return Ok(None) };
    let (connected, mut lease) = state.lease(&req.conn_id, req.console_id.as_deref()).await?;
    let exec_id = req.exec_id.clone();
    let progress = |rows: u64| {
        let _ = app.emit("export-progress", Progress { exec_id: &exec_id, rows });
    };
    let h = lease.cancel_handle(&connected.opts).await?;
    let _reg = state.cancels.register(&req.exec_id, h);
    let rows = export::csv(&mut lease.as_any()?, &req.sql, &path, req.bom, progress).await?;
    Ok(Some(ExportResult { path: path.to_string_lossy().into_owned(), rows }))
}
