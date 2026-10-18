use std::time::Instant;

use futures_util::TryStreamExt;
use serde::{Deserialize, Serialize};
use sqlx::{Column, Either, Executor, TypeInfo};

use crate::db::pool::AnyConn;
use crate::db::value::{column_infos, lite_cell, my_cell, pg_cell, Cell, ColumnInfo};
use crate::error::AppResult;

/// 기본 페이지 크기 (프론트 `src/grid/constants.ts`의 DEFAULT_PAGE_SIZE와 같다)
pub const PAGE: usize = 500;
/// 직접 입력한 페이지 크기의 상한 (메모리 보호)
pub const MAX_PAGE: usize = 100_000;

fn default_page() -> usize {
    PAGE
}

#[derive(Deserialize, Debug)]
pub struct ExecRequest {
    pub conn_id: String,
    pub console_id: Option<String>,
    pub exec_id: String,
    pub sql: String,
    /// 결과 집합을 돌려주는 문장인지 (프론트의 문장 분석 결과)
    #[serde(default)]
    pub is_query: bool,
    /// 최상위 LIMIT이 없는 조회문이면 true → LIMIT/OFFSET을 붙여 페이지 조회
    #[serde(default)]
    pub paged: bool,
    #[serde(default)]
    pub offset: u64,
    /// 한 번에 가져올 행 수 (페이지 조회와 결과 자르기 모두)
    #[serde(default = "default_page")]
    pub page_size: usize,
}

impl ExecRequest {
    fn page(&self) -> usize {
        self.page_size.clamp(1, MAX_PAGE)
    }
}

#[derive(Serialize, Debug, Default)]
pub struct ExecResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<Cell>>,
    pub has_more: bool,
    pub rows_affected: Option<u64>,
    pub elapsed_ms: u64,
}

/// 끝의 세미콜론과 공백을 제거한다.
pub fn strip_terminator(sql: &str) -> &str {
    sql.trim_end().trim_end_matches(';').trim_end()
}

/// 읽기 전용 세션 설정을 되돌리는 문장인지 (문자열·주석 안이어도 보수적으로 막는다)
pub fn changes_read_only(sql: &str) -> bool {
    let s = sql.to_ascii_lowercase().split_whitespace().collect::<Vec<_>>().join(" ");
    s.contains("read_only") || s.contains("read write") || s.contains("readonly")
}

pub fn paged_sql(sql: &str, offset: u64, page: usize) -> String {
    // 마지막 줄이 -- 주석이어도 LIMIT이 주석에 먹히지 않도록 줄을 바꾼다.
    format!("{}\nLIMIT {} OFFSET {}", strip_terminator(sql), page + 1, offset)
}

pub fn count_sql(sql: &str) -> String {
    format!("SELECT COUNT(*) FROM (\n{}\n) AS _q", strip_terminator(sql))
}

macro_rules! stream_rows {
    ($conn:expr, $sql:expr, $cell:path, $page:expr) => {{
        let mut columns: Vec<ColumnInfo> = Vec::new();
        let mut rows: Vec<Vec<Cell>> = Vec::new();
        let mut has_more = false;
        let mut affected: u64 = 0;
        {
            let mut s = sqlx::raw_sql($sql).fetch_many(&mut **$conn);
            while let Some(item) = s.try_next().await? {
                match item {
                    Either::Left(r) => affected += r.rows_affected(),
                    Either::Right(row) => {
                        if columns.is_empty() {
                            columns = column_infos(&row);
                        }
                        if rows.len() >= $page {
                            has_more = true;
                            break;
                        }
                        rows.push((0..columns.len()).map(|i| $cell(&row, i)).collect());
                    }
                }
            }
        }
        (columns, rows, has_more, affected)
    }};
}

macro_rules! describe_columns {
    ($conn:expr, $sql:expr) => {{
        match (&mut **$conn).describe($sql).await {
            Ok(d) => d
                .columns()
                .iter()
                .map(|c| ColumnInfo { name: c.name().to_string(), type_name: c.type_info().name().to_string() })
                .collect::<Vec<_>>(),
            Err(_) => Vec::new(),
        }
    }};
}

pub async fn run(conn: &mut AnyConn<'_>, req: &ExecRequest) -> AppResult<ExecResult> {
    let started = Instant::now();
    let sql = if req.paged { paged_sql(&req.sql, req.offset, req.page()) } else { req.sql.clone() };
    let (mut columns, rows, has_more, affected) = match conn {
        AnyConn::Pg(c) => stream_rows!(c, &sql, pg_cell, req.page()),
        AnyConn::My(c) => stream_rows!(c, &sql, my_cell, req.page()),
        AnyConn::Lite(c) => stream_rows!(c, &sql, lite_cell, req.page()),
    };
    // 0행 조회문도 헤더를 보여 주기 위해 컬럼 정보만 따로 얻는다.
    if columns.is_empty() && req.is_query {
        columns = match conn {
            AnyConn::Pg(c) => describe_columns!(c, sql.as_str()),
            AnyConn::My(c) => describe_columns!(c, sql.as_str()),
            AnyConn::Lite(c) => describe_columns!(c, sql.as_str()),
        };
    }
    let is_result_set = !columns.is_empty() || req.is_query;
    Ok(ExecResult {
        columns,
        rows,
        has_more,
        rows_affected: if is_result_set { None } else { Some(affected) },
        elapsed_ms: started.elapsed().as_millis() as u64,
    })
}

pub async fn count(conn: &mut AnyConn<'_>, sql: &str) -> AppResult<i64> {
    let q = count_sql(sql);
    Ok(match conn {
        AnyConn::Pg(c) => sqlx::query_scalar::<_, i64>(&q).fetch_one(&mut **c).await?,
        AnyConn::My(c) => sqlx::query_scalar::<_, i64>(&q).fetch_one(&mut **c).await?,
        AnyConn::Lite(c) => sqlx::query_scalar::<_, i64>(&q).fetch_one(&mut **c).await?,
    })
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;

    #[test]
    fn read_only_guard() {
        assert!(changes_read_only("SET default_transaction_read_only = off"));
        assert!(changes_read_only("BEGIN READ
  WRITE"));
        assert!(changes_read_only("SET SESSION TRANSACTION READ WRITE"));
        assert!(changes_read_only("SET SESSION transaction_read_only = 0"));
        assert!(!changes_read_only("SELECT * FROM t"));
    }

    #[test]
    fn sql_builders() {
        assert_eq!(paged_sql("SELECT 1;  ", 0, PAGE), "SELECT 1\nLIMIT 501 OFFSET 0");
        assert_eq!(count_sql("SELECT * FROM t -- x"), "SELECT COUNT(*) FROM (\nSELECT * FROM t -- x\n) AS _q");
    }

    async fn mem() -> sqlx::SqliteConnection {
        let mut c = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, score REAL, data BLOB);
             INSERT INTO t VALUES (1, 'a', 1.0, X'0102'), (2, NULL, 2.5, NULL);
             WITH RECURSIVE n(i) AS (SELECT 3 UNION ALL SELECT i+1 FROM n WHERE i < 1200) INSERT INTO t SELECT i, 'r', 0, NULL FROM n;",
        )
        .execute(&mut c)
        .await
        .unwrap();
        c
    }

    fn req(sql: &str, is_query: bool, paged: bool, offset: u64) -> ExecRequest {
        ExecRequest { conn_id: "x".into(), console_id: None, exec_id: "e".into(), sql: sql.into(), is_query, paged, offset, page_size: PAGE }
    }

    #[tokio::test]
    async fn sqlite_values_and_paging() {
        let mut c = mem().await;
        let mut a = AnyConn::Lite(&mut c);
        let r = run(&mut a, &req("SELECT * FROM t ORDER BY id", true, true, 0)).await.unwrap();
        assert_eq!(r.columns.len(), 4);
        assert_eq!(r.rows.len(), PAGE);
        assert!(r.has_more);
        assert_eq!(r.rows[0], vec![Cell::Text("1".into()), Cell::Text("a".into()), Cell::Text("1.0".into()), Cell::Blob(2)]);
        assert_eq!(r.rows[1][1], Cell::Null);
        let last = run(&mut a, &req("SELECT * FROM t ORDER BY id", true, true, 1000)).await.unwrap();
        assert_eq!(last.rows.len(), 200);
        assert!(!last.has_more);
        assert_eq!(count(&mut a, "SELECT * FROM t;").await.unwrap(), 1200);
        let small = run(&mut a, &ExecRequest { page_size: 100, ..req("SELECT * FROM t ORDER BY id", true, true, 1100) }).await.unwrap();
        assert_eq!((small.rows.len(), small.has_more), (100, false));
        let cut = run(&mut a, &ExecRequest { page_size: 7, ..req("SELECT * FROM t", true, false, 0) }).await.unwrap();
        assert_eq!((cut.rows.len(), cut.has_more), (7, true));
    }

    #[tokio::test]
    async fn sqlite_empty_and_dml() {
        let mut c = mem().await;
        let mut a = AnyConn::Lite(&mut c);
        let r = run(&mut a, &req("SELECT id, name FROM t WHERE 1 = 0", true, true, 0)).await.unwrap();
        assert_eq!(r.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["id", "name"]);
        assert!(r.rows.is_empty());
        let u = run(&mut a, &req("UPDATE t SET name = 'z' WHERE id < 10", false, false, 0)).await.unwrap();
        assert_eq!(u.rows_affected, Some(9));
    }
}
