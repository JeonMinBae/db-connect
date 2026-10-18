//! 결과 셀 변환. 콘솔 쿼리는 raw_sql(텍스트 프로토콜)로 실행하므로 PG/MySQL 값은
//! 타입과 무관하게 서버가 보낸 텍스트를 그대로 쓴다.

use serde::Serialize;
use sqlx::mysql::MySqlRow;
use sqlx::postgres::PgRow;
use sqlx::sqlite::SqliteRow;
use sqlx::{Column, Row, TypeInfo, ValueRef};

#[derive(Serialize, Debug, Clone, PartialEq)]
#[serde(tag = "t", content = "v")]
pub enum Cell {
    Null,
    Text(String),
    /// 바이너리 값의 바이트 크기. 내용은 보내지 않는다.
    Blob(u64),
    /// 디코드할 수 없는 값 (타입 이름). 편집 불가.
    Unsupported(String),
}

#[derive(Serialize, Debug, Clone)]
pub struct ColumnInfo {
    pub name: String,
    pub type_name: String,
}

pub fn column_infos<R: Row>(row: &R) -> Vec<ColumnInfo> {
    row.columns()
        .iter()
        .map(|c| ColumnInfo { name: c.name().to_string(), type_name: c.type_info().name().to_string() })
        .collect()
}

pub fn pg_cell(row: &PgRow, i: usize) -> Cell {
    let Ok(raw) = row.try_get_raw(i) else { return Cell::Null };
    if raw.is_null() {
        return Cell::Null;
    }
    let ti = raw.type_info();
    let ty = ti.name();
    if ty == "BYTEA" {
        // 텍스트 포맷 bytea는 "\x0a1b..." 형태. 복사하지 않고 길이만 계산한다
        return match row.try_get_unchecked::<&str, _>(i) {
            Ok(s) => Cell::Blob((s.len().saturating_sub(2) / 2) as u64),
            Err(_) => Cell::Unsupported(ty.to_string()),
        };
    }
    match row.try_get_unchecked::<String, _>(i) {
        Ok(s) => Cell::Text(s),
        Err(_) => Cell::Unsupported(ty.to_string()),
    }
}

pub fn my_cell(row: &MySqlRow, i: usize) -> Cell {
    let Ok(raw) = row.try_get_raw(i) else { return Cell::Null };
    if raw.is_null() {
        return Cell::Null;
    }
    let ti = raw.type_info();
    let ty = ti.name();
    // sqlx는 BINARY 플래그만 보고 BLOB/VARBINARY로 부른다. utf8mb4_bin 같은 문자열 컬럼도 여기에 걸리므로
    // 바이트가 올바른 UTF-8이면 문자열로, 아니면 바이너리로 본다 (GEOMETRY는 항상 바이너리).
    match row.try_get_unchecked::<&[u8], _>(i) {
        Ok(b) if ty == "GEOMETRY" => Cell::Blob(b.len() as u64),
        Ok(b) => match std::str::from_utf8(b) {
            Ok(s) => Cell::Text(s.to_owned()),
            Err(_) => Cell::Blob(b.len() as u64),
        },
        Err(_) => Cell::Unsupported(ty.to_string()),
    }
}

/// SQLite는 값마다 저장 클래스가 다르므로 값의 실제 타입으로 변환한다.
pub fn lite_cell(row: &SqliteRow, i: usize) -> Cell {
    let Ok(raw) = row.try_get_raw(i) else { return Cell::Null };
    if raw.is_null() {
        return Cell::Null;
    }
    let ti = raw.type_info();
    let ty = ti.name();
    match ty {
        "INTEGER" => row.try_get_unchecked::<i64, _>(i).map(|v| Cell::Text(v.to_string())),
        "REAL" => row.try_get_unchecked::<f64, _>(i).map(|v| Cell::Text(fmt_f64(v))),
        "BLOB" => row.try_get_unchecked::<&[u8], _>(i).map(|b| Cell::Blob(b.len() as u64)),
        _ => row.try_get_unchecked::<String, _>(i).map(Cell::Text),
    }
    .unwrap_or_else(|_| Cell::Unsupported(ty.to_string()))
}

/// sqlite3 CLI처럼 정수 값의 실수는 "1.0"으로 표시한다.
pub fn fmt_f64(v: f64) -> String {
    if v.is_finite() && v.fract() == 0.0 && v.abs() < 1e15 {
        format!("{v:.1}")
    } else {
        v.to_string()
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn float_format() {
        assert_eq!(fmt_f64(1.0), "1.0");
        assert_eq!(fmt_f64(0.1), "0.1");
        assert_eq!(fmt_f64(92.25), "92.25");
    }
}
