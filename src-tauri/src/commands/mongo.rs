use futures_util::TryStreamExt;
use mongodb::bson::{Bson, Document};
use mongodb::results::CollectionType;
use serde::Serialize;
use serde_json::Value;
use tauri::State;

use crate::error::{AppError, AppResult};
use crate::state::AppState;

/// 프론트에서 받은 Canonical Extended JSON 텍스트 → 문서 (빈 문자열은 빈 문서)
pub fn doc_from(text: &str, what: &str) -> AppResult<Document> {
    if text.trim().is_empty() {
        return Ok(Document::new());
    }
    let v: Value = serde_json::from_str(text)?;
    match Bson::try_from(v).map_err(|e| AppError::user(format!("{what}: {e}")))? {
        Bson::Document(d) => Ok(d),
        _ => Err(AppError::user(format!("{what}는 객체({{…}})여야 합니다"))),
    }
}

/// 문서 → Canonical Extended JSON (타입이 보존된다)
pub fn json_of(d: Document) -> Value {
    Bson::Document(d).into_canonical_extjson()
}

#[derive(Serialize)]
pub struct DbItem {
    pub name: String,
    pub size: u64,
}

#[tauri::command]
pub async fn mongo_dbs(state: State<'_, AppState>, conn_id: String) -> AppResult<Vec<DbItem>> {
    let m = state.mongo(&conn_id).await?;
    let list = match m.client.list_databases().await {
        Ok(l) => l.into_iter().map(|d| DbItem { name: d.name, size: d.size_on_disk }).collect(),
        // listDatabases 권한이 없으면 URI의 기본 DB만 보인다
        Err(e) => match &m.default_db {
            Some(db) => vec![DbItem { name: db.clone(), size: 0 }],
            None => return Err(e.into()),
        },
    };
    Ok(list)
}

#[derive(Serialize)]
pub struct CollItem {
    pub name: String,
    /// "collection" | "view" | "timeseries"
    pub kind: String,
    pub estimated: Option<u64>,
}

#[tauri::command]
pub async fn mongo_collections(state: State<'_, AppState>, conn_id: String, db: String) -> AppResult<Vec<CollItem>> {
    let m = state.mongo(&conn_id).await?;
    let database = m.client.database(&db);
    let specs: Vec<_> = database.list_collections().await?.try_collect().await?;
    let mut out = Vec::with_capacity(specs.len());
    for s in specs {
        let kind = match s.collection_type {
            CollectionType::View => "view",
            CollectionType::Timeseries => "timeseries",
            _ => "collection",
        };
        let estimated = if kind == "view" {
            None
        } else {
            database.collection::<Document>(&s.name).estimated_document_count().await.ok()
        };
        out.push(CollItem { name: s.name, kind: kind.into(), estimated });
    }
    out.sort_by(|a, b| a.name.cmp(&b.name));
    Ok(out)
}

#[derive(Serialize)]
pub struct MongoIndex {
    pub name: String,
    /// 키 문서 (Canonical EJSON)
    pub keys: Value,
    pub unique: bool,
    /// TTL 인덱스면 초
    pub ttl: Option<u64>,
    pub partial: bool,
}

#[tauri::command]
pub async fn mongo_indexes(state: State<'_, AppState>, conn_id: String, db: String, coll: String) -> AppResult<Vec<MongoIndex>> {
    let m = state.mongo(&conn_id).await?;
    let models: Vec<_> = m.client.database(&db).collection::<Document>(&coll).list_indexes().await?.try_collect().await?;
    Ok(models
        .into_iter()
        .map(|im| {
            let o = im.options.unwrap_or_default();
            MongoIndex {
                name: o.name.unwrap_or_default(),
                keys: json_of(im.keys),
                unique: o.unique.unwrap_or(false),
                ttl: o.expire_after.map(|d| d.as_secs()),
                partial: o.partial_filter_expression.is_some(),
            }
        })
        .collect())
}

#[derive(Serialize)]
pub struct FindPage {
    pub docs: Vec<Value>,
    pub has_more: bool,
}

/// 컬렉션 조회 (limit+1개를 읽어 다음 페이지가 있는지 판단). exec_id로 중지할 수 있다.
#[tauri::command]
#[allow(clippy::too_many_arguments)]
pub async fn mongo_find(
    state: State<'_, AppState>,
    conn_id: String,
    exec_id: String,
    db: String,
    coll: String,
    filter: String,
    sort: String,
    projection: String,
    skip: u64,
    limit: i64,
) -> AppResult<FindPage> {
    let m = state.mongo(&conn_id).await?;
    let c = m.client.database(&db).collection::<Document>(&coll);
    let filter = doc_from(&filter, "Filter")?;
    let sort = doc_from(&sort, "Sort")?;
    let projection = doc_from(&projection, "Projection")?;
    let limit = limit.clamp(1, 100_000);
    let fut = async move {
        let mut q = c.find(filter).skip(skip).limit(limit + 1);
        if !sort.is_empty() {
            q = q.sort(sort);
        }
        if !projection.is_empty() {
            q = q.projection(projection);
        }
        let mut docs: Vec<Document> = q.await?.try_collect().await?;
        let has_more = docs.len() as i64 > limit;
        docs.truncate(limit as usize);
        Ok(FindPage { docs: docs.into_iter().map(json_of).collect(), has_more })
    };
    state.abortable(&exec_id, fut).await
}

#[tauri::command]
pub async fn mongo_count(state: State<'_, AppState>, conn_id: String, db: String, coll: String, filter: String) -> AppResult<u64> {
    let m = state.mongo(&conn_id).await?;
    let filter = doc_from(&filter, "Filter")?;
    Ok(m.client.database(&db).collection::<Document>(&coll).count_documents(filter).await?)
}

// ── 콘솔 · Submit 작업 ────────────────────────────────────

/// 프론트 src/mongo/console.ts의 MongoOp과 같은 모양. 문서 값은 Canonical EJSON.
#[derive(serde::Deserialize, Debug, Clone)]
#[serde(tag = "kind", rename_all = "camelCase")]
pub enum MongoOp {
    Find { coll: String, filter: Value, projection: Value, sort: Value, skip: u64, limit: Option<i64> },
    Aggregate { coll: String, pipeline: Vec<Value> },
    CountDocuments { coll: String, filter: Value },
    EstimatedDocumentCount { coll: String },
    Distinct { coll: String, field: String, filter: Value },
    InsertOne { coll: String, doc: Value },
    InsertMany { coll: String, docs: Vec<Value> },
    UpdateOne { coll: String, filter: Value, update: Value, upsert: bool },
    UpdateMany { coll: String, filter: Value, update: Value, upsert: bool },
    ReplaceOne { coll: String, filter: Value, doc: Value, upsert: bool },
    DeleteOne { coll: String, filter: Value },
    DeleteMany { coll: String, filter: Value },
    RunCommand { command: Value },
    ShowDbs,
    ShowCollections,
    /// 프론트가 콘솔 DB를 바꾸는 데 쓴다 (백엔드에는 오지 않는다)
    Use {
        #[allow(dead_code)]
        db: String,
    },
}

fn to_doc(v: &Value, what: &str) -> AppResult<Document> {
    match Bson::try_from(v.clone()).map_err(|e| AppError::user(format!("{what}: {e}")))? {
        Bson::Document(d) => Ok(d),
        _ => Err(AppError::user(format!("{what}는 객체여야 합니다"))),
    }
}

/// update 인자: 문서({$set…}) 또는 파이프라인([…])
fn to_update(v: &Value) -> AppResult<mongodb::options::UpdateModifications> {
    Ok(match Bson::try_from(v.clone()).map_err(|e| AppError::user(e.to_string()))? {
        Bson::Document(d) => mongodb::options::UpdateModifications::Document(d),
        Bson::Array(a) => mongodb::options::UpdateModifications::Pipeline(
            a.into_iter().map(|b| b.as_document().cloned().ok_or_else(|| AppError::user("파이프라인 단계는 객체여야 합니다"))).collect::<AppResult<_>>()?,
        ),
        _ => return Err(AppError::user("변경 내용은 객체나 배열이어야 합니다")),
    })
}

impl MongoOp {
    fn is_write(&self) -> AppResult<bool> {
        Ok(match self {
            MongoOp::InsertOne { .. } | MongoOp::InsertMany { .. } | MongoOp::UpdateOne { .. } | MongoOp::UpdateMany { .. } | MongoOp::ReplaceOne { .. } | MongoOp::DeleteOne { .. } | MongoOp::DeleteMany { .. } => true,
            MongoOp::Aggregate { pipeline, .. } => {
                let p: Vec<Bson> = pipeline.iter().map(|v| Bson::try_from(v.clone()).unwrap_or(Bson::Null)).collect();
                crate::db::mongo::pipeline_writes(&p)
            }
            MongoOp::RunCommand { command } => crate::db::mongo::is_write_command(&to_doc(command, "명령")?),
            _ => false,
        })
    }
}

#[derive(Serialize)]
#[serde(tag = "t")]
pub enum MongoOut {
    Docs { docs: Vec<Value>, has_more: bool },
    Value { value: Value },
    Write { matched: u64, modified: u64, inserted: u64, deleted: u64, upserted: Option<Value> },
    Names { names: Vec<String> },
}

/// 커서에서 최대 n개 + 다음이 있는지
async fn take(mut cur: mongodb::Cursor<Document>, n: usize) -> AppResult<(Vec<Value>, bool)> {
    let mut out = Vec::new();
    while let Some(d) = cur.try_next().await? {
        if out.len() == n {
            return Ok((out, true));
        }
        out.push(json_of(d));
    }
    Ok((out, false))
}

async fn run_op(client: mongodb::Client, db: String, op: MongoOp, page: usize) -> AppResult<MongoOut> {
    let database = client.database(&db);
    let col = |name: &str| database.collection::<Document>(name);
    Ok(match op {
        MongoOp::Find { coll, filter, projection, sort, skip, limit } => {
            let c = col(&coll);
            let mut q = c.find(to_doc(&filter, "필터")?).skip(skip);
            let (sort, projection) = (to_doc(&sort, "정렬")?, to_doc(&projection, "프로젝션")?);
            if !sort.is_empty() {
                q = q.sort(sort);
            }
            if !projection.is_empty() {
                q = q.projection(projection);
            }
            let n = limit.map(|l| (l as usize).min(page)).unwrap_or(page);
            if let Some(l) = limit {
                q = q.limit(l);
            }
            let (docs, more) = take(q.await?, n).await?;
            MongoOut::Docs { docs, has_more: more }
        }
        MongoOp::Aggregate { coll, pipeline } => {
            let p = pipeline.iter().map(|v| to_doc(v, "파이프라인 단계")).collect::<AppResult<Vec<_>>>()?;
            let (docs, more) = take(col(&coll).aggregate(p).await?, page).await?;
            MongoOut::Docs { docs, has_more: more }
        }
        MongoOp::CountDocuments { coll, filter } => MongoOut::Value { value: Value::from(col(&coll).count_documents(to_doc(&filter, "필터")?).await?) },
        MongoOp::EstimatedDocumentCount { coll } => MongoOut::Value { value: Value::from(col(&coll).estimated_document_count().await?) },
        MongoOp::Distinct { coll, field, filter } => {
            let v = col(&coll).distinct(&field, to_doc(&filter, "필터")?).await?;
            MongoOut::Value { value: Bson::Array(v).into_canonical_extjson() }
        }
        MongoOp::InsertOne { coll, doc } => {
            let r = col(&coll).insert_one(to_doc(&doc, "문서")?).await?;
            MongoOut::Write { matched: 0, modified: 0, inserted: 1, deleted: 0, upserted: Some(r.inserted_id.into_canonical_extjson()) }
        }
        MongoOp::InsertMany { coll, docs } => {
            let d = docs.iter().map(|v| to_doc(v, "문서")).collect::<AppResult<Vec<_>>>()?;
            let r = col(&coll).insert_many(d).await?;
            MongoOut::Write { matched: 0, modified: 0, inserted: r.inserted_ids.len() as u64, deleted: 0, upserted: None }
        }
        MongoOp::UpdateOne { coll, filter, update, upsert } => {
            let r = col(&coll).update_one(to_doc(&filter, "필터")?, to_update(&update)?).upsert(upsert).await?;
            write_out(r.matched_count, r.modified_count, r.upserted_id)
        }
        MongoOp::UpdateMany { coll, filter, update, upsert } => {
            let r = col(&coll).update_many(to_doc(&filter, "필터")?, to_update(&update)?).upsert(upsert).await?;
            write_out(r.matched_count, r.modified_count, r.upserted_id)
        }
        MongoOp::ReplaceOne { coll, filter, doc, upsert } => {
            let r = col(&coll).replace_one(to_doc(&filter, "필터")?, to_doc(&doc, "새 문서")?).upsert(upsert).await?;
            write_out(r.matched_count, r.modified_count, r.upserted_id)
        }
        MongoOp::DeleteOne { coll, filter } => {
            let r = col(&coll).delete_one(to_doc(&filter, "필터")?).await?;
            MongoOut::Write { matched: 0, modified: 0, inserted: 0, deleted: r.deleted_count, upserted: None }
        }
        MongoOp::DeleteMany { coll, filter } => {
            let r = col(&coll).delete_many(to_doc(&filter, "필터")?).await?;
            MongoOut::Write { matched: 0, modified: 0, inserted: 0, deleted: r.deleted_count, upserted: None }
        }
        MongoOp::RunCommand { command } => MongoOut::Value { value: json_of(database.run_command(to_doc(&command, "명령")?).await?) },
        MongoOp::ShowDbs => MongoOut::Names { names: client.list_database_names().await? },
        MongoOp::ShowCollections => {
            let mut names = database.list_collection_names().await?;
            names.sort();
            MongoOut::Names { names }
        }
        MongoOp::Use { .. } => return Err(AppError::user("use는 콘솔이 처리합니다")),
    })
}

fn write_out(matched: u64, modified: u64, upserted: Option<Bson>) -> MongoOut {
    MongoOut::Write { matched, modified, inserted: 0, deleted: 0, upserted: upserted.map(Bson::into_canonical_extjson) }
}

/// 콘솔 실행. 읽기 전용 접속이면 쓰기 작업을 거부한다. exec_id로 중지할 수 있다.
#[tauri::command]
pub async fn mongo_exec(state: State<'_, AppState>, conn_id: String, exec_id: String, db: String, op: MongoOp, page_size: usize) -> AppResult<MongoOut> {
    let m = state.mongo(&conn_id).await?;
    if m.cfg.read_only && op.is_write()? {
        return Err(AppError::user("읽기 전용 접속에서는 쓰기 작업을 실행할 수 없습니다"));
    }
    let client = m.client.clone();
    state.abortable(&exec_id, run_op(client, db, op, page_size.clamp(1, 100_000))).await
}

/// 편집 반영. update/replace/delete는 정확히 1개 문서와 맞아야 한다.
/// 레플리카셋·sharded면 트랜잭션으로 묶고, standalone이면 차례로 실행하다 첫 실패에서 멈춘다.
#[tauri::command]
pub async fn mongo_submit(state: State<'_, AppState>, conn_id: String, db: String, ops: Vec<MongoOp>) -> AppResult<usize> {
    let m = state.mongo(&conn_id).await?;
    if m.cfg.read_only {
        return Err(AppError::user("읽기 전용 접속입니다"));
    }
    if ops.is_empty() {
        return Err(AppError::user("실행할 작업이 없습니다"));
    }
    let database = m.client.database(&db);
    let tx = m.topology.supports_tx();
    let mut session = m.client.start_session().await?;
    if tx {
        session.start_transaction().await?;
    }
    for (i, op) in ops.iter().enumerate() {
        let r = submit_one(&database, &mut session, op).await;
        let fail = match r {
            Ok(None) => None,
            Ok(Some(n)) => Some(if n == 0 { "대상 문서를 찾지 못했습니다(다른 곳에서 바뀌었거나 삭제됨).".to_string() } else { format!("{n}개 문서와 맞습니다.") }),
            Err(e) => Some(e.to_string()),
        };
        if let Some(msg) = fail {
            let tail = if tx {
                let _ = session.abort_transaction().await;
                "모든 변경을 롤백했습니다.".to_string()
            } else if i == 0 {
                "아무것도 반영하지 않았습니다.".to_string()
            } else {
                format!("standalone 서버라 롤백할 수 없습니다. 앞의 {i}개 작업은 반영됐습니다.")
            };
            return Err(AppError::Submit { message: format!("{}번째 작업: {msg}\n{tail}", i + 1), change_index: i, affected: 0 });
        }
    }
    if tx {
        session.commit_transaction().await?;
    }
    Ok(ops.len())
}

#[derive(Serialize, Clone)]
struct Progress<'a> {
    exec_id: &'a str,
    rows: u64,
}

/// find/aggregate 전체 결과를 JSON Lines(문서당 한 줄, Canonical EJSON)로 쓴다.
/// 임시 파일(.part)에 쓰고 성공하면 이름을 바꾼다. 대화상자를 취소하면 None.
#[tauri::command]
pub async fn mongo_export(
    app: tauri::AppHandle,
    state: State<'_, AppState>,
    conn_id: String,
    exec_id: String,
    db: String,
    op: MongoOp,
    file_name: String,
) -> AppResult<Option<crate::commands::export::ExportResult>> {
    use std::io::Write;
    use tauri::Emitter;
    let m = state.mongo(&conn_id).await?;
    if !matches!(op, MongoOp::Find { .. } | MongoOp::Aggregate { .. }) || op.is_write()? {
        return Err(AppError::user("find·aggregate(쓰기 단계 없음) 결과만 내보낼 수 있습니다"));
    }
    let Some(path) = crate::commands::edit::pick_path(&app, Some(file_name)).await? else { return Ok(None) };
    let part = path.with_extension("jsonl.part");
    let database = m.client.database(&db);
    let (part2, id2) = (part.clone(), exec_id.clone());
    let fut = async move {
        let cursor = match op {
            MongoOp::Find { coll, filter, projection, sort, skip, limit } => {
                let c = database.collection::<Document>(&coll);
                let mut q = c.find(to_doc(&filter, "필터")?).skip(skip);
                let (sort, projection) = (to_doc(&sort, "정렬")?, to_doc(&projection, "프로젝션")?);
                if !sort.is_empty() {
                    q = q.sort(sort);
                }
                if !projection.is_empty() {
                    q = q.projection(projection);
                }
                if let Some(l) = limit {
                    q = q.limit(l);
                }
                q.await?
            }
            MongoOp::Aggregate { coll, pipeline } => {
                let p = pipeline.iter().map(|v| to_doc(v, "파이프라인 단계")).collect::<AppResult<Vec<_>>>()?;
                database.collection::<Document>(&coll).aggregate(p).await?
            }
            _ => unreachable!(),
        };
        let mut cursor = cursor;
        let mut w = std::io::BufWriter::new(std::fs::File::create(&part2)?);
        let mut n: u64 = 0;
        while let Some(d) = cursor.try_next().await? {
            serde_json::to_writer(&mut w, &json_of(d))?;
            w.write_all(b"\n")?;
            n += 1;
            if n % 10_000 == 0 {
                let _ = app.emit("export-progress", Progress { exec_id: &id2, rows: n });
            }
        }
        w.flush()?;
        Ok(n)
    };
    match state.abortable(&exec_id, fut).await {
        Ok(rows) => {
            std::fs::rename(&part, &path)?;
            Ok(Some(crate::commands::export::ExportResult { path: path.to_string_lossy().into_owned(), rows }))
        }
        Err(e) => {
            let _ = std::fs::remove_file(&part);
            Err(e)
        }
    }
}

/// 실행하고, 정확히 1개와 맞아야 하는 작업이 아니면 맞은 개수를 돌려준다 (Some = 실패)
async fn submit_one(database: &mongodb::Database, s: &mut mongodb::ClientSession, op: &MongoOp) -> AppResult<Option<u64>> {
    let col = |name: &str| database.collection::<Document>(name);
    let n = match op {
        MongoOp::UpdateOne { coll, filter, update, .. } => col(coll).update_one(to_doc(filter, "필터")?, to_update(update)?).session(&mut *s).await?.matched_count,
        MongoOp::ReplaceOne { coll, filter, doc, .. } => col(coll).replace_one(to_doc(filter, "필터")?, to_doc(doc, "새 문서")?).session(&mut *s).await?.matched_count,
        MongoOp::DeleteOne { coll, filter } => col(coll).delete_one(to_doc(filter, "필터")?).session(&mut *s).await?.deleted_count,
        MongoOp::InsertOne { coll, doc } => {
            col(coll).insert_one(to_doc(doc, "문서")?).session(&mut *s).await?;
            1
        }
        _ => return Err(AppError::user("Submit에는 insertOne / updateOne / replaceOne / deleteOne만 쓸 수 있습니다")),
    };
    Ok(if n == 1 { None } else { Some(n) })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn ejson_round_trip_keeps_types() {
        let text = r#"{"i":{"$numberInt":"5"},"l":{"$numberLong":"9007199254740993"},"d":{"$numberDouble":"2.0"},
            "dec":{"$numberDecimal":"1.10"},"t":{"$date":{"$numberLong":"1577836800000"}},"o":{"$oid":"65f0a1b2c3d4e5f601234567"},
            "b":{"$binary":{"base64":"AQI=","subType":"00"}},"s":"x","n":null,"a":[{"$numberInt":"1"}]}"#;
        let d = doc_from(text, "t").unwrap();
        assert!(matches!(d.get("i"), Some(Bson::Int32(5))));
        assert!(matches!(d.get("l"), Some(Bson::Int64(9007199254740993))));
        assert!(matches!(d.get("d"), Some(Bson::Double(x)) if *x == 2.0));
        assert!(matches!(d.get("dec"), Some(Bson::Decimal128(_))));
        assert!(matches!(d.get("t"), Some(Bson::DateTime(_))));
        assert!(matches!(d.get("o"), Some(Bson::ObjectId(_))));
        assert!(matches!(d.get("b"), Some(Bson::Binary(_))));
        let back = json_of(d.clone());
        assert_eq!(doc_from(&back.to_string(), "t").unwrap(), d);
        assert!(doc_from("", "t").unwrap().is_empty());
        assert!(doc_from("[1]", "Filter").is_err());
    }

    #[test]
    fn op_shapes_match_frontend() {
        let ops: Vec<MongoOp> = serde_json::from_str(
            r#"[{"kind":"countDocuments","coll":"a","filter":{}},{"kind":"estimatedDocumentCount","coll":"a"},
                {"kind":"showDbs"},{"kind":"use","db":"x"},{"kind":"find","coll":"a","filter":{},"projection":{},"sort":{},"skip":0,"limit":null},
                {"kind":"updateOne","coll":"a","filter":{},"update":[{"$set":{"x":1}}],"upsert":false},
                {"kind":"aggregate","coll":"a","pipeline":[{"$merge":"b"}]},{"kind":"runCommand","command":{"drop":"a"}}]"#,
        )
        .unwrap();
        assert!(matches!(ops[0], MongoOp::CountDocuments { .. }));
        assert!(matches!(ops[2], MongoOp::ShowDbs));
        assert!(to_update(match &ops[5] { MongoOp::UpdateOne { update, .. } => update, _ => unreachable!() }).is_ok());
        assert!(!ops[4].is_write().unwrap());
        assert!(ops[5].is_write().unwrap());
        assert!(ops[6].is_write().unwrap());
        assert!(ops[7].is_write().unwrap());
    }
}
