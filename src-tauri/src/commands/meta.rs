use tauri::State;

use crate::db::meta::{self, ColumnMeta, IndexInfo, SnapshotTable, TableInfo};
use crate::error::AppResult;
use crate::state::AppState;

#[tauri::command]
pub async fn list_schemas(state: State<'_, AppState>, conn_id: String) -> AppResult<Vec<String>> {
    meta::schemas(&state.connected(&conn_id).await?.pool).await
}

#[tauri::command]
pub async fn list_tables(state: State<'_, AppState>, conn_id: String, schema: String) -> AppResult<Vec<TableInfo>> {
    meta::tables(&state.connected(&conn_id).await?.pool, &schema).await
}

#[tauri::command]
pub async fn list_columns(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
    table: String,
) -> AppResult<Vec<ColumnMeta>> {
    meta::columns(&state.connected(&conn_id).await?.pool, &schema, &table).await
}

#[tauri::command]
pub async fn list_indexes(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
    table: String,
) -> AppResult<Vec<IndexInfo>> {
    meta::indexes(&state.connected(&conn_id).await?.pool, &schema, &table).await
}

#[tauri::command]
pub async fn schema_snapshot(state: State<'_, AppState>, conn_id: String) -> AppResult<Vec<SnapshotTable>> {
    meta::snapshot(&state.connected(&conn_id).await?.pool).await
}
