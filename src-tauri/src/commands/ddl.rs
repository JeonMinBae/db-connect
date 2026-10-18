use tauri::State;

use crate::db::ddl::{self, DdlPlan};
use crate::db::pool::DbPool;
use crate::db::structure::{self, TableStructure};
use crate::error::{AppError, AppResult};
use crate::state::AppState;
use crate::store::config::Driver;

/// 이보다 큰 테이블은 미리보기에 시간·잠금 안내를 붙인다
const LARGE_TABLE_ROWS: i64 = 100_000;

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
        ddl::append_rename(&mut plan, d, Some(&schema), &table, &n)?;
    }
    if !plan.statements.is_empty() {
        if let Some(n) = structure::estimated_rows(&connected.pool, &schema, &table).await?.filter(|n| *n >= LARGE_TABLE_ROWS) {
            plan.notes.push(format!("약 {n}행인 테이블입니다. 테이블을 다시 쓰거나 전체를 검사하는 변경은 시간이 걸리고, 그동안 테이블이 잠길 수 있습니다."));
        }
    }
    Ok(plan)
}

/// 테이블 삭제 미리보기. SQLite는 외래 키가 켜져 있어 DROP이 참조하는 행에 ON DELETE 동작을 일으키므로 경고를 붙인다.
#[tauri::command]
pub async fn preview_drop(state: State<'_, AppState>, conn_id: String, schema: String, table: String) -> AppResult<DdlPlan> {
    let connected = state.connected(&conn_id).await?;
    let d = connected.cfg.driver;
    let mut plan = DdlPlan { statements: vec![ddl::plan_drop(d, Some(&schema), &table)], ..Default::default() };
    if let DbPool::Lite(p) = &connected.pool {
        for (child, on_delete) in structure::sqlite_referencing(&mut *p.acquire().await?, &table).await? {
            plan.warnings.push(match on_delete.to_ascii_uppercase().as_str() {
                "CASCADE" => format!("테이블 {child}이(가) 이 테이블을 참조합니다(ON DELETE CASCADE). 참조하는 행도 함께 삭제됩니다."),
                "SET NULL" | "SET DEFAULT" => format!("테이블 {child}이(가) 이 테이블을 참조합니다(ON DELETE {on_delete}). 참조하는 행의 값이 바뀝니다."),
                _ => format!("테이블 {child}이(가) 이 테이블을 참조합니다. 참조하는 행이 있으면 삭제가 실패합니다."),
            });
        }
    }
    if d == Driver::Mysql {
        plan.notes.push("MySQL DROP TABLE은 되돌릴 수 없습니다.".into());
    }
    Ok(plan)
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
    let r = ddl::apply(&mut conn.as_any(), &statements).await;
    if r.is_err() {
        // 실패 경로에서 PRAGMA 복원·롤백이 끝까지 됐는지 장담할 수 없으므로 연결을 풀에 돌려주지 않는다
        conn.discard().await;
    }
    r
}

/// 구조 탭 입력란 제안 목록 (문자셋·정렬규칙·엔진)
#[tauri::command]
pub async fn ddl_choices(state: State<'_, AppState>, conn_id: String) -> AppResult<structure::DdlChoices> {
    structure::choices(&state.connected(&conn_id).await?.pool).await
}
