use std::collections::HashMap;
use std::sync::Mutex;

use sqlx::Executor;

use crate::db::pool::{AnyConn, ConnectOpts, DbConn};
use crate::error::{AppError, AppResult};

/// 실행 중인 쿼리를 서버 쪽에서 멈추는 데 필요한 정보
#[derive(Clone)]
pub enum CancelHandle {
    Pg { pid: i32, opts: ConnectOpts },
    My { thread_id: u64, opts: ConnectOpts },
    /// sqlite3* 포인터. sqlite3_interrupt는 다른 스레드에서 호출해도 안전하다.
    Lite { db: usize },
}

#[derive(Default)]
pub struct Registry(Mutex<HashMap<String, CancelHandle>>);

/// 드롭될 때 등록을 해제한다 (실행 경로마다 수동 해제를 빠뜨리지 않도록)
pub struct Registered<'a> {
    reg: &'a Registry,
    exec_id: String,
}

impl Drop for Registered<'_> {
    fn drop(&mut self) {
        self.reg.0.lock().unwrap().remove(&self.exec_id);
    }
}

impl Registry {
    pub fn register(&self, exec_id: &str, h: CancelHandle) -> Registered<'_> {
        self.0.lock().unwrap().insert(exec_id.to_string(), h);
        Registered { reg: self, exec_id: exec_id.to_string() }
    }

    /// 등록되어 있으면 취소를 보낸다. 등록 전이면 false.
    pub async fn cancel(&self, exec_id: &str) -> AppResult<bool> {
        let h = {
            let map = self.0.lock().unwrap();
            match map.get(exec_id) {
                None => return Ok(false),
                // SQLite는 락을 잡은 채 호출한다. 실행이 끝나 등록이 해제된 연결(닫혔을 수 있음)에는 호출하지 않는다.
                Some(CancelHandle::Lite { db }) => {
                    if *db == 0 {
                        return Err(AppError::user("취소할 수 없는 연결입니다"));
                    }
                    // SAFETY: 등록되어 있는 동안 해당 연결은 실행 중이므로 살아 있다.
                    unsafe { libsqlite3_sys::sqlite3_interrupt(*db as *mut libsqlite3_sys::sqlite3) };
                    return Ok(true);
                }
                Some(h) => h.clone(),
            }
        };
        send_cancel(&h).await?;
        Ok(true)
    }
}

/// 실행 직전에 같은 연결에서 취소용 식별자를 얻는다.
pub async fn handle_for(conn: &mut AnyConn<'_>, opts: &ConnectOpts) -> AppResult<CancelHandle> {
    Ok(match conn {
        AnyConn::Pg(c) => {
            let pid: i32 = sqlx::query_scalar("SELECT pg_backend_pid()").fetch_one(&mut **c).await?;
            CancelHandle::Pg { pid, opts: opts.clone() }
        }
        AnyConn::My(c) => {
            let thread_id: u64 = sqlx::query_scalar("SELECT CONNECTION_ID()").fetch_one(&mut **c).await?;
            CancelHandle::My { thread_id, opts: opts.clone() }
        }
        AnyConn::Lite(c) => {
            let mut h = c.lock_handle().await?;
            CancelHandle::Lite { db: h.as_raw_handle().as_ptr() as usize }
        }
    })
}

/// 별도의 일회성 연결로 취소를 보낸다(풀이 바빠도 동작하도록).
async fn send_cancel(h: &CancelHandle) -> AppResult<()> {
    match h {
        CancelHandle::Pg { pid, opts } => {
            let DbConn::Pg(mut c) = opts.connect_single().await? else { unreachable!() };
            sqlx::query("SELECT pg_cancel_backend($1)").bind(pid).execute(&mut c).await?;
        }
        CancelHandle::My { thread_id, opts } => {
            let DbConn::My(mut c) = opts.connect_single().await? else { unreachable!() };
            c.execute(format!("KILL QUERY {thread_id}").as_str()).await?;
        }
        CancelHandle::Lite { .. } => unreachable!("SQLite는 Registry::cancel에서 처리"),
    }
    Ok(())
}
