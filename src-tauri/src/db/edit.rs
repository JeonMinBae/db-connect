//! 그리드 보류 변경을 하나의 트랜잭션으로 반영한다.

use serde::Deserialize;
use sqlx::Executor;

use crate::db::pool::AnyConn;
use crate::error::{AppError, AppResult};
use crate::store::config::Driver;

#[derive(Deserialize, Debug, Clone)]
pub struct ColRef {
    pub name: String,
    #[serde(default)]
    pub full_type: String,
}

#[derive(Deserialize, Debug, Clone)]
pub struct Val {
    pub col: ColRef,
    pub value: Option<String>,
}

#[derive(Deserialize, Debug, Clone, Copy, PartialEq, Eq)]
#[serde(rename_all = "camelCase")]
pub enum KeyMode {
    Pk,
    Unique,
    AllColumns,
}

#[derive(Deserialize, Debug, Clone)]
#[serde(tag = "op", rename_all = "lowercase")]
pub enum Change {
    Update { key: Vec<Val>, set: Vec<Val> },
    Delete { key: Vec<Val> },
    Insert { values: Vec<Val> },
}

#[derive(Deserialize, Debug)]
pub struct SubmitRequest {
    pub conn_id: String,
    pub console_id: Option<String>,
    pub schema: Option<String>,
    pub table: String,
    pub key_mode: KeyMode,
    /// 순서대로 실행한다 (프론트에서 DELETE → UPDATE → INSERT 순으로 보낸다)
    pub changes: Vec<Change>,
}

pub struct Planned {
    pub sql: String,
    pub binds: Vec<Option<String>>,
    /// UPDATE/DELETE는 정확히 1행에 영향을 줘야 한다
    pub expect_one: bool,
}

pub fn quote_ident(d: Driver, s: &str) -> String {
    match d {
        Driver::Mysql => format!("`{}`", s.replace('`', "``")),
        _ => format!("\"{}\"", s.replace('"', "\"\"")),
    }
}

fn table_ref(d: Driver, schema: Option<&str>, table: &str) -> String {
    match schema.filter(|s| !s.is_empty() && d != Driver::Sqlite) {
        Some(s) => format!("{}.{}", quote_ident(d, s), quote_ident(d, table)),
        None => quote_ident(d, table),
    }
}

struct Builder {
    driver: Driver,
    binds: Vec<Option<String>>,
    /// 미리보기용: 자리표시자 대신 리터럴을 넣는다
    inline: bool,
}

/// SQL 문자열 리터럴. MySQL은 기본 모드에서 백슬래시도 이스케이프 문자다.
pub fn literal(d: Driver, v: Option<&str>) -> String {
    match v {
        None => "NULL".into(),
        Some(s) if d == Driver::Mysql => format!("'{}'", s.replace('\\', "\\\\").replace('\'', "''")),
        Some(s) => format!("'{}'", s.replace('\'', "''")),
    }
}

impl Builder {
    fn placeholder(&mut self, v: Option<String>) -> String {
        if self.inline {
            return literal(self.driver, v.as_deref());
        }
        self.binds.push(v);
        match self.driver {
            Driver::Postgres => format!("${}", self.binds.len()),
            _ => "?".to_string(),
        }
    }

    /// 대입 값: PG는 컬럼 타입으로 캐스팅한다(텍스트 파라미터를 int/json/enum 등에 넣기 위해)
    fn value(&mut self, v: &Val) -> AppResult<String> {
        let p = self.placeholder(v.value.clone());
        Ok(match self.driver {
            Driver::Postgres if !v.col.full_type.is_empty() => format!("{p}::{}", checked_type(&v.col.full_type)?),
            _ => p,
        })
    }

    /// 키 비교식. allColumns 모드는 텍스트 표현끼리 비교한다(json 등 등호가 없는 타입 대비).
    fn key_cond(&mut self, v: &Val, mode: KeyMode) -> AppResult<String> {
        let col = quote_ident(self.driver, &v.col.name);
        let Some(val) = v.value.clone() else { return Ok(format!("{col} IS NULL")) };
        let p = self.placeholder(Some(val));
        let ty = checked_type(&v.col.full_type)?;
        Ok(match (self.driver, mode) {
            // char(n)은 ::text 캐스트가 뒤 공백을 지우므로 패딩된 결과 텍스트와 bpchar끼리 비교한다
            (Driver::Postgres, KeyMode::AllColumns) if ty.starts_with("character(") || ty == "character" => {
                format!("{col} = {p}::bpchar")
            }
            (Driver::Postgres, KeyMode::AllColumns) => format!("{col}::text = {p}"),
            (Driver::Postgres, _) if !ty.is_empty() => format!("{col} = {p}::{ty}"),
            (Driver::Mysql, KeyMode::AllColumns) => format!("CAST({col} AS CHAR) COLLATE utf8mb4_bin = {p}"),
            // SQLite는 컬럼 친화도로 텍스트 파라미터를 변환해 비교한다 (REAL 표기 차이 없음)
            _ => format!("{col} = {p}"),
        })
    }

    fn where_clause(&mut self, key: &[Val], mode: KeyMode) -> AppResult<String> {
        if key.is_empty() {
            return Err(AppError::user("행을 식별할 키가 없습니다"));
        }
        Ok(key.iter().map(|k| self.key_cond(k, mode)).collect::<AppResult<Vec<_>>>()?.join(" AND "))
    }
}

/// SQL 본문에 그대로 넣는 타입 이름(PG 캐스트용)은 타입 표기에 쓰이는 문자만 허용한다.
fn checked_type(t: &str) -> AppResult<&str> {
    if t.chars().all(|c| c.is_alphanumeric() || " _.,()[]\"".contains(c)) && !t.contains("--") {
        Ok(t)
    } else {
        Err(AppError::user(format!("허용되지 않는 타입 이름: {t}")))
    }
}

/// MySQL 비트랜잭션 엔진(MyISAM 등)은 롤백이 안 되므로, 여러 행이 맞아도 최대 2행만 바뀌게 한다.
/// (2행이면 영향 행 수 검사로 감지된다)
fn one_row_limit(d: Driver) -> &'static str {
    if d == Driver::Mysql {
        " LIMIT 2"
    } else {
        ""
    }
}

pub fn plan(driver: Driver, req: &SubmitRequest) -> AppResult<Vec<Planned>> {
    plan_with(driver, req, false)
}

/// Submit 미리보기: 값을 리터럴로 넣은 SQL. 바인딩 실행과 같은 식(캐스트·비교 방식)을 쓴다.
pub fn preview(driver: Driver, req: &SubmitRequest) -> AppResult<Vec<RawStmt>> {
    Ok(plan_with(driver, req, true)?.into_iter().map(|p| RawStmt { sql: p.sql, expect_one: p.expect_one }).collect())
}

/// 미리보기 모달에서 사용자가 고친 문장
#[derive(Deserialize, serde::Serialize, Debug, Clone)]
pub struct RawStmt {
    pub sql: String,
    /// UPDATE/DELETE: 정확히 1행에 영향을 줘야 한다
    pub expect_one: bool,
}

fn plan_with(driver: Driver, req: &SubmitRequest, inline: bool) -> AppResult<Vec<Planned>> {
    let t = table_ref(driver, req.schema.as_deref(), &req.table);
    let mut out = Vec::with_capacity(req.changes.len());
    for ch in &req.changes {
        let mut b = Builder { driver, binds: vec![], inline };
        let (sql, expect_one) = match ch {
            Change::Update { key, set } => {
                if set.is_empty() {
                    return Err(AppError::user("변경할 값이 없습니다"));
                }
                let sets = set
                    .iter()
                    .map(|v| Ok(format!("{} = {}", quote_ident(driver, &v.col.name), b.value(v)?)))
                    .collect::<AppResult<Vec<_>>>()?
                    .join(", ");
                let w = b.where_clause(key, req.key_mode)?;
                (format!("UPDATE {t} SET {sets} WHERE {w}{}", one_row_limit(driver)), true)
            }
            Change::Delete { key } => {
                let w = b.where_clause(key, req.key_mode)?;
                (format!("DELETE FROM {t} WHERE {w}{}", one_row_limit(driver)), true)
            }
            Change::Insert { values } => {
                if values.is_empty() {
                    let sql = match driver {
                        Driver::Mysql => format!("INSERT INTO {t} () VALUES ()"),
                        _ => format!("INSERT INTO {t} DEFAULT VALUES"),
                    };
                    (sql, false)
                } else {
                    let cols = values.iter().map(|v| quote_ident(driver, &v.col.name)).collect::<Vec<_>>().join(", ");
                    let vals = values.iter().map(|v| b.value(v)).collect::<AppResult<Vec<_>>>()?.join(", ");
                    (format!("INSERT INTO {t} ({cols}) VALUES ({vals})"), false)
                }
            }
        };
        out.push(Planned { sql, binds: b.binds, expect_one });
    }
    Ok(out)
}

/// 파일 경로는 프론트에서 받지 않고 백엔드가 대화상자로 직접 고른다 (웹뷰가 임의 경로를 읽고 쓰지 못하게)
#[derive(Deserialize, Debug)]
pub struct BlobRequest {
    pub conn_id: String,
    pub console_id: Option<String>,
    pub schema: Option<String>,
    pub table: String,
    pub key_mode: KeyMode,
    pub key: Vec<Val>,
    pub column: String,
}

/// 키 조건만 만든다. reserve = 앞에 먼저 바인딩할 값의 개수 (PG $n 번호용)
fn where_only(driver: Driver, mode: KeyMode, key: &[Val], reserve: usize) -> AppResult<(String, Vec<Option<String>>)> {
    let mut b = Builder { driver, binds: vec![None; reserve], inline: false };
    let w = b.where_clause(key, mode)?;
    Ok((w, b.binds.split_off(reserve)))
}

macro_rules! blob_read {
    ($c:expr, $sql:expr, $binds:expr) => {{
        let mut q = sqlx::query(&$sql);
        for v in $binds {
            q = q.bind(v);
        }
        let rows = (&mut **$c).fetch_all(q).await?;
        if rows.len() != 1 {
            return Err(AppError::user(format!("대상 행이 {}개입니다", rows.len())));
        }
        sqlx::Row::try_get::<Option<Vec<u8>>, _>(&rows[0], 0)?
    }};
}

/// 셀의 바이너리 값을 파일로 저장한다. 반환값은 바이트 수.
pub async fn read_blob(conn: &mut AnyConn<'_>, driver: Driver, req: &BlobRequest, path: &std::path::Path) -> AppResult<u64> {
    let (w, binds) = where_only(driver, req.key_mode, &req.key, 0)?;
    let sql = format!("SELECT {} FROM {} WHERE {w}", quote_ident(driver, &req.column), table_ref(driver, req.schema.as_deref(), &req.table));
    let bytes: Option<Vec<u8>> = match conn {
        AnyConn::Pg(c) => blob_read!(c, sql, binds),
        AnyConn::My(c) => blob_read!(c, sql, binds),
        AnyConn::Lite(c) => blob_read!(c, sql, binds),
    };
    let bytes = bytes.unwrap_or_default();
    crate::store::files::write_atomic(path, &bytes)?;
    Ok(bytes.len() as u64)
}

macro_rules! blob_write {
    ($c:expr, $sql:expr, $bytes:expr, $binds:expr) => {{
        let mut q = sqlx::query(&$sql).bind($bytes);
        for v in $binds {
            q = q.bind(v);
        }
        (&mut **$c).execute(q).await?.rows_affected()
    }};
}

async fn exec_blob(conn: &mut AnyConn<'_>, sql: &str, bytes: Vec<u8>, binds: Vec<Option<String>>) -> AppResult<u64> {
    Ok(match conn {
        AnyConn::Pg(c) => blob_write!(c, sql, bytes, binds),
        AnyConn::My(c) => blob_write!(c, sql, bytes, binds),
        AnyConn::Lite(c) => blob_write!(c, sql, bytes, binds),
    })
}

/// BEGIN/COMMIT/ROLLBACK 또는 Manual 트랜잭션 안이면 SAVEPOINT 문장들
fn tx_statements(in_tx: bool) -> (&'static str, &'static str, &'static str) {
    if in_tx {
        ("SAVEPOINT dbc_submit", "RELEASE SAVEPOINT dbc_submit", "ROLLBACK TO SAVEPOINT dbc_submit")
    } else {
        ("BEGIN", "COMMIT", "ROLLBACK")
    }
}

/// 본문 결과에 따라 커밋하거나 롤백한다. (시작은 호출하는 쪽에서 tx_statements().0으로 한다)
async fn finish_tx<T>(conn: &mut AnyConn<'_>, in_tx: bool, body: AppResult<T>) -> AppResult<T> {
    let (_, commit, rollback) = tx_statements(in_tx);
    let result = match body {
        Ok(v) => conn.execute_raw(commit).await.map(|_| v),
        Err(e) => Err(e),
    };
    if result.is_err() {
        let _ = conn.execute_raw(rollback).await;
        if in_tx {
            let _ = conn.execute_raw("RELEASE SAVEPOINT dbc_submit").await;
        }
    }
    result
}

/// 파일 내용을 셀에 쓴다. 정확히 1행에 영향을 주지 않으면 롤백한다.
pub async fn write_blob(conn: &mut AnyConn<'_>, driver: Driver, req: &BlobRequest, path: &std::path::Path, in_tx: bool) -> AppResult<u64> {
    let bytes = std::fs::read(path)?;
    let size = bytes.len() as u64;
    let (w, binds) = where_only(driver, req.key_mode, &req.key, 1)?;
    let p1 = if driver == Driver::Postgres { "$1" } else { "?" };
    let sql = format!(
        "UPDATE {} SET {} = {p1} WHERE {w}{}",
        table_ref(driver, req.schema.as_deref(), &req.table),
        quote_ident(driver, &req.column),
        one_row_limit(driver)
    );
    conn.execute_raw(tx_statements(in_tx).0).await?;
    let body = match exec_blob(conn, &sql, bytes, binds).await {
        Ok(1) => Ok(size),
        Ok(affected) => Err(AppError::Submit { message: format!("영향 행 수가 {affected}개여서 롤백했습니다."), change_index: 0, affected }),
        Err(e) => Err(e),
    };
    finish_tx(conn, in_tx, body).await
}

macro_rules! exec_planned {
    ($c:expr, $p:expr) => {{
        let mut q = sqlx::query(&$p.sql);
        for v in &$p.binds {
            q = q.bind(v.clone());
        }
        (&mut **$c).execute(q).await?.rows_affected()
    }};
}

async fn run_planned(conn: &mut AnyConn<'_>, planned: &[Planned]) -> AppResult<()> {
    for (i, p) in planned.iter().enumerate() {
        let affected = match conn {
            AnyConn::Pg(c) => exec_planned!(c, p),
            AnyConn::My(c) => exec_planned!(c, p),
            AnyConn::Lite(c) => exec_planned!(c, p),
        };
        check_affected(i, p.expect_one, affected)?;
    }
    Ok(())
}

fn check_affected(i: usize, expect_one: bool, affected: u64) -> AppResult<()> {
    if !expect_one || affected == 1 {
        return Ok(());
    }
    Err(AppError::Submit {
        message: if affected == 0 {
            "대상 행을 찾지 못했습니다(다른 곳에서 바뀌었거나 삭제됨). 모든 변경을 롤백했습니다.".into()
        } else {
            format!("{affected}개 행이 함께 변경될 수 있어 모든 변경을 롤백했습니다.")
        },
        change_index: i,
        affected,
    })
}

/// in_tx = 이미 열린 트랜잭션(Manual 모드) 안이면 SAVEPOINT로 감싸고 커밋하지 않는다.
pub async fn submit(conn: &mut AnyConn<'_>, driver: Driver, req: &SubmitRequest, in_tx: bool) -> AppResult<()> {
    let planned = plan(driver, req)?;
    conn.execute_raw(tx_statements(in_tx).0).await?;
    let body = run_planned(conn, &planned).await;
    finish_tx(conn, in_tx, body).await
}

/// 미리보기에서 고친 SQL을 하나의 트랜잭션으로 실행한다. 영향 행 검사 규칙은 submit과 같다.
pub async fn submit_raw(conn: &mut AnyConn<'_>, stmts: &[RawStmt], in_tx: bool) -> AppResult<()> {
    conn.execute_raw(tx_statements(in_tx).0).await?;
    let mut body = Ok(());
    for (i, s) in stmts.iter().enumerate() {
        body = match conn.execute_raw(&s.sql).await {
            Ok(affected) => check_affected(i, s.expect_one, affected),
            Err(e) => Err(AppError::Submit { message: format!("{e}\n모든 변경을 롤백했습니다."), change_index: i, affected: 0 }),
        };
        if body.is_err() {
            break;
        }
    }
    finish_tx(conn, in_tx, body).await
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;

    fn col(name: &str, ty: &str) -> ColRef {
        ColRef { name: name.into(), full_type: ty.into() }
    }
    fn v(name: &str, ty: &str, value: Option<&str>) -> Val {
        Val { col: col(name, ty), value: value.map(str::to_owned) }
    }
    fn req(mode: KeyMode, changes: Vec<Change>) -> SubmitRequest {
        SubmitRequest { conn_id: "c".into(), console_id: None, schema: Some("public".into()), table: "t".into(), key_mode: mode, changes }
    }

    #[test]
    fn pg_sql() {
        let r = req(
            KeyMode::Pk,
            vec![Change::Update { key: vec![v("id", "integer", Some("1"))], set: vec![v("j", "jsonb", Some("{}")), v("n", "text", None)] }],
        );
        let p = plan(Driver::Postgres, &r).unwrap();
        assert_eq!(p[0].sql, r#"UPDATE "public"."t" SET "j" = $1::jsonb, "n" = $2::text WHERE "id" = $3::integer"#);
        assert_eq!(p[0].binds, vec![Some("{}".into()), None, Some("1".into())]);

        let r = req(KeyMode::AllColumns, vec![Change::Delete { key: vec![v("a", "json", Some("{}")), v("b", "text", None)] }]);
        assert_eq!(plan(Driver::Postgres, &r).unwrap()[0].sql, r#"DELETE FROM "public"."t" WHERE "a"::text = $1 AND "b" IS NULL"#);
    }

    #[test]
    fn mysql_and_sqlite_sql() {
        let r = req(KeyMode::AllColumns, vec![Change::Delete { key: vec![v("a`b", "", Some("x"))] }]);
        assert_eq!(plan(Driver::Mysql, &r).unwrap()[0].sql, "DELETE FROM `public`.`t` WHERE CAST(`a``b` AS CHAR) COLLATE utf8mb4_bin = ? LIMIT 2");
        assert_eq!(plan(Driver::Sqlite, &r).unwrap()[0].sql, r#"DELETE FROM "t" WHERE "a`b" = ?"#);
        let r = req(KeyMode::Pk, vec![Change::Insert { values: vec![] }]);
        assert_eq!(plan(Driver::Mysql, &r).unwrap()[0].sql, "INSERT INTO `public`.`t` () VALUES ()");
        assert_eq!(plan(Driver::Sqlite, &r).unwrap()[0].sql, r#"INSERT INTO "t" DEFAULT VALUES"#);
    }

    #[test]
    fn pg_bpchar_and_type_check() {
        let r = req(KeyMode::AllColumns, vec![Change::Delete { key: vec![v("c", "character(5)", Some("ab   "))] }]);
        assert_eq!(plan(Driver::Postgres, &r).unwrap()[0].sql, r#"DELETE FROM "public"."t" WHERE "c" = $1::bpchar"#);
        let bad = req(KeyMode::Pk, vec![Change::Delete { key: vec![v("id", "int; DROP TABLE t", Some("1"))] }]);
        assert!(plan(Driver::Postgres, &bad).is_err());
        let ok = req(KeyMode::Pk, vec![Change::Delete { key: vec![v("id", "\"my schema\".mood[]", Some("1"))] }]);
        assert!(plan(Driver::Postgres, &ok).is_ok());
    }

    async fn db() -> sqlx::SqliteConnection {
        let mut c = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, qty INTEGER);
             INSERT INTO t VALUES (1, 'a', 1), (2, 'b', 2);
             CREATE TABLE np (label TEXT, qty INTEGER);
             INSERT INTO np VALUES ('apple', 3), ('apple', 3), ('kiwi', NULL);",
        )
        .execute(&mut c)
        .await
        .unwrap();
        c
    }

    async fn rows(c: &mut sqlx::SqliteConnection, sql: &str) -> Vec<(String,)> {
        sqlx::query_as(sql).fetch_all(c).await.unwrap()
    }

    #[tokio::test]
    async fn sqlite_submit_ok() {
        let mut c = db().await;
        let r = req(
            KeyMode::Pk,
            vec![
                Change::Delete { key: vec![v("id", "", Some("2"))] },
                Change::Update { key: vec![v("id", "", Some("1"))], set: vec![v("name", "", Some("A")), v("qty", "", None)] },
                Change::Insert { values: vec![v("name", "", Some("new")), v("qty", "", Some("7"))] },
            ],
        );
        submit(&mut AnyConn::Lite(&mut c), Driver::Sqlite, &r, false).await.unwrap();
        let got = rows(&mut c, "SELECT id || ':' || name || ':' || coalesce(qty, 'null') FROM t ORDER BY id").await;
        assert_eq!(got, vec![("1:A:null".into(),), ("2:new:7".into(),)]);
    }

    #[tokio::test]
    async fn sqlite_submit_rolls_back_on_multi_match() {
        let mut c = db().await;
        let mut r = req(
            KeyMode::AllColumns,
            vec![
                Change::Update { key: vec![v("label", "", Some("kiwi")), v("qty", "", None)], set: vec![v("qty", "", Some("9"))] },
                Change::Update { key: vec![v("label", "", Some("apple")), v("qty", "", Some("3"))], set: vec![v("qty", "", Some("4"))] },
            ],
        );
        r.table = "np".into();
        let err = submit(&mut AnyConn::Lite(&mut c), Driver::Sqlite, &r, false).await.unwrap_err();
        match err {
            AppError::Submit { change_index, affected, .. } => assert_eq!((change_index, affected), (1, 2)),
            e => panic!("unexpected {e:?}"),
        }
        // 첫 번째(성공한) 변경도 롤백되어야 한다
        let got = rows(&mut c, "SELECT label || ':' || coalesce(qty, 'null') FROM np ORDER BY rowid").await;
        assert_eq!(got, vec![("apple:3".into(),), ("apple:3".into(),), ("kiwi:null".into(),)]);
    }

    #[tokio::test]
    async fn sqlite_submit_zero_match_and_savepoint() {
        let mut c = db().await;
        let missing = req(KeyMode::Pk, vec![Change::Delete { key: vec![v("id", "", Some("99"))] }]);
        assert!(matches!(
            submit(&mut AnyConn::Lite(&mut c), Driver::Sqlite, &missing, false).await,
            Err(AppError::Submit { affected: 0, .. })
        ));
        // 이미 열린 트랜잭션 안: SAVEPOINT 사용, 커밋하지 않음
        sqlx::raw_sql("BEGIN").execute(&mut c).await.unwrap();
        let ok = req(KeyMode::Pk, vec![Change::Update { key: vec![v("id", "", Some("1"))], set: vec![v("name", "", Some("Z"))] }]);
        submit(&mut AnyConn::Lite(&mut c), Driver::Sqlite, &ok, true).await.unwrap();
        assert!(submit(&mut AnyConn::Lite(&mut c), Driver::Sqlite, &missing, true).await.is_err());
        sqlx::raw_sql("ROLLBACK").execute(&mut c).await.unwrap();
        assert_eq!(rows(&mut c, "SELECT name FROM t WHERE id = 1").await, vec![("a".into(),)]);
    }

    #[test]
    fn preview_inlines_literals() {
        let r = req(
            KeyMode::Pk,
            vec![Change::Update { key: vec![v("id", "integer", Some("1"))], set: vec![v("n", "text", Some(r"it's \x")), v("m", "text", None)] }],
        );
        let pg = preview(Driver::Postgres, &r).unwrap();
        assert_eq!(pg[0].sql, r#"UPDATE "public"."t" SET "n" = 'it''s \x'::text, "m" = NULL::text WHERE "id" = '1'::integer"#);
        assert!(pg[0].expect_one);
        let my = preview(Driver::Mysql, &r).unwrap();
        assert_eq!(my[0].sql, r"UPDATE `public`.`t` SET `n` = 'it''s \\x', `m` = NULL WHERE `id` = '1' LIMIT 2");
    }

    #[tokio::test]
    async fn sqlite_submit_raw() {
        let mut c = db().await;
        // 미리보기 SQL을 그대로 실행하면 바인딩 실행과 같은 결과
        let r = req(KeyMode::Pk, vec![Change::Update { key: vec![v("id", "", Some("1"))], set: vec![v("name", "", Some("it's"))] }]);
        let stmts = preview(Driver::Sqlite, &r).unwrap();
        submit_raw(&mut AnyConn::Lite(&mut c), &stmts, false).await.unwrap();
        assert_eq!(rows(&mut c, "SELECT name FROM t WHERE id = 1").await, vec![("it's".into(),)]);
        // 고친 문장이 2행을 바꾸면 전체 롤백, 문법 오류는 해당 문장 번호와 함께 롤백
        let multi = [
            RawStmt { sql: "UPDATE t SET name = 'x' WHERE id = 1".into(), expect_one: true },
            RawStmt { sql: "UPDATE t SET qty = 0".into(), expect_one: true },
        ];
        assert!(matches!(submit_raw(&mut AnyConn::Lite(&mut c), &multi, false).await, Err(AppError::Submit { change_index: 1, affected: 2, .. })));
        let bad = [RawStmt { sql: "INSERT INTO t (name) VALUES ('ok')".into(), expect_one: false }, RawStmt { sql: "UPDAT t".into(), expect_one: true }];
        assert!(matches!(submit_raw(&mut AnyConn::Lite(&mut c), &bad, false).await, Err(AppError::Submit { change_index: 1, .. })));
        assert_eq!(rows(&mut c, "SELECT name || ':' || qty FROM t ORDER BY id").await, vec![("it's:1".into(),), ("b:2".into(),)]);
    }
}

#[cfg(test)]
mod blob_tests {
    use super::*;
    use sqlx::Connection;

    #[tokio::test]
    async fn sqlite_blob_roundtrip() {
        let mut c = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE b (id INTEGER PRIMARY KEY, data BLOB); INSERT INTO b VALUES (1, X'00FF10'), (2, NULL);")
            .execute(&mut c)
            .await
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let src = dir.path().join("in.bin");
        let out = dir.path().join("out.bin");
        let payload: Vec<u8> = (0..=255u8).cycle().take(100_000).collect();
        std::fs::write(&src, &payload).unwrap();
        let key = |id: &str| vec![Val { col: ColRef { name: "id".into(), full_type: String::new() }, value: Some(id.into()) }];
        let req = |id: &str| BlobRequest {
            conn_id: "c".into(),
            console_id: None,
            schema: None,
            table: "b".into(),
            key_mode: KeyMode::Pk,
            key: key(id),
            column: "data".into(),
        };
        assert_eq!(read_blob(&mut AnyConn::Lite(&mut c), Driver::Sqlite, &req("1"), &out).await.unwrap(), 3);
        assert_eq!(std::fs::read(&out).unwrap(), vec![0, 255, 16]);
        assert_eq!(write_blob(&mut AnyConn::Lite(&mut c), Driver::Sqlite, &req("2"), &src, false).await.unwrap(), 100_000);
        read_blob(&mut AnyConn::Lite(&mut c), Driver::Sqlite, &req("2"), &out).await.unwrap();
        assert_eq!(std::fs::read(&out).unwrap(), payload);
        assert!(write_blob(&mut AnyConn::Lite(&mut c), Driver::Sqlite, &req("9"), &src, false).await.is_err());
    }
}
