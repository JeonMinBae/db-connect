use tauri::State;

use crate::db::ddl::{self, DdlPlan};
use crate::db::pool::DbPool;
use crate::db::structure::{self, TableStructure};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[tauri::command]
pub async fn table_structure(state: State<'_, AppState>, conn_id: String, schema: String, table: String) -> AppResult<TableStructure> {
    structure::load(&state.connected(&conn_id).await?.pool, &schema, &table).await
}

/// 구조 탭의 초안 → 실행할 DDL. 그사이 다른 곳에서 구조가 바뀌었으면 거부한다.
#[tauri::command]
pub async fn preview_ddl(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
    table: String,
    original: TableStructure,
    draft: TableStructure,
) -> AppResult<DdlPlan> {
    let connected = state.connected(&conn_id).await?;
    let current = structure::load(&connected.pool, &schema, &table).await?;
    if current.columns.is_empty() {
        return Err(AppError::user(format!("테이블 {table}을(를) 찾을 수 없습니다")));
    }
    if current != original {
        return Err(AppError::user("다른 곳에서 테이블 구조가 바뀌었습니다. 구조를 다시 읽어 주세요."));
    }
    let aux = match &connected.pool {
        DbPool::Lite(p) => Some(structure::load_sqlite_aux(&mut *p.acquire().await?, &table).await?),
        _ => None,
    };
    ddl::plan_alter(connected.cfg.driver, Some(&schema), &table, &current, &draft, aux.as_ref())
}

/// 미리보기의 문장들(사용자가 고쳤을 수 있음)을 실행한다.
/// 콘솔의 Manual 트랜잭션과 섞이지 않도록 항상 풀의 자동 커밋 연결을 쓴다.
#[tauri::command]
pub async fn apply_ddl(state: State<'_, AppState>, conn_id: String, statements: Vec<String>) -> AppResult<()> {
    let connected = state.connected(&conn_id).await?;
    if connected.cfg.read_only {
        return Err(AppError::user("읽기 전용 접속입니다"));
    }
    let mut conn = connected.pool.acquire().await?;
    ddl::apply(&mut conn.as_any(), &statements).await
}
