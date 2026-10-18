use std::path::PathBuf;

use serde::Serialize;
use tauri::{AppHandle, State};
use tauri_plugin_dialog::DialogExt;

use crate::db::edit::{self, BlobRequest, RawStmt, SubmitRequest};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[tauri::command]
pub async fn submit_changes(state: State<'_, AppState>, req: SubmitRequest) -> AppResult<()> {
    let (connected, mut lease) = state.lease(&req.conn_id, req.console_id.as_deref()).await?;
    if connected.cfg.read_only {
        return Err(AppError::user("읽기 전용 접속입니다"));
    }
    // Manual 트랜잭션 콘솔의 결과면 그 트랜잭션 안에서 SAVEPOINT로 반영한다(커밋은 사용자가).
    let in_tx = lease.in_tx();
    edit::submit(&mut lease.as_any()?, connected.cfg.driver, &req, in_tx).await
}

/// Submit 미리보기: 실제로 나갈 SQL을 값이 들어간 형태로 돌려준다.
#[tauri::command]
pub async fn preview_changes(state: State<'_, AppState>, req: SubmitRequest) -> AppResult<Vec<RawStmt>> {
    edit::preview(state.connected(&req.conn_id).await?.cfg.driver, &req)
}

/// 미리보기에서 고친 SQL을 반영한다 (트랜잭션·영향 행 검사는 submit_changes와 같다).
#[tauri::command]
pub async fn submit_sql(state: State<'_, AppState>, conn_id: String, console_id: Option<String>, statements: Vec<RawStmt>) -> AppResult<()> {
    let (connected, mut lease) = state.lease(&conn_id, console_id.as_deref()).await?;
    if connected.cfg.read_only {
        return Err(AppError::user("읽기 전용 접속입니다"));
    }
    if statements.is_empty() {
        return Err(AppError::user("실행할 문장이 없습니다"));
    }
    let in_tx = lease.in_tx();
    edit::submit_raw(&mut lease.as_any()?, &statements, in_tx).await
}

/// 파일 대화상자는 백엔드에서 연다. 웹뷰가 임의 경로를 넘겨 파일을 읽고 쓰지 못하게 하기 위해서다.
pub async fn pick_path(app: &AppHandle, save_as: Option<String>) -> AppResult<Option<PathBuf>> {
    let app = app.clone();
    let picked = tokio::task::spawn_blocking(move || {
        let d = app.dialog().file();
        match save_as {
            Some(name) => d.set_file_name(name).blocking_save_file(),
            None => d.blocking_pick_file(),
        }
    })
    .await
    .map_err(|e| AppError::user(e.to_string()))?;
    picked
        .map(|p| p.into_path().map_err(|e| AppError::user(e.to_string())))
        .transpose()
}

#[derive(Serialize)]
pub struct FileResult {
    pub path: String,
    pub bytes: u64,
}

/// 셀의 바이너리 값을 파일로 저장한다. 대화상자를 취소하면 None.
#[tauri::command]
pub async fn read_blob(app: AppHandle, state: State<'_, AppState>, req: BlobRequest, file_name: String) -> AppResult<Option<FileResult>> {
    let Some(path) = pick_path(&app, Some(file_name)).await? else { return Ok(None) };
    let (connected, mut lease) = state.lease(&req.conn_id, req.console_id.as_deref()).await?;
    let bytes = edit::read_blob(&mut lease.as_any()?, connected.cfg.driver, &req, &path).await?;
    Ok(Some(FileResult { path: path.to_string_lossy().into_owned(), bytes }))
}

/// 파일 내용을 셀에 바로 반영한다. 대화상자를 취소하면 None.
#[tauri::command]
pub async fn write_blob(app: AppHandle, state: State<'_, AppState>, req: BlobRequest) -> AppResult<Option<FileResult>> {
    if state.connected(&req.conn_id).await?.cfg.read_only {
        return Err(AppError::user("읽기 전용 접속입니다"));
    }
    let Some(path) = pick_path(&app, None).await? else { return Ok(None) };
    let (connected, mut lease) = state.lease(&req.conn_id, req.console_id.as_deref()).await?;
    let in_tx = lease.in_tx();
    let bytes = edit::write_blob(&mut lease.as_any()?, connected.cfg.driver, &req, &path, in_tx).await?;
    Ok(Some(FileResult { path: path.to_string_lossy().into_owned(), bytes }))
}
