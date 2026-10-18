//! Redis 단일 서버 접속. 논리 DB마다 다중화 연결을 하나씩 두고, 콘솔·Submit은 전용 연결을 쓴다.

use std::collections::{HashMap, HashSet};
use std::time::Duration;

use redis::aio::MultiplexedConnection;
use redis::{AsyncConnectionConfig, Value};
use serde::{Deserialize, Serialize};
use tokio::sync::Mutex;

use crate::error::{AppError, AppResult};
use crate::store::config::{ConnectionConfig, SslMode};

const TIMEOUT: Duration = Duration::from_secs(10);

/// URL의 사용자·비밀번호 칸에 넣을 수 있게 인코딩한다 (비예약 문자만 그대로 둔다)
fn pct(s: &str) -> String {
    let mut out = String::with_capacity(s.len());
    for b in s.bytes() {
        if b.is_ascii_alphanumeric() || b"-._~".contains(&b) {
            out.push(b as char);
        } else {
            out.push_str(&format!("%{b:02X}"));
        }
    }
    out
}

/// 접속 설정 → redis URL. TLS: disable(평문) / require·prefer(검증 안 함) / verify-*(인증서 검증, Windows 인증서 저장소)
pub fn url_for(cfg: &ConnectionConfig, pw: Option<&str>, db: u8) -> String {
    let (scheme, frag) = match cfg.ssl_mode {
        SslMode::Disable => ("redis", ""),
        SslMode::Prefer | SslMode::Require => ("rediss", "#insecure"),
        SslMode::VerifyCa | SslMode::VerifyFull => ("rediss", ""),
    };
    let auth = match (cfg.user.as_str(), pw) {
        ("", None) => String::new(),
        (u, None) => format!("{}@", pct(u)),
        (u, Some(p)) => format!("{}:{}@", pct(u), pct(p)),
    };
    let host = if cfg.host.contains(':') && !cfg.host.starts_with('[') { format!("[{}]", cfg.host) } else { cfg.host.clone() };
    format!("{scheme}://{auth}{host}:{}/{db}{frag}", cfg.port)
}

/// 쓰기 명령 목록을 얻지 못했을 때(COMMAND가 막힌 관리형 Redis 등) 쓰는 기본 목록
const FALLBACK_WRITE: &[&str] = &[
    "set", "setnx", "setex", "psetex", "getset", "getdel", "getex", "mset", "msetnx", "append", "setrange", "incr", "incrby",
    "incrbyfloat", "decr", "decrby", "del", "unlink", "expire", "expireat", "pexpire", "pexpireat", "persist", "rename",
    "renamenx", "move", "copy", "restore", "hset", "hsetnx", "hmset", "hdel", "hincrby", "hincrbyfloat", "lpush", "lpushx",
    "rpush", "rpushx", "lpop", "rpop", "lset", "lrem", "ltrim", "linsert", "lmove", "rpoplpush", "blpop", "brpop", "blmove",
    "sadd", "srem", "spop", "smove", "sinterstore", "sunionstore", "sdiffstore", "zadd", "zrem", "zincrby", "zpopmin",
    "zpopmax", "zremrangebyscore", "zremrangebyrank", "zremrangebylex", "zunionstore", "zinterstore", "zdiffstore",
    "zrangestore", "xadd", "xdel", "xtrim", "xgroup", "xack", "xclaim", "xautoclaim", "pfadd", "pfmerge", "geoadd",
    "georadius", "georadiusbymember", "geosearchstore", "setbit", "bitop", "bitfield", "flushdb", "flushall", "swapdb",
    "json.set", "json.del", "json.arrappend", "json.numincrby",
];

/// 쓰기 플래그가 없어도 데이터를 바꿀 수 있는 명령 (스크립트·트랜잭션·관리)
const ALWAYS_BLOCKED: &[&str] = &["multi", "exec", "eval", "evalsha", "eval_ro", "fcall", "function", "script", "config", "debug", "shutdown", "replicaof", "slaveof", "module", "acl", "bgsave", "save", "bgrewriteaof", "failover"];

pub struct RedisConn {
    pub cfg: ConnectionConfig,
    pw: Option<String>,
    shared: Mutex<HashMap<u8, MultiplexedConnection>>,
    /// 읽기 전용 검사용 (소문자 명령 이름)
    write_cmds: HashSet<String>,
    /// 콘솔마다 전용 연결 (console_id → (DB, 연결)). 중지하면 버려서 서버 쪽 대기 명령도 끝낸다.
    consoles: Mutex<HashMap<String, (u8, MultiplexedConnection)>>,
}

async fn open_conn(url: &str) -> AppResult<MultiplexedConnection> {
    let client = redis::Client::open(url)?;
    let config = AsyncConnectionConfig::new().set_connection_timeout(Some(TIMEOUT)).set_response_timeout(None);
    Ok(client.get_multiplexed_async_connection_with_config(&config).await?)
}

impl RedisConn {
    pub async fn open(cfg: ConnectionConfig, pw: Option<String>) -> AppResult<Self> {
        let mut c = open_conn(&url_for(&cfg, pw.as_deref(), cfg.redis_db)).await?;
        let write_cmds = write_commands(&mut c).await;
        let mut shared = HashMap::new();
        shared.insert(cfg.redis_db, c);
        Ok(Self { cfg, pw, shared: Mutex::new(shared), write_cmds, consoles: Mutex::new(HashMap::new()) })
    }

    /// 콘솔의 전용 연결. DB가 바뀌었으면 새로 연다.
    pub async fn console(&self, console_id: &str, db: u8) -> AppResult<MultiplexedConnection> {
        let mut map = self.consoles.lock().await;
        if let Some((d, c)) = map.get(console_id) {
            if *d == db {
                return Ok(c.clone());
            }
        }
        let c = self.dedicated(db).await?;
        map.insert(console_id.to_string(), (db, c.clone()));
        Ok(c)
    }

    /// 콘솔 연결을 버린다 (중지, 탭 닫기)
    pub async fn drop_console(&self, console_id: &str) {
        self.consoles.lock().await.remove(console_id);
    }

    /// 논리 DB의 공유 연결 (짧은 조회용). SELECT를 바꾸지 않으므로 여러 탭이 함께 쓴다.
    pub async fn shared(&self, db: u8) -> AppResult<MultiplexedConnection> {
        let mut map = self.shared.lock().await;
        if let Some(c) = map.get(&db) {
            return Ok(c.clone());
        }
        let c = open_conn(&url_for(&self.cfg, self.pw.as_deref(), db)).await?;
        map.insert(db, c.clone());
        Ok(c)
    }

    /// 전용 연결 (콘솔, WATCH/MULTI, 오래 걸리는 명령). 버리면 서버 쪽 연결도 닫힌다.
    pub async fn dedicated(&self, db: u8) -> AppResult<MultiplexedConnection> {
        open_conn(&url_for(&self.cfg, self.pw.as_deref(), db)).await
    }

    /// 읽기 전용 접속이면 쓰기 명령을 거부한다 (실수 방지용)
    pub fn check(&self, argv: &[Vec<u8>]) -> AppResult<()> {
        if self.cfg.read_only {
            check_read_only(&self.write_cmds, argv)?;
        }
        Ok(())
    }
}

/// `COMMAND`에서 write 플래그가 붙은 명령 이름을 모은다. 실패하면 기본 목록.
async fn write_commands(c: &mut MultiplexedConnection) -> HashSet<String> {
    let parsed = match redis::cmd("COMMAND").query_async::<Value>(c).await {
        Ok(Value::Array(list)) => list
            .iter()
            .filter_map(|e| match e {
                Value::Array(f) if f.len() > 2 && flags(&f[2]).iter().any(|x| x == "write") => text(&f[0]).map(|s| s.to_ascii_lowercase()),
                _ => None,
            })
            .collect::<HashSet<_>>(),
        _ => HashSet::new(),
    };
    if parsed.is_empty() {
        FALLBACK_WRITE.iter().map(|s| s.to_string()).collect()
    } else {
        parsed
    }
}

fn text(v: &Value) -> Option<String> {
    match v {
        Value::BulkString(b) => String::from_utf8(b.clone()).ok(),
        Value::SimpleString(s) => Some(s.clone()),
        Value::VerbatimString { text, .. } => Some(text.clone()),
        Value::Okay => Some("OK".into()),
        _ => None,
    }
}

fn flags(v: &Value) -> Vec<String> {
    match v {
        Value::Array(a) | Value::Set(a) => a.iter().filter_map(text).collect(),
        _ => vec![],
    }
}

pub fn check_read_only(write_cmds: &HashSet<String>, argv: &[Vec<u8>]) -> AppResult<()> {
    let Some(first) = argv.first() else { return Ok(()) };
    let cmd = String::from_utf8_lossy(first).to_ascii_lowercase();
    if write_cmds.contains(&cmd) || ALWAYS_BLOCKED.contains(&cmd.as_str()) {
        return Err(AppError::user(format!("읽기 전용 접속에서는 {}을(를) 실행할 수 없습니다", cmd.to_ascii_uppercase())));
    }
    Ok(())
}

/// 일회성 연결로 PING 후 서버 버전을 돌려준다.
pub async fn test(cfg: &ConnectionConfig, pw: Option<&str>) -> AppResult<String> {
    let mut c = open_conn(&url_for(cfg, pw, cfg.redis_db)).await?;
    redis::cmd("PING").query_async::<Value>(&mut c).await?;
    let info: String = redis::cmd("INFO").arg("server").query_async(&mut c).await?;
    let field = |k: &str| info.lines().find_map(|l| l.strip_prefix(k)).map(|s| s.trim().to_string());
    let name = if field("valkey_version:").is_some() { "Valkey" } else { "Redis" };
    let ver = field("valkey_version:").or_else(|| field("redis_version:")).unwrap_or_else(|| "?".into());
    let mode = field("redis_mode:").unwrap_or_default();
    Ok(format!("{name} {ver}{}", if mode.is_empty() || mode == "standalone" { String::new() } else { format!(" ({mode} 모드: 지원하지 않는 형태일 수 있습니다)") }))
}

// ── 프론트로 보내는 응답 ─────────────────────────────────

/// 바이트열: UTF-8이면 그대로, 아니면 redis-cli 방식으로 이스케이프한 문자열 (프론트에서 원래 바이트로 되돌릴 수 있다)
#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "t", content = "v")]
pub enum Bytes {
    Text(String),
    Bin(String),
}

pub fn bytes_of(b: &[u8]) -> Bytes {
    match std::str::from_utf8(b) {
        Ok(s) => Bytes::Text(s.to_string()),
        Err(_) => Bytes::Bin(escape(b)),
    }
}

/// redis-cli의 따옴표 안 표기: \\ \" \n \r \t \xNN
pub fn escape(b: &[u8]) -> String {
    let mut s = String::with_capacity(b.len() * 2);
    for &c in b {
        match c {
            b'\\' => s.push_str("\\\\"),
            b'"' => s.push_str("\\\""),
            b'\n' => s.push_str("\\n"),
            b'\r' => s.push_str("\\r"),
            b'\t' => s.push_str("\\t"),
            0x20..=0x7e => s.push(c as char),
            _ => s.push_str(&format!("\\x{c:02x}")),
        }
    }
    s
}

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "t", content = "v")]
pub enum Reply {
    Nil,
    Int(i64),
    Double(f64),
    Bool(bool),
    Status(String),
    Error(String),
    Bulk(Bytes),
    Array(Vec<Reply>),
    Map(Vec<(Reply, Reply)>),
}

pub fn reply_of(v: Value) -> Reply {
    match v {
        Value::Nil => Reply::Nil,
        Value::Int(i) => Reply::Int(i),
        Value::Double(d) => Reply::Double(d),
        Value::Boolean(b) => Reply::Bool(b),
        Value::Okay => Reply::Status("OK".into()),
        Value::SimpleString(s) => Reply::Status(s),
        Value::BulkString(b) => Reply::Bulk(bytes_of(&b)),
        Value::VerbatimString { text, .. } => Reply::Bulk(Bytes::Text(text)),
        Value::BigNumber(n) => Reply::Status(format!("{n:?}")),
        Value::Array(a) | Value::Set(a) => Reply::Array(a.into_iter().map(reply_of).collect()),
        Value::Map(m) => Reply::Map(m.into_iter().map(|(k, v)| (reply_of(k), reply_of(v))).collect()),
        Value::Attribute { data, .. } => reply_of(*data),
        Value::Push { data, .. } => Reply::Array(data.into_iter().map(reply_of).collect()),
        Value::ServerError(e) => Reply::Error(e.to_string()),
        #[allow(unreachable_patterns)]
        _ => Reply::Status("(지원하지 않는 응답 형식)".into()),
    }
}

/// 프론트에서 받는 인자: 텍스트 또는 16진수 바이트
#[derive(Deserialize, Debug, Clone)]
#[serde(untagged)]
pub enum Arg {
    Text(String),
    Hex { hex: String },
}

impl Arg {
    pub fn bytes(&self) -> AppResult<Vec<u8>> {
        match self {
            Arg::Text(s) => Ok(s.as_bytes().to_vec()),
            Arg::Hex { hex } => (0..hex.len())
                .step_by(2)
                .map(|i| hex.get(i..i + 2).and_then(|h| u8::from_str_radix(h, 16).ok()).ok_or_else(|| AppError::user("잘못된 16진수 인자")))
                .collect(),
        }
    }
}

pub fn argv_of(args: &[Arg]) -> AppResult<Vec<Vec<u8>>> {
    if args.is_empty() {
        return Err(AppError::user("명령이 비어 있습니다"));
    }
    args.iter().map(Arg::bytes).collect()
}

pub fn cmd_of(argv: &[Vec<u8>]) -> redis::Cmd {
    let mut c = redis::cmd(&String::from_utf8_lossy(&argv[0]));
    for a in &argv[1..] {
        c.arg(a.as_slice());
    }
    c
}

#[cfg(test)]
mod tests {
    use super::*;

    fn cfg() -> ConnectionConfig {
        ConnectionConfig { host: "localhost".into(), port: 6379, ssl_mode: SslMode::Disable, ..Default::default() }
    }

    #[test]
    fn urls() {
        assert_eq!(url_for(&cfg(), None, 0), "redis://localhost:6379/0");
        let c = ConnectionConfig { user: "app".into(), ssl_mode: SslMode::Require, ..cfg() };
        assert_eq!(url_for(&c, Some("p@ss:/#"), 3), "rediss://app:p%40ss%3A%2F%23@localhost:6379/3#insecure");
        let c = ConnectionConfig { host: "::1".into(), ssl_mode: SslMode::VerifyFull, ..cfg() };
        assert_eq!(url_for(&c, Some("x"), 1), "rediss://:x@[::1]:6379/1");
    }

    #[test]
    fn read_only() {
        let w: HashSet<String> = ["set".to_string()].into();
        assert!(check_read_only(&w, &[b"get".to_vec(), b"k".to_vec()]).is_ok());
        assert!(check_read_only(&w, &[b"SeT".to_vec(), b"k".to_vec()]).is_err());
        assert!(check_read_only(&w, &[b"EVAL".to_vec()]).is_err());
    }

    #[test]
    fn bytes_and_args() {
        assert_eq!(bytes_of(b"abc"), Bytes::Text("abc".into()));
        assert_eq!(bytes_of(&[0xff, b'"', b'\n', 0]), Bytes::Bin("\\xff\\\"\\n\\x00".into()));
        assert_eq!(Arg::Hex { hex: "00ff".into() }.bytes().unwrap(), vec![0, 255]);
        assert!(Arg::Hex { hex: "0g".into() }.bytes().is_err());
        let r = reply_of(Value::Array(vec![Value::Okay, Value::Nil, Value::Int(3)]));
        assert_eq!(r, Reply::Array(vec![Reply::Status("OK".into()), Reply::Nil, Reply::Int(3)]));
    }
}
