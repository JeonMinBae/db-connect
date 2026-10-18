use tauri::State;

use crate::db::ddl::{self, DdlPlan, DdlStmt};
use crate::db::pool::DbPool;
use crate::db::structure::{self, TableStructure};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[tauri::command]
pub async fn table_structure(state: State<'_, AppState>, conn_id: String, schema: String, table: String) -> AppResult<TableStructure> {
    structure::load(&state.connected(&conn_id).await?.pool, &schema, &table).await
}

/// 구조 탭의 초안 → 실행할 DDL.
/// - original이 없으면 새 테이블(table이 새 이름)
/// - 있으면 그사이 다른 곳에서 구조가 바뀌었는지 확인하고, new_name이 다르면 마지막에 이름을 바꾼다
#[tauri::command]
pub async fn preview_ddl(
    state: State<'_, AppState>,
    conn_id: String,
    schema: String,
    table: String,
    original: Option<TableStructure>,
    draft: TableStructure,
    new_name: Option<String>,
) -> AppResult<DdlPlan> {
    let connected = state.connected(&conn_id).await?;
    let d = connected.cfg.driver;
    let Some(original) = original else {
        return ddl::plan_create(d, Some(&schema), &table, &draft);
    };
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
    let mut plan = ddl::plan_alter(d, Some(&schema), &table, &current, &draft, aux.as_ref())?;
    if let Some(n) = new_name.filter(|n| n != &table) {
        plan.statements.push(ddl::plan_rename(d, Some(&schema), &table, &n)?);
    }
    Ok(plan)
}

#[tauri::command]
pub async fn preview_drop(state: State<'_, AppState>, conn_id: String, schema: String, table: String) -> AppResult<DdlStmt> {
    Ok(ddl::plan_drop(state.connected(&conn_id).await?.cfg.driver, Some(&schema), &table))
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

/// 구조 탭 입력란 제안 목록 (문자셋·정렬규칙·엔진)
#[tauri::command]
pub async fn ddl_choices(state: State<'_, AppState>, conn_id: String) -> AppResult<structure::DdlChoices> {
    structure::choices(&state.connected(&conn_id).await?.pool).await
}
