//! 구조 탭이 편집하는 테이블 구조 (DESIGN.md "스키마 편집").

use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::db::pool::DbPool;
use crate::error::AppResult;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct ColumnDef {
    /// 원래 컬럼 이름. 새 컬럼이면 None. 이름 변경과 삭제+추가를 구분하는 안정 키다.
    #[serde(default)]
    pub orig_name: Option<String>,
    pub name: String,
    pub full_type: String,
    pub nullable: bool,
    /// 기본값 SQL 식 (문자열은 따옴표 포함)
    #[serde(default)]
    pub default: Option<String>,
    #[serde(default)]
    pub auto_increment: bool,
    /// 생성(계산) 컬럼. 식을 다루지 않으므로 구조 탭에서 바꾸지 않는다.
    #[serde(default)]
    pub generated: bool,
    #[serde(default)]
    pub comment: Option<String>,
    /// MySQL: 테이블 기본값과 다를 때만
    #[serde(default)]
    pub charset: Option<String>,
    /// MySQL: 테이블 기본값과 다를 때만, PG: 타입 기본값과 다를 때만
    #[serde(default)]
    pub collation: Option<String>,
    /// MySQL `ON UPDATE` 식 (MODIFY로 다시 쓸 때 보존용)
    #[serde(default)]
    pub on_update: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct TableStructure {
    pub columns: Vec<ColumnDef>,
    /// 기본키 컬럼 (키 순서). S1에서는 보기 전용이다.
    #[serde(default)]
    pub primary_key: Vec<String>,
}

fn os<R: Row>(row: &R, i: usize) -> Option<String>
where
    for<'r> String: sqlx::Decode<'r, R::Database>,
    usize: sqlx::ColumnIndex<R>,
{
    row.try_get_unchecked::<Option<String>, _>(i).ok().flatten()
}

const PG_STRUCTURE: &str = r#"
SELECT a.attname::text,
       format_type(a.atttypid, a.atttypmod),
       NOT a.attnotnull,
       CASE WHEN a.attgenerated = '' THEN pg_get_expr(d.adbin, d.adrelid) END,
       a.attidentity <> '',
       a.attgenerated <> '',
       col_description(c.oid, a.attnum),
       CASE WHEN a.attcollation <> 0 AND a.attcollation <> t.typcollation THEN co.collname::text END
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
LEFT JOIN pg_attrdef d ON d.adrelid = a.attrelid AND d.adnum = a.attnum
LEFT JOIN pg_collation co ON co.oid = a.attcollation
WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum"#;

const PG_PK: &str = r#"
SELECT a.attname::text
FROM pg_index i
JOIN pg_class c ON c.oid = i.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL unnest(i.indkey) WITH ORDINALITY k(attnum, ord)
JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum = k.attnum
WHERE n.nspname = $1 AND c.relname = $2 AND i.indisprimary
ORDER BY k.ord"#;

const MY_STRUCTURE: &str = r#"
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE = 'YES', COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT,
       CHARACTER_SET_NAME, COLLATION_NAME, DATA_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
ORDER BY ORDINAL_POSITION"#;

const MY_PK: &str = r#"
SELECT COLUMN_NAME FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ? AND INDEX_NAME = 'PRIMARY'
ORDER BY SEQ_IN_INDEX"#;

const MY_NUMERIC: &[&str] = &["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "decimal", "numeric", "float", "double", "real", "year"];

/// information_schema.COLUMN_DEFAULT → DEFAULT 절에 그대로 쓸 수 있는 식.
/// MySQL은 문자열 기본값을 따옴표 없이, 식 기본값은 괄호 없이 돌려준다. MariaDB는 이미 SQL 식 형태다.
pub fn mysql_default(raw: Option<&str>, extra: &str, data_type: &str, mariadb: bool) -> Option<String> {
    let v = raw?;
    if mariadb {
        return if v == "NULL" { None } else { Some(v.to_string()) };
    }
    let upper = v.to_ascii_uppercase();
    if extra.to_ascii_uppercase().contains("DEFAULT_GENERATED") {
        let bare = upper.starts_with("CURRENT_TIMESTAMP") || upper.starts_with("NOW(") || upper.starts_with("LOCALTIME");
        return Some(if bare { v.to_string() } else { format!("({v})") });
    }
    if v.starts_with("b'") || (MY_NUMERIC.contains(&data_type) && v.parse::<f64>().is_ok()) {
        return Some(v.to_string());
    }
    Some(crate::db::edit::literal(crate::store::config::Driver::Mysql, Some(v)))
}

pub async fn load(pool: &DbPool, schema: &str, table: &str) -> AppResult<TableStructure> {
    match pool {
        DbPool::Pg(p) => {
            let rows = sqlx::query(PG_STRUCTURE).bind(schema).bind(table).fetch_all(p).await?;
            let columns = rows
                .iter()
                .map(|r| {
                    let name = os(r, 0).unwrap_or_default();
                    ColumnDef {
                        orig_name: Some(name.clone()),
                        name,
                        full_type: os(r, 1).unwrap_or_default(),
                        nullable: r.try_get(2).unwrap_or(true),
                        default: os(r, 3),
                        auto_increment: r.try_get(4).unwrap_or(false),
                        generated: r.try_get(5).unwrap_or(false),
                        comment: os(r, 6),
                        charset: None,
                        collation: os(r, 7),
                        on_update: None,
                    }
                })
                .collect();
            let primary_key = sqlx::query_scalar(PG_PK).bind(schema).bind(table).fetch_all(p).await?;
            Ok(TableStructure { columns, primary_key })
        }
        DbPool::My(p) => {
            let version: String = sqlx::query_scalar("SELECT CAST(VERSION() AS CHAR)").fetch_one(p).await?;
            let mariadb = version.to_ascii_lowercase().contains("mariadb");
            let table_coll: Option<String> = sqlx::query("SELECT TABLE_COLLATION FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?")
                .bind(schema)
                .bind(table)
                .fetch_optional(p)
                .await?
                .and_then(|r| os(&r, 0));
            let rows = sqlx::query(MY_STRUCTURE).bind(schema).bind(table).fetch_all(p).await?;
            let columns = rows
                .iter()
                .map(|r| {
                    let name = os(r, 0).unwrap_or_default();
                    let extra = os(r, 4).unwrap_or_default();
                    let lower = extra.to_ascii_lowercase();
                    let data_type = os(r, 8).unwrap_or_default().to_ascii_lowercase();
                    let collation = os(r, 7);
                    let same_as_table = collation.is_none() || collation == table_coll;
                    ColumnDef {
                        orig_name: Some(name.clone()),
                        name,
                        full_type: os(r, 1).unwrap_or_default(),
                        nullable: r.try_get_unchecked::<Option<i64>, _>(2).ok().flatten().unwrap_or(1) != 0,
                        default: mysql_default(os(r, 3).as_deref(), &extra, &data_type, mariadb),
                        auto_increment: lower.contains("auto_increment"),
                        // MySQL "VIRTUAL GENERATED"/"STORED GENERATED", MariaDB "VIRTUAL"/"PERSISTENT"
                        generated: ["virtual", "stored", "persistent"].iter().any(|w| lower.contains(w)),
                        comment: os(r, 5).filter(|c| !c.is_empty()),
                        charset: if same_as_table { None } else { os(r, 6) },
                        collation: if same_as_table { None } else { collation },
                        on_update: lower.find("on update ").map(|i| extra[i + "on update ".len()..].trim().to_string()),
                    }
                })
                .collect();
            let primary_key = sqlx::query(MY_PK).bind(schema).bind(table).fetch_all(p).await?.iter().filter_map(|r| os(r, 0)).collect();
            Ok(TableStructure { columns, primary_key })
        }
        DbPool::Lite(p) => {
            let mut c = p.acquire().await?;
            load_sqlite(&mut c, table).await
        }
    }
}

/// pragma_table_info의 dflt_value는 식 기본값의 바깥 괄호를 떼고 돌려준다. DEFAULT 절에 다시 쓸 수 있게
/// 리터럴(숫자·문자열·blob·NULL·TRUE/FALSE·CURRENT_*)이 아니면 괄호로 감싼다.
pub fn sqlite_default(v: &str) -> String {
    let t = v.trim();
    let upper = t.to_ascii_uppercase();
    let quoted = |q: char| t.len() >= 2 && t.starts_with(q) && t.ends_with(q) && !t[1..t.len() - 1].replace(&format!("{q}{q}"), "").contains(q);
    let literal = quoted('\'')
        || ((upper.starts_with("X'")) && t.ends_with('\''))
        || t.trim_start_matches(['+', '-']).parse::<f64>().is_ok()
        || ["NULL", "TRUE", "FALSE", "CURRENT_TIME", "CURRENT_DATE", "CURRENT_TIMESTAMP"].contains(&upper.as_str());
    if literal { t.to_string() } else { format!("({t})") }
}

pub async fn load_sqlite(c: &mut sqlx::SqliteConnection, table: &str) -> AppResult<TableStructure> {
    let rows: Vec<(String, String, bool, Option<String>, i64, i64)> =
        sqlx::query_as(r#"SELECT name, type, "notnull" = 0, dflt_value, pk, hidden FROM pragma_table_xinfo(?1) ORDER BY cid"#)
            .bind(table)
            .fetch_all(&mut *c)
            .await?;
    let sql: Option<String> = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1")
        .bind(table)
        .fetch_optional(&mut *c)
        .await?
        .flatten();
    let has_autoinc = sql.as_deref().is_some_and(|s| crate::db::ddl::sqlite_words(s).iter().any(|w| w == "AUTOINCREMENT"));
    let mut pk: Vec<(i64, String)> = rows.iter().filter(|r| r.4 > 0).map(|r| (r.4, r.0.clone())).collect();
    pk.sort();
    let primary_key: Vec<String> = pk.into_iter().map(|(_, n)| n).collect();
    let columns = rows
        .into_iter()
        .filter(|r| r.5 != 1)
        .map(|(name, ty, nullable, default, _, hidden)| ColumnDef {
            orig_name: Some(name.clone()),
            auto_increment: has_autoinc && primary_key.len() == 1 && primary_key[0] == name,
            name,
            full_type: ty,
            nullable,
            default: default.as_deref().map(sqlite_default),
            generated: hidden == 2 || hidden == 3,
            ..Default::default()
        })
        .collect();
    Ok(TableStructure { columns, primary_key })
}

/// SQLite 재생성에 필요한 부가 정보 (인덱스·FK·트리거 원문)
#[derive(Debug, Clone, Default)]
pub struct LiteAux {
    pub create_sql: String,
    pub indexes: Vec<LiteIndex>,
    pub fks: Vec<LiteFk>,
    pub triggers: Vec<String>,
}

#[derive(Debug, Clone)]
pub struct LiteIndex {
    pub name: String,
    pub sql: Option<String>,
    /// "c" = CREATE INDEX, "u" = UNIQUE 제약, "pk" = 기본키
    pub origin: String,
    pub unique: bool,
    pub partial: bool,
    /// 키 컬럼: (이름 — 식이면 None, 정렬규칙, 내림차순)
    pub keys: Vec<(Option<String>, String, bool)>,
}

#[derive(Debug, Clone)]
pub struct LiteFk {
    pub from: Vec<String>,
    pub table: String,
    pub to: Vec<Option<String>>,
    pub on_update: String,
    pub on_delete: String,
}

pub async fn load_sqlite_aux(c: &mut sqlx::SqliteConnection, table: &str) -> AppResult<LiteAux> {
    let create_sql: Option<String> = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = ?1")
        .bind(table)
        .fetch_optional(&mut *c)
        .await?
        .flatten();
    let list: Vec<(String, bool, String, bool)> = sqlx::query_as(r#"SELECT name, "unique" = 1, origin, partial = 1 FROM pragma_index_list(?1) ORDER BY seq DESC"#)
        .bind(table)
        .fetch_all(&mut *c)
        .await?;
    let mut indexes = Vec::new();
    for (name, unique, origin, partial) in list {
        let keys: Vec<(Option<String>, Option<String>, bool)> =
            sqlx::query_as(r#"SELECT name, coll, "desc" = 1 FROM pragma_index_xinfo(?1) WHERE key = 1 ORDER BY seqno"#)
                .bind(&name)
                .fetch_all(&mut *c)
                .await?;
        let sql: Option<String> = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = ?1")
            .bind(&name)
            .fetch_optional(&mut *c)
            .await?
            .flatten();
        let keys = keys.into_iter().map(|(n, coll, desc)| (n, coll.unwrap_or_default(), desc)).collect();
        indexes.push(LiteIndex { name, sql, origin, unique, partial, keys });
    }
    let fk_rows: Vec<(i64, String, String, Option<String>, String, String)> =
        sqlx::query_as("SELECT id, \"table\", \"from\", \"to\", on_update, on_delete FROM pragma_foreign_key_list(?1) ORDER BY id, seq")
            .bind(table)
            .fetch_all(&mut *c)
            .await?;
    let mut fks: Vec<(i64, LiteFk)> = Vec::new();
    for (id, t, from, to, on_update, on_delete) in fk_rows {
        match fks.last_mut() {
            Some((last, fk)) if *last == id => {
                fk.from.push(from);
                fk.to.push(to);
            }
            _ => fks.push((id, LiteFk { from: vec![from], table: t, to: vec![to], on_update, on_delete })),
        }
    }
    let triggers = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?1 AND sql IS NOT NULL ORDER BY name")
        .bind(table)
        .fetch_all(&mut *c)
        .await?;
    Ok(LiteAux { create_sql: create_sql.unwrap_or_default(), indexes, fks: fks.into_iter().map(|(_, f)| f).collect(), triggers })
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mysql_defaults() {
        assert_eq!(mysql_default(None, "", "int", false), None);
        assert_eq!(mysql_default(Some("0"), "", "int", false).unwrap(), "0");
        assert_eq!(mysql_default(Some("it's"), "", "varchar", false).unwrap(), "'it''s'");
        assert_eq!(mysql_default(Some("12"), "", "varchar", false).unwrap(), "'12'");
        assert_eq!(mysql_default(Some("CURRENT_TIMESTAMP"), "DEFAULT_GENERATED on update CURRENT_TIMESTAMP", "timestamp", false).unwrap(), "CURRENT_TIMESTAMP");
        assert_eq!(mysql_default(Some("uuid()"), "DEFAULT_GENERATED", "char", false).unwrap(), "(uuid())");
        assert_eq!(mysql_default(Some("b'1'"), "", "bit", false).unwrap(), "b'1'");
        assert_eq!(mysql_default(Some("NULL"), "", "varchar", true), None);
        assert_eq!(mysql_default(Some("'abc'"), "", "varchar", true).unwrap(), "'abc'");
    }

    #[test]
    fn sqlite_defaults() {
        for lit in ["0", "-1.5", "'a''b'", "X'0A'", "NULL", "current_timestamp"] {
            assert_eq!(sqlite_default(lit), lit);
        }
        assert_eq!(sqlite_default("1 + 2"), "(1 + 2)");
        assert_eq!(sqlite_default("'a' || 'b'"), "('a' || 'b')");
        assert_eq!(sqlite_default("datetime('now')"), "(datetime('now'))");
    }
}
