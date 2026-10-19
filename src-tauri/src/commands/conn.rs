use std::sync::Arc;

use serde::Serialize;
use tauri::State;

use crate::db::mongo::{self, MongoConn, Topology};
use crate::db::pool::{self, build_opts};
use crate::db::redis::{self, RedisConn};
use crate::error::{AppError, AppResult};
use crate::remote::{self, RemoteConn};
use crate::state::{AppState, Connected};
use crate::store::config::{self, ConnectionConfig, Driver};
use crate::store::secrets;

#[tauri::command]
pub fn list_connections(state: State<'_, AppState>) -> AppResult<Vec<ConnectionConfig>> {
    config::load(&state.data_dir)
}

/// password: None → 기존 비밀번호 유지, Some("") → 삭제, Some(pw) → 저장.
/// MongoDB URI에 비밀번호가 들어 있으면 떼어 내 키체인에 둔다(비밀번호 칸이 비어 있을 때).
#[tauri::command]
pub fn save_connection(state: State<'_, AppState>, mut config: ConnectionConfig, mut password: Option<String>) -> AppResult<()> {
    if config.driver == Driver::Mongodb {
        let (uri, pw) = mongo::split_password(config.mongo_uri.trim());
        config.mongo_uri = uri;
        if let Some(pw) = pw {
            if password.as_deref().map_or(true, str::is_empty) {
                password = Some(pw);
            }
        }
    }
    match password.as_deref() {
        None => {}
        Some("") => secrets::delete_password(&config.id)?,
        Some(pw) => secrets::set_password(&config.id, pw)?,
    }
    config::upsert(&state.data_dir, config)
}

#[tauri::command]
pub fn reorder_connections(state: State<'_, AppState>, ids: Vec<String>) -> AppResult<()> {
    config::reorder(&state.data_dir, &ids)
}

#[tauri::command]
pub async fn delete_connection(state: State<'_, AppState>, id: String) -> AppResult<()> {
    disconnect(state.clone(), id.clone()).await?;
    config::remove(&state.data_dir, &id)?;
    // 이 접속의 콘솔 파일도 지운다
    match std::fs::remove_dir_all(state.data_dir.join("consoles").join(crate::store::files::safe_id(&id)?)) {
        Err(e) if e.kind() != std::io::ErrorKind::NotFound => return Err(e.into()),
        _ => {}
    }
    secrets::delete_password(&id)
}

/// 접속 대상이 같은지 (저장된 비밀번호를 다른 서버로 보내지 않기 위해)
fn same_target(a: &ConnectionConfig, b: &ConnectionConfig) -> bool {
    let strip = |u: &str| mongo::split_password(u.trim()).0;
    a.driver == b.driver && a.host == b.host && a.port == b.port && a.user == b.user && strip(&a.mongo_uri) == strip(&b.mongo_uri)
        && a.ssh_key_path == b.ssh_key_path
        && a.s3_endpoint == b.s3_endpoint
        && a.s3_bucket == b.s3_bucket
}

/// password가 None이면 저장된 비밀번호로 테스트한다(편집 다이얼로그에서 비밀번호 칸을 비운 경우).
/// 이때 대상(드라이버·호스트·포트·사용자·URI)이 저장된 설정과 다르면 비밀번호를 다른 서버로 보내지 않는다.
#[tauri::command]
pub async fn test_connection(state: State<'_, AppState>, config: ConnectionConfig, password: Option<String>) -> AppResult<String> {
    let pw = match password {
        Some(p) => Some(p),
        None => {
            if let Ok(saved) = config::get(&state.data_dir, &config.id) {
                if !same_target(&saved, &config) {
                    return Err(AppError::user("접속 대상(호스트·포트·사용자·URI)이 바뀌었습니다. 테스트하려면 비밀번호를 다시 입력하세요."));
                }
            }
            secrets::get_password(&config.id)?
        }
    };
    let pw = pw.as_deref().filter(|p| !p.is_empty());
    match config.driver {
        Driver::Redis => redis::test(&config, pw).await,
        Driver::Mongodb => mongo::test(&config, pw).await,
        Driver::Ftp | Driver::Sftp | Driver::S3 => remote::test(&config, pw, &state.data_dir).await,
        _ => pool::test(&config, pw).await,
    }
}

#[derive(Serialize)]
pub struct ConnectInfo {
    /// SQL: 기본 스키마, Redis: "db{n}", MongoDB: URI의 기본 DB(없으면 "")
    pub default_schema: String,
    /// MongoDB 토폴로지 (트랜잭션 가능 여부 표시용)
    pub topology: Option<Topology>,
}

#[tauri::command]
pub async fn connect(state: State<'_, AppState>, id: String) -> AppResult<ConnectInfo> {
    if let Some(c) = state.conns.read().await.get(&id) {
        return Ok(ConnectInfo { default_schema: c.default_schema.clone(), topology: None });
    }
    if let Some(c) = state.redis.read().await.get(&id) {
        return Ok(ConnectInfo { default_schema: format!("db{}", c.cfg.redis_db), topology: None });
    }
    if let Some(c) = state.mongo.read().await.get(&id) {
        return Ok(ConnectInfo { default_schema: c.default_db.clone().unwrap_or_default(), topology: Some(c.topology) });
    }
    if state.remote.read().await.contains_key(&id) {
        return Ok(ConnectInfo { default_schema: "/".into(), topology: None });
    }
    let cfg = config::get(&state.data_dir, &id)?;
    let pw = secrets::get_password(&id)?;
    match cfg.driver {
        Driver::Redis => {
            let c = RedisConn::open(cfg, pw).await?;
            let info = ConnectInfo { default_schema: format!("db{}", c.cfg.redis_db), topology: None };
            state.redis.write().await.insert(id, Arc::new(c));
            Ok(info)
        }
        Driver::Mongodb => {
            let c = MongoConn::open(cfg, pw).await?;
            let info = ConnectInfo { default_schema: c.default_db.clone().unwrap_or_default(), topology: Some(c.topology) };
            state.mongo.write().await.insert(id, Arc::new(c));
            Ok(info)
        }
        Driver::Ftp | Driver::Sftp | Driver::S3 => {
            let c = RemoteConn::open(cfg, pw, state.data_dir.clone()).await?;
            state.remote.write().await.insert(id, Arc::new(c));
            Ok(ConnectInfo { default_schema: "/".into(), topology: None })
        }
        _ => {
            let opts = build_opts(&cfg, pw.as_deref())?;
            let pool = opts.open_pool().await?;
            let default_schema = pool::default_schema(&pool).await?;
            let info = ConnectInfo { default_schema: default_schema.clone(), topology: None };
            state.conns.write().await.insert(id, Arc::new(Connected { cfg, opts, pool, default_schema }));
            Ok(info)
        }
    }
}

#[tauri::command]
pub async fn disconnect(state: State<'_, AppState>, id: String) -> AppResult<()> {
    // 이 접속의 전용 연결(Manual 트랜잭션)을 먼저 정리한다. 미커밋 변경은 롤백된다.
    let dedicated: Vec<_> = {
        let mut map = state.dedicated.lock().await;
        let keys: Vec<String> = map.iter().filter(|(_, (cid, _))| *cid == id).map(|(k, _)| k.clone()).collect();
        keys.iter().filter_map(|k| map.remove(k)).collect()
    };
    for (_, d) in dedicated {
        // 실행 중이면 끝날 때까지 기다린 뒤 닫는다.
        d.lock().await.close().await;
    }
    if let Some(c) = state.conns.write().await.remove(&id) {
        c.pool.close().await;
    }
    // Redis 연결은 마지막 참조가 사라질 때 닫힌다
    state.redis.write().await.remove(&id);
    state.remote.write().await.remove(&id);
    if let Some(c) = state.mongo.write().await.remove(&id) {
        c.client.clone().shutdown().await;
    }
    Ok(())
}
