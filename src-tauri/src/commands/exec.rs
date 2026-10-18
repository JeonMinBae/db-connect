use std::sync::Arc;

use tauri::State;
use tokio::sync::Mutex;

use crate::db::cancel;
use crate::db::exec::{self, ExecRequest, ExecResult};
use crate::error::{AppError, AppResult};
use crate::state::{AppState, Dedicated};
use crate::store::config::Driver;

#[tauri::command]
pub async fn execute(state: State<'_, AppState>, req: ExecRequest) -> AppResult<ExecResult> {
    let (connected, mut lease) = state.lease(&req.conn_id, req.console_id.as_deref()).await?;
    if connected.cfg.read_only && connected.cfg.driver != Driver::Sqlite && exec::changes_read_only(&req.sql) {
        return Err(AppError::user(
            "읽기 전용 접속에서는 읽기 전용 설정을 바꾸는 문장(READ WRITE, *_read_only)을 실행할 수 없습니다.",
        ));
    }
    let h = lease.cancel_handle(&connected.opts).await?;
    let result = {
        let _reg = state.cancels.register(&req.exec_id, h);
        exec::run(&mut lease.as_any()?, &req).await?
    };
    // 페이지 조회가 아닌 문장을 500행에서 끊었으면 서버가 나머지를 계속 보내므로 연결을 재사용하지 않는다
    if result.has_more && !req.paged {
        lease.discard_if_pooled().await;
    }
    Ok(result)
}

#[tauri::command]
pub async fn count_rows(state: State<'_, AppState>, conn_id: String, console_id: Option<String>, sql: String) -> AppResult<i64> {
    let (_, mut lease) = state.lease(&conn_id, console_id.as_deref()).await?;
    exec::count(&mut lease.as_any()?, &sql).await
}

/// Manual 트랜잭션 모드 전환.
/// manual=true: 전용 연결을 만들고 BEGIN. manual=false: finish("commit"|"rollback") 후 연결을 닫는다.
#[tauri::command]
pub async fn set_tx_mode(
    state: State<'_, AppState>,
    conn_id: String,
    console_id: String,
    manual: bool,
    finish: Option<String>,
) -> AppResult<()> {
    if manual {
        if state.dedicated_for(Some(&console_id)).await.is_some() {
            return Ok(());
        }
        let connected = state.connected(&conn_id).await?;
        let mut conn = connected.opts.connect_single().await?;
        let handle = cancel::handle_for(&mut conn.as_any()?, &connected.opts).await?;
        conn.as_any()?.execute_raw("BEGIN").await?;
        let entry = Arc::new(Mutex::new(Dedicated { conn, cancel: handle }));
        state.dedicated.lock().await.insert(console_id, (conn_id, entry));
        return Ok(());
    }
    let Some((_, d)) = state.dedicated.lock().await.remove(&console_id) else { return Ok(()) };
    let mut g = d.lock().await;
    let end = if finish.as_deref() == Some("commit") { "COMMIT" } else { "ROLLBACK" };
    let r = match g.conn.as_any() {
        Ok(mut a) => a.execute_raw(end).await.map(drop),
        Err(e) => Err(e),
    };
    g.close().await;
    r
}

/// Manual 모드 콘솔의 Commit / Rollback / Begin. commit·rollback 후에는 바로 새 트랜잭션을 연다.
#[tauri::command]
pub async fn tx_action(state: State<'_, AppState>, console_id: String, action: String) -> AppResult<()> {
    let d = state
        .dedicated_for(Some(&console_id))
        .await
        .ok_or_else(|| AppError::user("Manual 트랜잭션 모드가 아닙니다"))?;
    let mut g = d.lock().await;
    let mut a = g.conn.as_any()?;
    match action.as_str() {
        "commit" => {
            a.execute_raw("COMMIT").await?;
            a.execute_raw("BEGIN").await.map(drop)
        }
        "rollback" => {
            a.execute_raw("ROLLBACK").await?;
            a.execute_raw("BEGIN").await.map(drop)
        }
        "begin" => a.execute_raw("BEGIN").await.map(drop),
        _ => Err(AppError::user("알 수 없는 동작")),
    }
}

#[tauri::command]
pub async fn cancel_query(state: State<'_, AppState>, exec_id: String) -> AppResult<bool> {
    // Redis·MongoDB 작업은 태스크를 중지한다 (연결은 각 커맨드가 정리한다)
    if let Some(h) = state.aborts.lock().await.remove(&exec_id) {
        h.abort();
        return Ok(true);
    }
    state.cancels.cancel(&exec_id).await
}
