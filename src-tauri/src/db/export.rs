//! 쿼리 전체 결과를 CSV 파일로 스트리밍한다 (메모리에 모으지 않는다).

use std::io::{BufWriter, Write};
use std::path::Path;

use futures_util::TryStreamExt;
use serde::Deserialize;
use sqlx::{Column, Executor, Row};

use crate::db::exec::strip_terminator;
use crate::db::pool::AnyConn;
use crate::db::value::{lite_cell, my_cell, pg_cell, Cell};
use crate::error::AppResult;

/// 저장 경로는 받지 않는다. 백엔드가 저장 대화상자로 고른다.
#[derive(Deserialize, Debug)]
pub struct ExportRequest {
    pub conn_id: String,
    pub console_id: Option<String>,
    pub exec_id: String,
    pub sql: String,
    /// 대화상자의 기본 파일 이름
    pub file_name: String,
    /// 엑셀 호환용 UTF-8 BOM
    #[serde(default)]
    pub bom: bool,
}

/// RFC 4180: 쉼표·따옴표·줄바꿈이 있으면 따옴표로 감싸고 따옴표는 두 번 쓴다. 할당 없이 바로 쓴다.
pub fn write_field<W: Write>(w: &mut W, s: &str) -> std::io::Result<()> {
    if !s.contains([',', '"', '\n', '\r']) {
        return w.write_all(s.as_bytes());
    }
    w.write_all(b"\"")?;
    for (i, part) in s.split('"').enumerate() {
        if i > 0 {
            w.write_all(b"\"\"")?;
        }
        w.write_all(part.as_bytes())?;
    }
    w.write_all(b"\"")
}

fn write_row<'a, W: Write>(w: &mut W, fields: impl Iterator<Item = &'a str>) -> std::io::Result<()> {
    for (i, f) in fields.enumerate() {
        if i > 0 {
            w.write_all(b",")?;
        }
        write_field(w, f)?;
    }
    w.write_all(b"\r\n")
}

fn cell_text(c: &Cell) -> &str {
    match c {
        Cell::Text(s) => s,
        _ => "",
    }
}

macro_rules! stream_csv {
    ($c:expr, $sql:expr, $w:expr, $cell:path, $progress:expr) => {{
        let mut n: u64 = 0;
        let mut header_done = false;
        let mut cells: Vec<Cell> = Vec::new();
        {
            let mut s = (&mut **$c).fetch($sql);
            while let Some(row) = s.try_next().await? {
                if !header_done {
                    write_row($w, row.columns().iter().map(|c| c.name()))?;
                    header_done = true;
                }
                cells.clear();
                cells.extend((0..row.len()).map(|i| $cell(&row, i)));
                write_row($w, cells.iter().map(cell_text))?;
                n += 1;
                if n % 10_000 == 0 {
                    $progress(n);
                }
            }
        }
        if !header_done {
            // 0행이어도 헤더는 쓴다
            if let Ok(d) = (&mut **$c).describe($sql).await {
                write_row($w, d.columns().iter().map(|c| c.name()))?;
            }
        }
        n
    }};
}

/// 임시 파일에 쓴 뒤 성공했을 때만 이름을 바꾼다. 실패(취소 포함)하면 임시 파일만 지우고 기존 파일은 그대로 둔다.
pub async fn csv(conn: &mut AnyConn<'_>, sql: &str, path: &Path, bom: bool, mut progress: impl FnMut(u64) + Send) -> AppResult<u64> {
    let tmp = path.with_extension("csv.part");
    let result = async {
        let mut w = BufWriter::with_capacity(256 * 1024, std::fs::File::create(&tmp)?);
        if bom {
            w.write_all(b"\xEF\xBB\xBF")?;
        }
        let sql = strip_terminator(sql);
        let n = match conn {
            AnyConn::Pg(c) => stream_csv!(c, sql, &mut w, pg_cell, progress),
            AnyConn::My(c) => stream_csv!(c, sql, &mut w, my_cell, progress),
            AnyConn::Lite(c) => stream_csv!(c, sql, &mut w, lite_cell, progress),
        };
        w.flush()?;
        drop(w);
        std::fs::rename(&tmp, path)?;
        progress(n);
        Ok::<u64, crate::error::AppError>(n)
    }
    .await;
    if result.is_err() {
        let _ = std::fs::remove_file(&tmp);
    }
    result
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::Connection;

    fn field(s: &str) -> String {
        let mut v = Vec::new();
        write_field(&mut v, s).unwrap();
        String::from_utf8(v).unwrap()
    }

    #[test]
    fn escaping() {
        assert_eq!(field("plain"), "plain");
        assert_eq!(field("a,b"), "\"a,b\"");
        assert_eq!(field("say \"hi\""), "\"say \"\"hi\"\"\"");
        assert_eq!(field("l1\nl2"), "\"l1\nl2\"");
    }

    #[tokio::test]
    async fn sqlite_csv() {
        let mut c = sqlx::SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("CREATE TABLE t (id INTEGER, name TEXT, v REAL); INSERT INTO t VALUES (1, '김, \"철수\"', 1.5), (2, NULL, 2);")
            .execute(&mut c)
            .await
            .unwrap();
        let dir = tempfile::tempdir().unwrap();
        let path = dir.path().join("out.csv");
        let mut seen = 0;
        let n = csv(&mut AnyConn::Lite(&mut c), "SELECT * FROM t ORDER BY id;", &path, true, |k| seen = k).await.unwrap();
        assert_eq!((n, seen), (2, 2));
        let bytes = std::fs::read(&path).unwrap();
        assert!(bytes.starts_with(b"\xEF\xBB\xBF"));
        assert_eq!(std::str::from_utf8(&bytes[3..]).unwrap(), "id,name,v\r\n1,\"김, \"\"철수\"\"\",1.5\r\n2,,2.0\r\n");
        // 0행도 헤더를 쓴다
        csv(&mut AnyConn::Lite(&mut c), "SELECT id, name FROM t WHERE 0", &path, false, |_| {}).await.unwrap();
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "id,name\r\n");
        // 실패하면 기존 파일은 그대로 두고 임시 파일만 지운다
        assert!(csv(&mut AnyConn::Lite(&mut c), "SELECT * FROM nope", &path, false, |_| {}).await.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "id,name\r\n");
        assert!(!path.with_extension("csv.part").exists());
    }
}
