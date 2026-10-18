use serde::Serialize;
use tauri::State;

use crate::db::redis::{argv_of, bytes_of, cmd_of, reply_of, Arg, Bytes, Reply};
use crate::error::{AppError, AppResult};
use crate::state::AppState;

#[derive(Serialize)]
pub struct DbInfo {
    pub db: u8,
    pub keys: u64,
}

/// "db0:keys=1,expires=0,avg_ttl=0" 줄들 → (db, keys)
pub fn parse_keyspace(info: &str) -> Vec<DbInfo> {
    info.lines()
        .filter_map(|l| {
            let (name, rest) = l.trim().split_once(':')?;
            let db = name.strip_prefix("db")?.parse().ok()?;
            let keys = rest.split(',').find_map(|kv| kv.strip_prefix("keys="))?.parse().ok()?;
            Some(DbInfo { db, keys })
        })
        .collect()
}

/// 키가 있는 논리 DB 목록. 접속 설정의 기본 DB는 비어 있어도 넣는다.
#[tauri::command]
pub async fn redis_dbs(state: State<'_, AppState>, conn_id: String) -> AppResult<Vec<DbInfo>> {
    let r = state.redis(&conn_id).await?;
    let mut c = r.shared(r.cfg.redis_db).await?;
    let info: String = redis::cmd("INFO").arg("keyspace").query_async(&mut c).await?;
    let mut list = parse_keyspace(&info);
    if !list.iter().any(|d| d.db == r.cfg.redis_db) {
        list.push(DbInfo { db: r.cfg.redis_db, keys: 0 });
    }
    list.sort_by_key(|d| d.db);
    Ok(list)
}

#[derive(Serialize)]
pub struct ScanKey {
    pub name: Bytes,
    #[serde(rename = "type")]
    pub kind: String,
}

#[derive(Serialize)]
pub struct ScanPage {
    /// 다음 커서 ("0"이면 끝). JS 숫자 정밀도를 넘을 수 있어 문자열로 준다.
    pub cursor: String,
    pub keys: Vec<ScanKey>,
}

/// SCAN을 count개가 모일 때까지 반복한다. 타입은 파이프라인으로 한 번에 묻는다.
#[tauri::command]
pub async fn redis_scan(state: State<'_, AppState>, conn_id: String, db: u8, cursor: String, pattern: String, count: usize) -> AppResult<ScanPage> {
    let r = state.redis(&conn_id).await?;
    let mut c = r.shared(db).await?;
    let mut cur: u64 = cursor.parse().unwrap_or(0);
    let want = count.clamp(1, 10_000);
    let pattern = if pattern.trim().is_empty() { "*".to_string() } else { pattern };
    let mut names: Vec<Vec<u8>> = Vec::new();
    loop {
        let (next, batch): (u64, Vec<Vec<u8>>) =
            redis::cmd("SCAN").arg(cur).arg("MATCH").arg(&pattern).arg("COUNT").arg(1000).query_async(&mut c).await?;
        names.extend(batch);
        cur = next;
        if cur == 0 || names.len() >= want {
            break;
        }
    }
    let mut pipe = redis::pipe();
    for n in &names {
        pipe.cmd("TYPE").arg(n.as_slice());
    }
    let kinds: Vec<String> = if names.is_empty() { vec![] } else { pipe.query_async(&mut c).await? };
    let keys = names.iter().zip(kinds).map(|(n, k)| ScanKey { name: bytes_of(n), kind: k }).collect();
    Ok(ScanPage { cursor: cur.to_string(), keys })
}

/// 키 삭제 (트리·탭에서). 읽기 전용 검사를 거친다.
#[tauri::command]
pub async fn redis_delete_key(state: State<'_, AppState>, conn_id: String, db: u8, key: Arg) -> AppResult<i64> {
    let r = state.redis(&conn_id).await?;
    let argv = argv_of(&[Arg::Text("DEL".into()), key])?;
    r.check(&argv)?;
    let mut c = r.shared(db).await?;
    Ok(crate::db::redis::cmd_of(&argv).query_async(&mut c).await?)
}

#[derive(Serialize)]
pub struct KeyInfo {
    /// "none"이면 키가 없다
    #[serde(rename = "type")]
    pub kind: String,
    /// 초 단위. -1 = 만료 없음, -2 = 키 없음
    pub ttl: i64,
    /// MEMORY USAGE (막혀 있으면 None)
    pub memory: Option<i64>,
    /// 문자열 길이 또는 원소 수
    pub length: Option<i64>,
}

#[tauri::command]
pub async fn redis_key_info(state: State<'_, AppState>, conn_id: String, db: u8, key: Arg) -> AppResult<KeyInfo> {
    let r = state.redis(&conn_id).await?;
    let mut c = r.shared(db).await?;
    let k = key.bytes()?;
    let kind: String = redis::cmd("TYPE").arg(&k).query_async(&mut c).await?;
    let ttl: i64 = redis::cmd("TTL").arg(&k).query_async(&mut c).await?;
    let memory: Option<i64> = redis::cmd("MEMORY").arg("USAGE").arg(&k).query_async(&mut c).await.ok().flatten();
    let len_cmd = match kind.as_str() {
        "string" => Some("STRLEN"),
        "hash" => Some("HLEN"),
        "list" => Some("LLEN"),
        "set" => Some("SCARD"),
        "zset" => Some("ZCARD"),
        "stream" => Some("XLEN"),
        _ => None,
    };
    let length = match len_cmd {
        Some(cmd) => redis::cmd(cmd).arg(&k).query_async(&mut c).await.ok(),
        None => None,
    };
    Ok(KeyInfo { kind, ttl, memory, length })
}

/// 문자열 값을 한 번에 읽는 최대 바이트 (넘으면 앞부분만 보이고 편집할 수 없다)
const MAX_STRING: i64 = 4 * 1024 * 1024;

#[derive(Serialize)]
pub struct ReadPage {
    /// 행: string=[value] / hash=[field,value] / list=[index,value] / set=[member] / zset=[member,score] / stream=[id,fields(JSON)]
    pub rows: Vec<Vec<Bytes>>,
    /// 다음 페이지 커서 ("0"이면 끝)
    pub cursor: String,
    /// string이 MAX_STRING보다 커서 잘렸는지
    pub truncated: bool,
}

fn pairs(flat: Vec<Vec<u8>>) -> Vec<Vec<Bytes>> {
    flat.chunks(2).map(|p| p.iter().map(|b| bytes_of(b)).collect()).collect()
}

/// SCAN 계열 명령을 count개가 모일 때까지 반복한다. 반환: (다음 커서, 평탄한 원소들)
async fn scan_all(c: &mut redis::aio::MultiplexedConnection, cmd: &str, key: &[u8], cursor: &str, count: usize, per_item: usize) -> AppResult<(String, Vec<Vec<u8>>)> {
    let mut cur: u64 = cursor.parse().unwrap_or(0);
    let mut out = Vec::new();
    loop {
        let (next, batch): (u64, Vec<Vec<u8>>) = redis::cmd(cmd).arg(key).arg(cur).arg("COUNT").arg(count.max(100)).query_async(c).await?;
        out.extend(batch);
        cur = next;
        if cur == 0 || out.len() / per_item >= count {
            break;
        }
    }
    Ok((cur.to_string(), out))
}

#[tauri::command]
pub async fn redis_read(state: State<'_, AppState>, conn_id: String, db: u8, key: Arg, kind: String, cursor: String, count: usize) -> AppResult<ReadPage> {
    let r = state.redis(&conn_id).await?;
    let mut c = r.shared(db).await?;
    let k = key.bytes()?;
    let count = count.clamp(1, 100_000);
    let mut truncated = false;
    let (rows, next) = match kind.as_str() {
        "string" => {
            let len: i64 = redis::cmd("STRLEN").arg(&k).query_async(&mut c).await?;
            let v: Vec<u8> = redis::cmd("GETRANGE").arg(&k).arg(0).arg(MAX_STRING - 1).query_async(&mut c).await?;
            truncated = len > MAX_STRING;
            (vec![vec![bytes_of(&v)]], "0".to_string())
        }
        "hash" => {
            let (next, flat) = scan_all(&mut c, "HSCAN", &k, &cursor, count, 2).await?;
            (pairs(flat), next)
        }
        "set" => {
            let (next, flat) = scan_all(&mut c, "SSCAN", &k, &cursor, count, 1).await?;
            (flat.iter().map(|m| vec![bytes_of(m)]).collect(), next)
        }
        "zset" => {
            let (next, flat) = scan_all(&mut c, "ZSCAN", &k, &cursor, count, 2).await?;
            (pairs(flat), next)
        }
        "list" => {
            let start: i64 = cursor.parse().unwrap_or(0);
            let items: Vec<Vec<u8>> = redis::cmd("LRANGE").arg(&k).arg(start).arg(start + count as i64 - 1).query_async(&mut c).await?;
            let next = if items.len() == count { (start + count as i64).to_string() } else { "0".to_string() };
            let rows = items.iter().enumerate().map(|(i, v)| vec![Bytes::Text((start + i as i64).to_string()), bytes_of(v)]).collect();
            (rows, next)
        }
        "stream" => {
            // 커서는 마지막으로 받은 ID. 다음 페이지는 그 ID 다음부터 (배타 범위 "(id")
            let start = if cursor == "0" || cursor.is_empty() { "-".to_string() } else { format!("({cursor}") };
            let entries: Vec<(String, Vec<(Vec<u8>, Vec<u8>)>)> =
                redis::cmd("XRANGE").arg(&k).arg(&start).arg("+").arg("COUNT").arg(count).query_async(&mut c).await?;
            let next = if entries.len() == count { entries.last().map(|e| e.0.clone()).unwrap_or_else(|| "0".into()) } else { "0".to_string() };
            let rows = entries
                .into_iter()
                .map(|(id, fields)| {
                    let obj: serde_json::Map<String, serde_json::Value> = fields
                        .iter()
                        .map(|(f, v)| (String::from_utf8_lossy(f).into_owned(), serde_json::Value::String(String::from_utf8_lossy(v).into_owned())))
                        .collect();
                    vec![Bytes::Text(id), Bytes::Text(serde_json::Value::Object(obj).to_string())]
                })
                .collect();
            (rows, next)
        }
        other => return Err(AppError::user(format!("{other} 타입은 콘솔에서 다루세요"))),
    };
    Ok(ReadPage { rows, cursor: next, truncated })
}

/// 명령 하나를 실행한다. console_id가 있으면 그 콘솔의 전용 연결, 없으면 공유 연결.
/// exec_id로 중지할 수 있다 (중지하면 콘솔 연결을 버려 서버 쪽 대기 명령도 끝낸다).
#[tauri::command]
pub async fn redis_exec(state: State<'_, AppState>, conn_id: String, console_id: Option<String>, db: u8, exec_id: String, argv: Vec<Arg>) -> AppResult<Reply> {
    let r = state.redis(&conn_id).await?;
    let argv = argv_of(&argv)?;
    r.check(&argv)?;
    let mut c = match &console_id {
        Some(id) => r.console(id, db).await?,
        None => r.shared(db).await?,
    };
    let fut = async move { Ok(reply_of(cmd_of(&argv).query_async::<redis::Value>(&mut c).await?)) };
    let res = state.abortable(&exec_id, fut).await;
    if res.is_err() {
        // 중지됐거나 연결 오류면 다음 실행에서 새로 연다
        if let Some(id) = &console_id {
            r.drop_console(id).await;
        }
    }
    res
}

#[derive(serde::Deserialize)]
pub struct Expect {
    #[serde(rename = "type")]
    pub kind: String,
    pub length: Option<i64>,
}

/// 편집 반영: 전용 연결에서 WATCH → (읽을 때와 타입·길이가 같은지 확인) → MULTI → 명령들 → EXEC.
/// 그 사이 다른 곳에서 키가 바뀌면 EXEC가 nil이 되어 아무것도 반영되지 않는다.
/// Redis는 EXEC 안에서 실패한 명령을 롤백하지 않는다 → 실패한 명령 번호를 알려 준다.
#[tauri::command]
pub async fn redis_submit(state: State<'_, AppState>, conn_id: String, db: u8, key: Arg, expect: Expect, commands: Vec<Vec<Arg>>) -> AppResult<usize> {
    let r = state.redis(&conn_id).await?;
    if r.cfg.read_only {
        return Err(AppError::user("읽기 전용 접속입니다"));
    }
    if commands.is_empty() {
        return Err(AppError::user("실행할 명령이 없습니다"));
    }
    let k = key.bytes()?;
    let cmds = commands.iter().map(|a| argv_of(a)).collect::<AppResult<Vec<_>>>()?;
    let mut c = r.dedicated(db).await?;
    redis::cmd("WATCH").arg(&k).query_async::<()>(&mut c).await?;
    let kind: String = redis::cmd("TYPE").arg(&k).query_async(&mut c).await?;
    let len_cmd = match kind.as_str() {
        "string" => "STRLEN",
        "hash" => "HLEN",
        "list" => "LLEN",
        "set" => "SCARD",
        "zset" => "ZCARD",
        _ => "EXISTS",
    };
    let len: i64 = redis::cmd(len_cmd).arg(&k).query_async(&mut c).await?;
    let same = (kind == expect.kind || (expect.kind == "none" && kind == "none")) && expect.length.map_or(true, |l| l == len);
    if !same {
        let _ = redis::cmd("UNWATCH").query_async::<()>(&mut c).await;
        return Err(AppError::user("키를 읽은 뒤 다른 곳에서 바뀌었습니다(타입이나 길이가 다름). 반영하지 않았습니다. 다시 읽으세요."));
    }
    let mut pipe = redis::pipe();
    // 실패한 명령도 응답 목록에 담아 몇 번째가 실패했는지 알린다
    pipe.atomic().ignore_errors();
    for argv in &cmds {
        pipe.add_command(cmd_of(argv));
    }
    let res: Option<Vec<redis::Value>> = pipe.query_async(&mut c).await?;
    let Some(replies) = res else {
        return Err(AppError::user("반영하는 사이 다른 곳에서 키가 바뀌어 반영하지 않았습니다. 다시 읽으세요."));
    };
    if let Some((i, e)) = replies.iter().enumerate().find_map(|(i, v)| match v {
        redis::Value::ServerError(e) => Some((i, e.to_string())),
        _ => None,
    }) {
        return Err(AppError::Submit {
            message: format!("{}번째 명령이 실패했습니다: {e}\nRedis는 롤백하지 않으므로 나머지 명령은 반영됐습니다. 다시 읽어 확인하세요.", i + 1),
            change_index: i,
            affected: 0,
        });
    }
    Ok(cmds.len())
}

/// 콘솔 탭을 닫을 때 전용 연결을 정리한다
#[tauri::command]
pub async fn redis_close_console(state: State<'_, AppState>, conn_id: String, console_id: String) -> AppResult<()> {
    if let Ok(r) = state.redis(&conn_id).await {
        r.drop_console(&console_id).await;
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn keyspace() {
        let info = "# Keyspace\r\ndb0:keys=1204,expires=3,avg_ttl=0\r\ndb3:keys=12,expires=0,avg_ttl=0\r\n";
        let v = parse_keyspace(info);
        assert_eq!(v.iter().map(|d| (d.db, d.keys)).collect::<Vec<_>>(), [(0, 1204), (3, 12)]);
    }
}
