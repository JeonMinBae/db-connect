//! MongoDB 접속. 드라이버의 Client가 연결 풀을 관리한다.

use std::time::Duration;

use mongodb::bson::{doc, Document};
use mongodb::options::ClientOptions;
use mongodb::Client;
use serde::Serialize;

use crate::error::{AppError, AppResult};
use crate::store::config::ConnectionConfig;

/// URI에 들어 있는 비밀번호를 떼어 낸다: `mongodb://u:p@h/` → (`mongodb://u@h/`, Some("p")).
/// 비밀번호는 퍼센트 디코딩해서 돌려준다.
pub fn split_password(uri: &str) -> (String, Option<String>) {
    let Some(scheme_end) = uri.find("://").map(|i| i + 3) else { return (uri.to_string(), None) };
    let rest = &uri[scheme_end..];
    // userinfo는 첫 '/' 또는 '?' 앞의 마지막 '@'까지
    let host_end = rest.find(['/', '?']).unwrap_or(rest.len());
    let Some(at) = rest[..host_end].rfind('@') else { return (uri.to_string(), None) };
    let userinfo = &rest[..at];
    let Some(colon) = userinfo.find(':') else { return (uri.to_string(), None) };
    let pw = pct_decode(&userinfo[colon + 1..]);
    let stripped = format!("{}{}{}", &uri[..scheme_end], &userinfo[..colon], &rest[at..]);
    (stripped, Some(pw))
}

fn pct_decode(s: &str) -> String {
    let b = s.as_bytes();
    let mut out = Vec::with_capacity(b.len());
    let mut i = 0;
    while i < b.len() {
        if b[i] == b'%' && i + 2 < b.len() {
            if let Some(v) = s.get(i + 1..i + 3).and_then(|h| u8::from_str_radix(h, 16).ok()) {
                out.push(v);
                i += 3;
                continue;
            }
        }
        out.push(b[i]);
        i += 1;
    }
    String::from_utf8_lossy(&out).into_owned()
}

#[derive(Serialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "lowercase")]
pub enum Topology {
    Standalone,
    ReplicaSet,
    Sharded,
}

impl Topology {
    /// 다중 문서 트랜잭션을 쓸 수 있는지
    pub fn supports_tx(self) -> bool {
        !matches!(self, Topology::Standalone)
    }
}

pub struct MongoConn {
    pub cfg: ConnectionConfig,
    pub client: Client,
    pub topology: Topology,
    /// URI의 기본 DB (없으면 None)
    pub default_db: Option<String>,
}

async fn options(cfg: &ConnectionConfig, pw: Option<&str>) -> AppResult<ClientOptions> {
    if cfg.mongo_uri.trim().is_empty() {
        return Err(AppError::user("연결 문자열(URI)이 비어 있습니다"));
    }
    let mut o = ClientOptions::parse(cfg.mongo_uri.trim()).await?;
    o.app_name = Some("data-connector".into());
    o.connect_timeout.get_or_insert(Duration::from_secs(10));
    o.server_selection_timeout.get_or_insert(Duration::from_secs(10));
    if let Some(pw) = pw.filter(|p| !p.is_empty()) {
        match o.credential.as_mut() {
            Some(c) if c.username.is_some() => c.password = Some(pw.to_string()),
            _ => return Err(AppError::user("비밀번호를 쓰려면 URI에 사용자 이름을 넣으세요 (mongodb://사용자@호스트/…)")),
        }
    }
    Ok(o)
}

/// 서버 선택 시간 초과는 드라이버 메시지가 길어서 요점만 보여 준다
fn friendly(e: mongodb::error::Error) -> AppError {
    if let mongodb::error::ErrorKind::ServerSelection { .. } = e.kind.as_ref() {
        let full = e.to_string();
        // 첫 서버 오류만 뽑는다 ("Error: Kind: I/O error: …, labels")
        let detail = full
            .split("Error: ")
            .nth(1)
            .map(|s| s.split(", labels").next().unwrap_or(s).trim_start_matches("Kind: ").to_string())
            .unwrap_or_default();
        return AppError::user(format!("MongoDB 서버에 연결하지 못했습니다 (서버 선택 시간 초과).{}", if detail.is_empty() { String::new() } else { format!("\n{detail}") }));
    }
    e.into()
}

async fn topology_of(client: &Client) -> AppResult<(Topology, String)> {
    let admin = client.database("admin");
    let hello = admin.run_command(doc! { "hello": 1 }).await.map_err(friendly)?;
    let topo = if hello.get_str("msg").ok() == Some("isdbgrid") {
        Topology::Sharded
    } else if hello.get_str("setName").is_ok() {
        Topology::ReplicaSet
    } else {
        Topology::Standalone
    };
    let version = admin
        .run_command(doc! { "buildInfo": 1 })
        .await
        .ok()
        .and_then(|d: Document| d.get_str("version").ok().map(str::to_string))
        .unwrap_or_else(|| "?".into());
    Ok((topo, version))
}

impl MongoConn {
    pub async fn open(cfg: ConnectionConfig, pw: Option<String>) -> AppResult<Self> {
        let o = options(&cfg, pw.as_deref()).await?;
        let default_db = o.default_database.clone();
        let client = Client::with_options(o)?;
        let (topology, _) = topology_of(&client).await?;
        Ok(Self { cfg, client, topology, default_db })
    }
}

/// 일회성 연결로 버전과 토폴로지를 돌려준다.
pub async fn test(cfg: &ConnectionConfig, pw: Option<&str>) -> AppResult<String> {
    let client = Client::with_options(options(cfg, pw).await?)?;
    let (topo, version) = topology_of(&client).await?;
    client.shutdown().await;
    let t = match topo {
        Topology::Standalone => "standalone (트랜잭션 없음)",
        Topology::ReplicaSet => "replica set",
        Topology::Sharded => "sharded",
    };
    Ok(format!("MongoDB {version} · {t}"))
}

/// 쓰기 명령 이름 (runCommand 첫 키, 소문자 비교). 읽기 전용 접속에서 거부한다.
const WRITE_COMMANDS: &[&str] = &[
    "insert", "update", "delete", "findandmodify", "drop", "dropdatabase", "create", "createindexes", "dropindexes",
    "renamecollection", "collmod", "convertToCapped", "clonecollectionascapped", "createuser", "dropuser", "updateuser",
    "grantrolestouser", "revokerolesfromuser", "createrole", "droprole", "applyops", "compact", "shutdown", "fsync",
    "setfeaturecompatibilityversion", "bulkwrite", "mapreduce",
];

pub fn is_write_command(cmd: &Document) -> bool {
    let Some(name) = cmd.keys().next() else { return false };
    let name = name.to_ascii_lowercase();
    if WRITE_COMMANDS.iter().any(|w| w.eq_ignore_ascii_case(&name)) {
        return true;
    }
    // aggregate의 $out / $merge 단계
    name == "aggregate" && cmd.get_array("pipeline").map(|p| pipeline_writes(p)).unwrap_or(false)
}

pub fn pipeline_writes(pipeline: &[mongodb::bson::Bson]) -> bool {
    pipeline.iter().any(|s| s.as_document().is_some_and(|d| d.contains_key("$out") || d.contains_key("$merge")))
}

#[cfg(test)]
mod tests {
    use super::*;
    use mongodb::bson::Bson;

    #[test]
    fn password_split() {
        assert_eq!(split_password("mongodb://u:p%40x@h1,h2/db?replicaSet=rs"), ("mongodb://u@h1,h2/db?replicaSet=rs".into(), Some("p@x".into())));
        assert_eq!(split_password("mongodb+srv://u@c.example.net/"), ("mongodb+srv://u@c.example.net/".into(), None));
        assert_eq!(split_password("mongodb://h/?x=a@b"), ("mongodb://h/?x=a@b".into(), None));
        assert_eq!(split_password("mongodb://a:b:c@h"), ("mongodb://a@h".into(), Some("b:c".into())));
    }

    #[test]
    fn write_detection() {
        assert!(is_write_command(&doc! { "drop": "x" }));
        assert!(is_write_command(&doc! { "findAndModify": "x" }));
        assert!(!is_write_command(&doc! { "find": "x" }));
        assert!(is_write_command(&doc! { "aggregate": "x", "pipeline": [ { "$match": {} }, { "$merge": "y" } ] }));
        assert!(!is_write_command(&doc! { "aggregate": "x", "pipeline": [ { "$match": {} } ] }));
        assert!(pipeline_writes(&[Bson::Document(doc! { "$out": "z" })]));
    }
}
