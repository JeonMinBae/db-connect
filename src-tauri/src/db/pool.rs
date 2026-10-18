use std::time::Duration;

use sqlx::mysql::{MySqlConnectOptions, MySqlConnection, MySqlPool, MySqlPoolOptions, MySqlSslMode};
use sqlx::postgres::{PgConnectOptions, PgConnection, PgPool, PgPoolOptions, PgSslMode};
use sqlx::sqlite::{SqliteConnectOptions, SqliteConnection, SqlitePool, SqlitePoolOptions};
use sqlx::{Connection, Executor};

use crate::error::{AppError, AppResult};
use crate::store::config::{ConnectionConfig, Driver, SslMode};

pub enum DbPool {
    Pg(PgPool),
    My(MySqlPool),
    Lite(SqlitePool),
}

#[derive(Clone)]
pub enum ConnectOpts {
    Pg(PgConnectOptions),
    /// bool = read_only (MySQL은 연결 후 SET 문으로 적용)
    My(MySqlConnectOptions, bool),
    Lite(SqliteConnectOptions),
}

/// 풀 밖의 단일 연결 (Manual 트랜잭션 콘솔, 연결 테스트, 쿼리 취소용)
pub enum DbConn {
    Pg(PgConnection),
    My(MySqlConnection),
    Lite(SqliteConnection),
    /// 닫힌 뒤의 자리표시자
    Closed,
}

/// 실행 함수들이 받는 연결 참조 (풀 연결과 전용 연결 공통)
pub enum AnyConn<'a> {
    Pg(&'a mut PgConnection),
    My(&'a mut MySqlConnection),
    Lite(&'a mut SqliteConnection),
}

pub enum Pooled {
    Pg(sqlx::pool::PoolConnection<sqlx::Postgres>),
    My(sqlx::pool::PoolConnection<sqlx::MySql>),
    Lite(sqlx::pool::PoolConnection<sqlx::Sqlite>),
}

impl AnyConn<'_> {
    /// 바인딩 없는 SQL을 텍스트 프로토콜로 실행하고 영향 행 수를 돌려준다
    pub async fn execute_raw(&mut self, sql: &str) -> AppResult<u64> {
        Ok(match self {
            AnyConn::Pg(c) => (&mut **c).execute(sql).await?.rows_affected(),
            AnyConn::My(c) => (&mut **c).execute(sql).await?.rows_affected(),
            AnyConn::Lite(c) => (&mut **c).execute(sql).await?.rows_affected(),
        })
    }
}

impl Pooled {
    pub fn as_any(&mut self) -> AnyConn<'_> {
        match self {
            Pooled::Pg(c) => AnyConn::Pg(&mut **c),
            Pooled::My(c) => AnyConn::My(&mut **c),
            Pooled::Lite(c) => AnyConn::Lite(&mut **c),
        }
    }

    /// 풀에 돌려주지 않고 닫는다. 서버가 아직 결과를 보내는 중인 연결을 재사용하지 않기 위해 쓴다.
    pub async fn discard(self) {
        let _ = match self {
            Pooled::Pg(c) => c.detach().close().await,
            Pooled::My(c) => c.detach().close().await,
            Pooled::Lite(c) => c.detach().close().await,
        };
    }
}

impl DbConn {
    pub fn as_any(&mut self) -> AppResult<AnyConn<'_>> {
        Ok(match self {
            DbConn::Pg(c) => AnyConn::Pg(c),
            DbConn::My(c) => AnyConn::My(c),
            DbConn::Lite(c) => AnyConn::Lite(c),
            DbConn::Closed => return Err(AppError::user("연결이 닫혔습니다")),
        })
    }

    pub async fn close(self) {
        let _ = match self {
            DbConn::Pg(c) => c.close().await,
            DbConn::My(c) => c.close().await,
            DbConn::Lite(c) => c.close().await,
            DbConn::Closed => Ok(()),
        };
    }
}

impl DbPool {
    pub async fn acquire(&self) -> AppResult<Pooled> {
        Ok(match self {
            DbPool::Pg(p) => Pooled::Pg(p.acquire().await?),
            DbPool::My(p) => Pooled::My(p.acquire().await?),
            DbPool::Lite(p) => Pooled::Lite(p.acquire().await?),
        })
    }

    pub async fn close(&self) {
        match self {
            DbPool::Pg(p) => p.close().await,
            DbPool::My(p) => p.close().await,
            DbPool::Lite(p) => p.close().await,
        }
    }
}

const MY_READ_ONLY: &str = "SET SESSION TRANSACTION READ ONLY";

pub fn build_opts(cfg: &ConnectionConfig, pw: Option<&str>) -> AppResult<ConnectOpts> {
    Ok(match cfg.driver {
        Driver::Postgres => {
            let mut o = PgConnectOptions::new()
                .host(&cfg.host)
                .port(cfg.port)
                .username(&cfg.user)
                .application_name("db-connect")
                .ssl_mode(match cfg.ssl_mode {
                    SslMode::Disable => PgSslMode::Disable,
                    SslMode::Prefer => PgSslMode::Prefer,
                    SslMode::Require => PgSslMode::Require,
                    SslMode::VerifyCa => PgSslMode::VerifyCa,
                    SslMode::VerifyFull => PgSslMode::VerifyFull,
                });
            if !cfg.database.is_empty() {
                o = o.database(&cfg.database);
            }
            if let Some(pw) = pw {
                o = o.password(pw);
            }
            if let Some(ca) = cfg.ssl_root_cert.as_deref().filter(|s| !s.is_empty()) {
                o = o.ssl_root_cert(ca);
            }
            if cfg.read_only {
                o = o.options([("default_transaction_read_only", "on")]);
            }
            ConnectOpts::Pg(o)
        }
        Driver::Mysql => {
            let mut o = MySqlConnectOptions::new()
                .host(&cfg.host)
                .port(cfg.port)
                .username(&cfg.user)
                .charset("utf8mb4")
                .ssl_mode(match cfg.ssl_mode {
                    SslMode::Disable => MySqlSslMode::Disabled,
                    SslMode::Prefer => MySqlSslMode::Preferred,
                    SslMode::Require => MySqlSslMode::Required,
                    SslMode::VerifyCa => MySqlSslMode::VerifyCa,
                    SslMode::VerifyFull => MySqlSslMode::VerifyIdentity,
                });
            if !cfg.database.is_empty() {
                o = o.database(&cfg.database);
            }
            if let Some(pw) = pw {
                o = o.password(pw);
            }
            if let Some(ca) = cfg.ssl_root_cert.as_deref().filter(|s| !s.is_empty()) {
                o = o.ssl_ca(ca);
            }
            ConnectOpts::My(o, cfg.read_only)
        }
        Driver::Sqlite => {
            if cfg.sqlite_path.is_empty() {
                return Err(AppError::user("SQLite 파일 경로가 비어 있습니다"));
            }
            let o = SqliteConnectOptions::new()
                .filename(&cfg.sqlite_path)
                .create_if_missing(false)
                .read_only(cfg.read_only)
                .busy_timeout(Duration::from_secs(5));
            ConnectOpts::Lite(o)
        }
        Driver::Redis | Driver::Mongodb => return Err(AppError::user("SQL 접속이 아닙니다")),
    })
}

impl ConnectOpts {
    pub async fn connect_single(&self) -> AppResult<DbConn> {
        Ok(match self {
            ConnectOpts::Pg(o) => DbConn::Pg(PgConnection::connect_with(o).await?),
            ConnectOpts::My(o, ro) => {
                let mut c = MySqlConnection::connect_with(o).await?;
                if *ro {
                    c.execute(MY_READ_ONLY).await?;
                }
                DbConn::My(c)
            }
            ConnectOpts::Lite(o) => DbConn::Lite(SqliteConnection::connect_with(o).await?),
        })
    }

    pub async fn open_pool(&self) -> AppResult<DbPool> {
        const MAX: u32 = 2;
        let timeout = Duration::from_secs(10);
        Ok(match self {
            ConnectOpts::Pg(o) => DbPool::Pg(
                PgPoolOptions::new()
                    .max_connections(MAX)
                    .acquire_timeout(timeout)
                    .connect_with(o.clone())
                    .await?,
            ),
            ConnectOpts::My(o, ro) => {
                let ro = *ro;
                DbPool::My(
                    MySqlPoolOptions::new()
                        .max_connections(MAX)
                        .acquire_timeout(timeout)
                        .after_connect(move |c, _| {
                            Box::pin(async move {
                                if ro {
                                    c.execute(MY_READ_ONLY).await?;
                                }
                                Ok(())
                            })
                        })
                        .connect_with(o.clone())
                        .await?,
                )
            }
            ConnectOpts::Lite(o) => DbPool::Lite(
                SqlitePoolOptions::new()
                    .max_connections(MAX)
                    .acquire_timeout(timeout)
                    .connect_with(o.clone())
                    .await?,
            ),
        })
    }
}

/// 일회성 연결 후 서버 버전을 돌려준다.
pub async fn test(cfg: &ConnectionConfig, pw: Option<&str>) -> AppResult<String> {
    let opts = build_opts(cfg, pw)?;
    let mut conn = opts.connect_single().await?;
    let version: String = match conn.as_any()? {
        AnyConn::Pg(c) => sqlx::query_scalar("SELECT version()").fetch_one(c).await?,
        AnyConn::My(c) => sqlx::query_scalar("SELECT CAST(CONCAT('MySQL ', VERSION()) AS CHAR)").fetch_one(c).await?,
        AnyConn::Lite(c) => sqlx::query_scalar("SELECT 'SQLite ' || sqlite_version()").fetch_one(c).await?,
    };
    conn.close().await;
    Ok(version)
}

pub async fn default_schema(pool: &DbPool) -> AppResult<String> {
    Ok(match pool {
        DbPool::Pg(p) => sqlx::query_scalar("SELECT current_schema()::text").fetch_one(p).await?,
        DbPool::My(p) => {
            let s: Option<String> = sqlx::query_scalar("SELECT CAST(DATABASE() AS CHAR)").fetch_one(p).await?;
            s.unwrap_or_default()
        }
        DbPool::Lite(_) => "main".to_string(),
    })
}
