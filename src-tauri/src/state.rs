use std::collections::HashMap;
use std::path::PathBuf;
use std::sync::Arc;

use tokio::sync::{Mutex, OwnedMutexGuard, RwLock};

use crate::db::cancel::{self, CancelHandle};
use crate::db::mongo::MongoConn;
use crate::db::pool::{AnyConn, ConnectOpts, DbConn, DbPool, Pooled};
use crate::db::redis::RedisConn;
use crate::error::{AppError, AppResult};
use crate::store::config::ConnectionConfig;

pub struct Connected {
    pub cfg: ConnectionConfig,
    pub opts: ConnectOpts,
    pub pool: DbPool,
    pub default_schema: String,
}

/// Manual 트랜잭션 콘솔이 붙잡고 있는 전용 연결
pub struct Dedicated {
    pub conn: DbConn,
    /// 연결 생성 시점에 얻어 둔 취소 핸들 (트랜잭션이 aborted 상태여도 취소할 수 있도록)
    pub cancel: CancelHandle,
}

impl Dedicated {
    /// 연결을 닫는다. 열린 트랜잭션은 서버에서 롤백된다.
    pub async fn close(&mut self) {
        std::mem::replace(&mut self.conn, DbConn::Closed).close().await;
    }
}

/// 명령 하나가 쓰는 연결: Manual 트랜잭션 콘솔이면 그 전용 연결, 아니면 풀 연결
pub enum Lease {
    Dedicated(OwnedMutexGuard<Dedicated>),
    Pooled(Pooled),
}

impl Lease {
    pub fn as_any(&mut self) -> AppResult<AnyConn<'_>> {
        match self {
            Lease::Dedicated(g) => g.conn.as_any(),
            Lease::Pooled(p) => Ok(p.as_any()),
        }
    }

    /// 이미 열린 사용자 트랜잭션 안인지 (SAVEPOINT로 감싸야 하는지)
    pub fn in_tx(&self) -> bool {
        matches!(self, Lease::Dedicated(_))
    }

    /// 취소 핸들. 전용 연결은 만들 때 얻어 둔 것을, 풀 연결은 지금 조회한다.
    pub async fn cancel_handle(&mut self, opts: &ConnectOpts) -> AppResult<CancelHandle> {
        match self {
            Lease::Dedicated(g) => Ok(g.cancel.clone()),
            Lease::Pooled(p) => cancel::handle_for(&mut p.as_any(), opts).await,
        }
    }

    /// 풀 연결이면 반납하지 않고 닫는다 (남은 결과를 서버가 계속 보내는 경우)
    pub async fn discard_if_pooled(self) {
        if let Lease::Pooled(p) = self {
            p.discard().await;
        }
    }
}

pub struct AppState {
    pub data_dir: PathBuf,
    pub conns: RwLock<HashMap<String, Arc<Connected>>>,
    /// console_id → (conn_id, 전용 연결)
    pub dedicated: Mutex<HashMap<String, (String, Arc<Mutex<Dedicated>>)>>,
    pub cancels: cancel::Registry,
    pub redis: RwLock<HashMap<String, Arc<RedisConn>>>,
    pub mongo: RwLock<HashMap<String, Arc<MongoConn>>>,
    /// Redis·MongoDB 실행 중인 작업 (exec_id → 중지 핸들)
    pub aborts: Mutex<HashMap<String, tokio::task::AbortHandle>>,
}

impl AppState {
    pub fn new(data_dir: PathBuf) -> Self {
        Self {
            data_dir,
            conns: RwLock::new(HashMap::new()),
            dedicated: Mutex::new(HashMap::new()),
            cancels: cancel::Registry::default(),
            redis: RwLock::new(HashMap::new()),
            mongo: RwLock::new(HashMap::new()),
            aborts: Mutex::new(HashMap::new()),
        }
    }

    pub async fn connected(&self, conn_id: &str) -> AppResult<Arc<Connected>> {
        self.conns
            .read()
            .await
            .get(conn_id)
            .cloned()
            .ok_or_else(|| AppError::user("연결되어 있지 않습니다. 먼저 접속하세요."))
    }

    pub async fn dedicated_for(&self, console_id: Option<&str>) -> Option<Arc<Mutex<Dedicated>>> {
        let id = console_id?;
        self.dedicated.lock().await.get(id).map(|(_, d)| d.clone())
    }

    /// 접속과 실행에 쓸 연결을 함께 얻는다.
    pub async fn lease(&self, conn_id: &str, console_id: Option<&str>) -> AppResult<(Arc<Connected>, Lease)> {
        let connected = self.connected(conn_id).await?;
        let lease = match self.dedicated_for(console_id).await {
            Some(d) => Lease::Dedicated(d.lock_owned().await),
            None => Lease::Pooled(connected.pool.acquire().await?),
        };
        Ok((connected, lease))
    }
}

impl AppState {
    pub async fn redis(&self, conn_id: &str) -> AppResult<Arc<RedisConn>> {
        self.redis.read().await.get(conn_id).cloned().ok_or_else(|| AppError::user("Redis에 연결되어 있지 않습니다. 먼저 접속하세요."))
    }

    pub async fn mongo(&self, conn_id: &str) -> AppResult<Arc<MongoConn>> {
        self.mongo.read().await.get(conn_id).cloned().ok_or_else(|| AppError::user("MongoDB에 연결되어 있지 않습니다. 먼저 접속하세요."))
    }

    /// Redis·MongoDB 작업을 중지할 수 있게 별도 태스크로 실행한다. 중지되면 오류를 돌려준다.
    pub async fn abortable<T: Send + 'static>(&self, exec_id: &str, fut: impl std::future::Future<Output = AppResult<T>> + Send + 'static) -> AppResult<T> {
        let task = tokio::spawn(fut);
        self.aborts.lock().await.insert(exec_id.to_string(), task.abort_handle());
        let r = task.await;
        self.aborts.lock().await.remove(exec_id);
        match r {
            Ok(v) => v,
            Err(e) if e.is_cancelled() => Err(AppError::user("사용자가 중지했습니다.")),
            Err(e) => Err(AppError::user(e.to_string())),
        }
    }
}
