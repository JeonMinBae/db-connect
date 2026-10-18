//! 구조 탭이 편집하는 테이블 구조 (DESIGN.md "스키마 편집").
//!
//! 각 항목의 `orig_name`은 원래 구조에서의 식별 키다. 새 항목이면 None.
//! 이름이 없는 SQLite 외래 키·CHECK는 "#순번"을 키로 쓴다.

// sqlx 행 튜플 타입이 길다
#![allow(clippy::type_complexity)]

use serde::{Deserialize, Serialize};
use sqlx::Row;

use crate::db::pool::DbPool;
use crate::error::AppResult;

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct ColumnDef {
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
pub struct IndexDef {
    #[serde(default)]
    pub orig_name: Option<String>,
    pub name: String,
    pub columns: Vec<String>,
    pub unique: bool,
    /// UNIQUE 제약으로 만든 것 (PG는 DROP CONSTRAINT로 지우고, SQLite는 테이블 정의 안에 있다)
    #[serde(default)]
    pub constraint: bool,
    /// 식·부분·정렬 옵션이 있는 인덱스의 원래 정의. 구조 탭은 이런 인덱스를 그대로 두거나 삭제만 한다.
    #[serde(default)]
    pub raw: Option<String>,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct ForeignKeyDef {
    #[serde(default)]
    pub orig_name: Option<String>,
    /// 비어 있으면 DB가 이름을 정한다
    pub name: String,
    pub columns: Vec<String>,
    /// None = 같은 스키마
    #[serde(default)]
    pub ref_schema: Option<String>,
    pub ref_table: String,
    /// SQLite는 비어 있으면 참조 테이블의 기본키
    pub ref_columns: Vec<String>,
    /// NO ACTION | RESTRICT | CASCADE | SET NULL | SET DEFAULT
    pub on_update: String,
    pub on_delete: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct CheckDef {
    #[serde(default)]
    pub orig_name: Option<String>,
    /// 비어 있으면 DB가 이름을 정한다
    pub name: String,
    /// 바깥 괄호를 뺀 식
    pub expr: String,
}

#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct TableStructure {
    pub columns: Vec<ColumnDef>,
    /// 기본키 컬럼 (키 순서)
    #[serde(default)]
    pub primary_key: Vec<String>,
    /// PG 기본키 제약 이름 (DROP CONSTRAINT용)
    #[serde(default)]
    pub primary_key_name: Option<String>,
    /// 기본키를 뺀 인덱스와 UNIQUE 제약
    #[serde(default)]
    pub indexes: Vec<IndexDef>,
    #[serde(default)]
    pub foreign_keys: Vec<ForeignKeyDef>,
    #[serde(default)]
    pub checks: Vec<CheckDef>,
    /// CHECK 제약을 조회할 수 없는 서버 (MySQL 8.0.16 / MariaDB 10.2 미만)
    #[serde(default)]
    pub checks_unsupported: bool,
    #[serde(default)]
    pub options: TableOptions,
}

/// 테이블 옵션. 코멘트는 PG·MySQL, 나머지는 MySQL만.
#[derive(Serialize, Deserialize, Debug, Clone, PartialEq, Default)]
pub struct TableOptions {
    #[serde(default)]
    pub comment: Option<String>,
    #[serde(default)]
    pub engine: Option<String>,
    #[serde(default)]
    pub charset: Option<String>,
    #[serde(default)]
    pub collation: Option<String>,
    #[serde(default)]
    pub row_format: Option<String>,
    /// 초안에서만: 문자셋을 바꿀 때 기존 데이터도 변환한다 (CONVERT TO). false면 기본값만 바꾼다.
    #[serde(default)]
    pub convert: bool,
}

/// 문자셋·정렬규칙·엔진 선택 목록 (MySQL), 정렬규칙 (PG)
#[derive(Serialize, Debug, Clone, Default)]
pub struct DdlChoices {
    pub charsets: Vec<String>,
    /// (정렬규칙, 문자셋). PG는 문자셋이 빈 문자열
    pub collations: Vec<(String, String)>,
    pub engines: Vec<String>,
}

/// 통계 기반 추정 행 수 (PG reltuples, MySQL TABLE_ROWS). SQLite는 세지 않는다.
pub async fn estimated_rows(pool: &DbPool, schema: &str, table: &str) -> AppResult<Option<i64>> {
    Ok(match pool {
        DbPool::Pg(p) => sqlx::query_scalar(&format!("SELECT reltuples::int8 FROM pg_class WHERE oid = {PG_OID}")).bind(schema).bind(table).fetch_optional(p).await?,
        DbPool::My(p) => sqlx::query("SELECT TABLE_ROWS FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?")
            .bind(schema)
            .bind(table)
            .fetch_optional(p)
            .await?
            .and_then(|r| r.try_get_unchecked::<Option<i64>, _>(0).ok().flatten()),
        DbPool::Lite(_) => None,
    })
}

/// SQLite: 이 테이블을 참조하는 다른 테이블의 외래 키 (테이블, ON DELETE)
pub async fn sqlite_referencing(c: &mut sqlx::SqliteConnection, table: &str) -> AppResult<Vec<(String, String)>> {
    Ok(sqlx::query_as(
        r#"SELECT DISTINCT m.name, f.on_delete FROM sqlite_master m JOIN pragma_foreign_key_list(m.name) f
           WHERE m.type = 'table' AND m.name <> ?1 AND f."table" = ?1 COLLATE NOCASE ORDER BY m.name"#,
    )
    .bind(table)
    .fetch_all(&mut *c)
    .await?)
}

pub async fn choices(pool: &DbPool) -> AppResult<DdlChoices> {
    Ok(match pool {
        DbPool::Pg(p) => DdlChoices {
            collations: sqlx::query_scalar::<_, String>("SELECT DISTINCT collname::text FROM pg_collation ORDER BY 1")
                .fetch_all(p)
                .await?
                .into_iter()
                .map(|c| (c, String::new()))
                .collect(),
            ..Default::default()
        },
        DbPool::My(p) => {
            let col = |sql: &'static str| sqlx::query(sql).fetch_all(p);
            let charsets = col("SELECT CHARACTER_SET_NAME FROM information_schema.CHARACTER_SETS ORDER BY 1").await?.iter().filter_map(|r| os(r, 0)).collect();
            let collations = col("SELECT COLLATION_NAME, CHARACTER_SET_NAME FROM information_schema.COLLATIONS ORDER BY 2, 1")
                .await?
                .iter()
                .map(|r| (os(r, 0).unwrap_or_default(), os(r, 1).unwrap_or_default()))
                .collect();
            let engines = col("SELECT ENGINE FROM information_schema.ENGINES WHERE SUPPORT IN ('YES', 'DEFAULT') ORDER BY 1").await?.iter().filter_map(|r| os(r, 0)).collect();
            DdlChoices { charsets, collations, engines }
        }
        DbPool::Lite(_) => DdlChoices::default(),
    })
}

fn os<R: Row>(row: &R, i: usize) -> Option<String>
where
    for<'r> String: sqlx::Decode<'r, R::Database>,
    usize: sqlx::ColumnIndex<R>,
{
    row.try_get_unchecked::<Option<String>, _>(i).ok().flatten()
}

/// "(a > 0)" → "a > 0". 바깥 괄호 한 겹이 식 전체를 감쌀 때만 뗀다.
pub fn strip_outer_parens(s: &str) -> &str {
    let t = s.trim();
    if !(t.starts_with('(') && t.ends_with(')')) {
        return t;
    }
    let mut depth = 0;
    let mut quote: Option<char> = None;
    for (i, c) in t.char_indices() {
        match (quote, c) {
            (Some(q), c) if c == q => quote = None,
            (Some(_), _) => {}
            (None, '\'' | '"' | '`') => quote = Some(c),
            (None, '(') => depth += 1,
            (None, ')') => {
                depth -= 1;
                if depth == 0 && i != t.len() - 1 {
                    return t;
                }
            }
            _ => {}
        }
    }
    t[1..t.len() - 1].trim()
}

/// 식 전체를 감싼 괄호를 모두 뗀다 ("((a > 0))" → "a > 0")
pub fn unwrap_parens(s: &str) -> String {
    let mut cur = s.trim();
    loop {
        let next = strip_outer_parens(cur);
        if next.len() == cur.len() {
            return cur.to_string();
        }
        cur = next;
    }
}

/// 외래 키 동작 이름을 하나로 맞춘다
fn fk_action(s: &str) -> String {
    match s.trim().to_ascii_uppercase().as_str() {
        "A" | "" => "NO ACTION".into(),
        "R" => "RESTRICT".into(),
        "C" => "CASCADE".into(),
        "N" => "SET NULL".into(),
        "D" => "SET DEFAULT".into(),
        other => other.to_string(),
    }
}

/// 같은 이름(키)의 연속 행을 하나로 묶는다
fn group_by_name<T>(rows: Vec<(String, T)>) -> Vec<(String, Vec<T>)> {
    let mut out: Vec<(String, Vec<T>)> = Vec::new();
    for (k, v) in rows {
        match out.last_mut() {
            Some((last, items)) if *last == k => items.push(v),
            _ => out.push((k, vec![v])),
        }
    }
    out
}

const PG_OID: &str = "(SELECT c.oid FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace WHERE n.nspname = $1 AND c.relname = $2)";

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

fn pg_pk() -> String {
    format!(
        r#"SELECT k.conname::text,
       ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(n, o)
             JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n ORDER BY u.o)
FROM pg_constraint k WHERE k.conrelid = {PG_OID} AND k.contype = 'p'"#
    )
}

fn pg_indexes() -> String {
    format!(
        r#"SELECT i.relname::text, ix.indisunique,
       EXISTS (SELECT 1 FROM pg_constraint k WHERE k.conindid = ix.indexrelid AND k.contype = 'u'),
       CASE WHEN ix.indexprs IS NOT NULL OR ix.indpred IS NOT NULL OR am.amname <> 'btree'
                 OR EXISTS (SELECT 1 FROM unnest(ix.indoption::int2[]) o WHERE o <> 0)
            THEN pg_get_indexdef(ix.indexrelid) END,
       ARRAY(SELECT a.attname::text FROM unnest(ix.indkey::int2[]) WITH ORDINALITY u(n, o)
             JOIN pg_attribute a ON a.attrelid = ix.indrelid AND a.attnum = u.n
             WHERE u.o <= ix.indnkeyatts ORDER BY u.o)
FROM pg_index ix JOIN pg_class i ON i.oid = ix.indexrelid JOIN pg_am am ON am.oid = i.relam
WHERE ix.indrelid = {PG_OID} AND NOT ix.indisprimary
ORDER BY i.relname"#
    )
}

fn pg_fks() -> String {
    format!(
        r#"SELECT k.conname::text,
       ARRAY(SELECT a.attname::text FROM unnest(k.conkey) WITH ORDINALITY u(n, o)
             JOIN pg_attribute a ON a.attrelid = k.conrelid AND a.attnum = u.n ORDER BY u.o),
       fn.nspname::text, f.relname::text,
       ARRAY(SELECT a.attname::text FROM unnest(k.confkey) WITH ORDINALITY u(n, o)
             JOIN pg_attribute a ON a.attrelid = k.confrelid AND a.attnum = u.n ORDER BY u.o),
       k.confupdtype::text, k.confdeltype::text
FROM pg_constraint k JOIN pg_class f ON f.oid = k.confrelid JOIN pg_namespace fn ON fn.oid = f.relnamespace
WHERE k.conrelid = {PG_OID} AND k.contype = 'f'
ORDER BY k.conname"#
    )
}

fn pg_checks() -> String {
    format!("SELECT conname::text, pg_get_constraintdef(oid) FROM pg_constraint WHERE conrelid = {PG_OID} AND contype = 'c' ORDER BY conname")
}

const MY_STRUCTURE: &str = r#"
SELECT COLUMN_NAME, COLUMN_TYPE, IS_NULLABLE = 'YES', COLUMN_DEFAULT, EXTRA, COLUMN_COMMENT,
       CHARACTER_SET_NAME, COLLATION_NAME, DATA_TYPE
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
ORDER BY ORDINAL_POSITION"#;

const MY_INDEXES: &str = r#"
SELECT INDEX_NAME, NON_UNIQUE = 0, COLUMN_NAME, SUB_PART, COLLATION, INDEX_TYPE
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX"#;

const MY_FKS: &str = r#"
SELECT k.CONSTRAINT_NAME, k.COLUMN_NAME, k.REFERENCED_TABLE_SCHEMA, k.REFERENCED_TABLE_NAME, k.REFERENCED_COLUMN_NAME,
       r.UPDATE_RULE, r.DELETE_RULE
FROM information_schema.KEY_COLUMN_USAGE k
JOIN information_schema.REFERENTIAL_CONSTRAINTS r
  ON r.CONSTRAINT_SCHEMA = k.CONSTRAINT_SCHEMA AND r.CONSTRAINT_NAME = k.CONSTRAINT_NAME AND r.TABLE_NAME = k.TABLE_NAME
WHERE k.TABLE_SCHEMA = ? AND k.TABLE_NAME = ? AND k.REFERENCED_TABLE_NAME IS NOT NULL
ORDER BY k.CONSTRAINT_NAME, k.ORDINAL_POSITION"#;

const MY_CHECKS: &str = r#"
SELECT c.CONSTRAINT_NAME, c.CHECK_CLAUSE
FROM information_schema.CHECK_CONSTRAINTS c
JOIN information_schema.TABLE_CONSTRAINTS t ON t.CONSTRAINT_SCHEMA = c.CONSTRAINT_SCHEMA AND t.CONSTRAINT_NAME = c.CONSTRAINT_NAME
WHERE t.TABLE_SCHEMA = ? AND t.TABLE_NAME = ? AND t.CONSTRAINT_TYPE = 'CHECK'
ORDER BY c.CONSTRAINT_NAME"#;

const MY_NUMERIC: &[&str] = &["tinyint", "smallint", "mediumint", "int", "integer", "bigint", "decimal", "numeric", "float", "double", "real", "year"];

/// information_schema.COLUMN_DEFAULT → DEFAULT 절에 그대로 쓸 수 있는 식.
/// MySQL은 문자열 기본값을 따옴표 없이, 식 기본값은 괄호 없이 돌려준다. MariaDB는 이미 SQL 식 형태다.
pub fn mysql_default(raw: Option<&str>, extra: &str, data_type: &str, mariadb: bool) -> Option<String> {
    let v = raw?;
    if mariadb {
        return if v == "NULL" { None } else { Some(v.to_string()) };
    }
    let upper = v.to_ascii_uppercase();
    let now = upper.starts_with("CURRENT_TIMESTAMP") || upper.starts_with("NOW(") || upper.starts_with("LOCALTIME");
    if extra.to_ascii_uppercase().contains("DEFAULT_GENERATED") {
        return Some(if now { v.to_string() } else { format!("({v})") });
    }
    // MySQL 8.0.13 미만은 DEFAULT_GENERATED 표시가 없다. 날짜·시간 컬럼의 CURRENT_TIMESTAMP는 식으로 본다
    if now && matches!(data_type, "timestamp" | "datetime") {
        return Some(v.to_string());
    }
    if v.starts_with("b'") || (MY_NUMERIC.contains(&data_type) && v.parse::<f64>().is_ok()) {
        return Some(v.to_string());
    }
    Some(crate::db::edit::literal(crate::store::config::Driver::Mysql, Some(v)))
}

pub async fn load(pool: &DbPool, schema: &str, table: &str) -> AppResult<TableStructure> {
    match pool {
        DbPool::Pg(p) => load_pg(p, schema, table).await,
        DbPool::My(p) => load_mysql(p, schema, table).await,
        DbPool::Lite(p) => {
            let mut c = p.acquire().await?;
            load_sqlite(&mut c, table).await
        }
    }
}

async fn load_pg(p: &sqlx::PgPool, schema: &str, table: &str) -> AppResult<TableStructure> {
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
    let pk: Option<(String, Vec<String>)> = sqlx::query_as(&pg_pk()).bind(schema).bind(table).fetch_optional(p).await?;
    let (primary_key_name, primary_key) = match pk {
        Some((n, cols)) => (Some(n), cols),
        None => (None, vec![]),
    };
    let ix: Vec<(String, bool, bool, Option<String>, Vec<String>)> = sqlx::query_as(&pg_indexes()).bind(schema).bind(table).fetch_all(p).await?;
    let indexes = ix
        .into_iter()
        .map(|(name, unique, constraint, raw, columns)| IndexDef { orig_name: Some(name.clone()), name, columns, unique, constraint, raw })
        .collect();
    let fk: Vec<(String, Vec<String>, String, String, Vec<String>, String, String)> = sqlx::query_as(&pg_fks()).bind(schema).bind(table).fetch_all(p).await?;
    let foreign_keys = fk
        .into_iter()
        .map(|(name, columns, rs, rt, ref_columns, upd, del)| ForeignKeyDef {
            orig_name: Some(name.clone()),
            name,
            columns,
            ref_schema: (rs != schema).then_some(rs),
            ref_table: rt,
            ref_columns,
            on_update: fk_action(&upd),
            on_delete: fk_action(&del),
        })
        .collect();
    let ck: Vec<(String, String)> = sqlx::query_as(&pg_checks()).bind(schema).bind(table).fetch_all(p).await?;
    let checks = ck
        .into_iter()
        .map(|(name, def)| {
            let body = def.trim().strip_prefix("CHECK").unwrap_or(&def).trim();
            let body = body.strip_suffix("NOT VALID").unwrap_or(body).trim();
            CheckDef { orig_name: Some(name.clone()), name, expr: unwrap_parens(body) }
        })
        .collect();
    let comment: Option<String> = sqlx::query_scalar(&format!("SELECT obj_description({PG_OID}, 'pg_class')")).bind(schema).bind(table).fetch_one(p).await?;
    let options = TableOptions { comment, ..Default::default() };
    Ok(TableStructure { columns, primary_key, primary_key_name, indexes, foreign_keys, checks, checks_unsupported: false, options })
}

async fn load_mysql(p: &sqlx::MySqlPool, schema: &str, table: &str) -> AppResult<TableStructure> {
    let version: String = sqlx::query_scalar("SELECT CAST(VERSION() AS CHAR)").fetch_one(p).await?;
    let mariadb = version.to_ascii_lowercase().contains("mariadb");
    let options = sqlx::query(
        "SELECT t.ENGINE, c.CHARACTER_SET_NAME, t.TABLE_COLLATION, t.ROW_FORMAT, t.TABLE_COMMENT
         FROM information_schema.TABLES t
         LEFT JOIN information_schema.COLLATIONS c ON c.COLLATION_NAME = t.TABLE_COLLATION
         WHERE t.TABLE_SCHEMA = ? AND t.TABLE_NAME = ?",
    )
    .bind(schema)
    .bind(table)
    .fetch_optional(p)
    .await?
    .map(|r| TableOptions {
        engine: os(&r, 0),
        charset: os(&r, 1),
        collation: os(&r, 2),
        row_format: os(&r, 3),
        comment: os(&r, 4).filter(|c| !c.is_empty()),
        convert: false,
    })
    .unwrap_or_default();
    let table_coll = options.collation.clone();
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

    // (이름, unique, 컬럼, 접두 길이, 정렬, 종류)
    let int = |r: &sqlx::mysql::MySqlRow, i: usize| r.try_get_unchecked::<Option<i64>, _>(i).ok().flatten();
    let ix_rows: Vec<(String, (bool, Option<String>, Option<i64>, Option<String>, String))> = sqlx::query(MY_INDEXES)
        .bind(schema)
        .bind(table)
        .fetch_all(p)
        .await?
        .iter()
        .map(|r| (os(r, 0).unwrap_or_default(), (int(r, 1).unwrap_or(0) != 0, os(r, 2), int(r, 3), os(r, 4), os(r, 5).unwrap_or_default())))
        .collect();
    let mut primary_key = vec![];
    let mut indexes = vec![];
    for (name, parts) in group_by_name(ix_rows) {
        let unique = parts[0].0;
        let kind = parts[0].4.clone();
        if name == "PRIMARY" {
            primary_key = parts.into_iter().filter_map(|p| p.1).collect();
            continue;
        }
        let plain = (kind == "BTREE" || kind == "HASH") && parts.iter().all(|p| p.1.is_some() && p.2.is_none() && p.3.as_deref() != Some("D"));
        let raw = (!plain).then(|| {
            let keys = parts
                .iter()
                .map(|p| {
                    let mut s = p.1.as_ref().map_or("(식)".to_string(), |c| format!("`{c}`"));
                    if let Some(n) = p.2 {
                        s += &format!("({n})");
                    }
                    if p.3.as_deref() == Some("D") {
                        s += " DESC";
                    }
                    s
                })
                .collect::<Vec<_>>()
                .join(", ");
            format!("{kind} ({keys})")
        });
        let columns = parts.into_iter().filter_map(|p| p.1).collect();
        indexes.push(IndexDef { orig_name: Some(name.clone()), name, columns, unique, constraint: false, raw });
    }

    let fk_rows: Vec<(String, (String, String, String, String, String, String))> = sqlx::query(MY_FKS)
        .bind(schema)
        .bind(table)
        .fetch_all(p)
        .await?
        .iter()
        .map(|r| {
            let g = |i| os(r, i).unwrap_or_default();
            (g(0), (g(1), g(2), g(3), g(4), g(5), g(6)))
        })
        .collect();
    let foreign_keys = group_by_name(fk_rows)
        .into_iter()
        .map(|(name, parts)| ForeignKeyDef {
            orig_name: Some(name.clone()),
            name,
            ref_schema: (parts[0].1 != schema).then(|| parts[0].1.clone()),
            ref_table: parts[0].2.clone(),
            on_update: fk_action(&parts[0].4),
            on_delete: fk_action(&parts[0].5),
            columns: parts.iter().map(|p| p.0.clone()).collect(),
            ref_columns: parts.iter().map(|p| p.3.clone()).collect(),
        })
        .collect();

    // MariaDB는 CHECK 이름이 테이블 단위라 같은 스키마의 다른 테이블과 이름이 겹칠 수 있다
    let checks_sql = if mariadb { MY_CHECKS.replace("AND t.CONSTRAINT_NAME = c.CONSTRAINT_NAME", "AND t.CONSTRAINT_NAME = c.CONSTRAINT_NAME AND t.TABLE_NAME = c.TABLE_NAME") } else { MY_CHECKS.to_string() };
    let (checks, checks_unsupported) = match sqlx::query(&checks_sql).bind(schema).bind(table).fetch_all(p).await {
        Ok(rows) => (
            rows.iter()
                .map(|r| {
                    let name = os(r, 0).unwrap_or_default();
                    CheckDef { orig_name: Some(name.clone()), name, expr: unwrap_parens(&os(r, 1).unwrap_or_default()) }
                })
                .collect(),
            false,
        ),
        // CHECK_CONSTRAINTS가 없는 서버
        Err(_) => (vec![], true),
    };
    Ok(TableStructure { columns, primary_key, primary_key_name: None, indexes, foreign_keys, checks, checks_unsupported, options })
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

async fn create_sql_of(c: &mut sqlx::SqliteConnection, kind: &str, name: &str) -> AppResult<Option<String>> {
    Ok(sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = ?1 AND name = ?2")
        .bind(kind)
        .bind(name)
        .fetch_optional(&mut *c)
        .await?
        .flatten())
}

pub async fn load_sqlite(c: &mut sqlx::SqliteConnection, table: &str) -> AppResult<TableStructure> {
    let rows: Vec<(String, String, bool, Option<String>, i64, i64)> =
        sqlx::query_as(r#"SELECT name, type, "notnull" = 0, dflt_value, pk, hidden FROM pragma_table_xinfo(?1) ORDER BY cid"#)
            .bind(table)
            .fetch_all(&mut *c)
            .await?;
    let create_sql = create_sql_of(c, "table", table).await?.unwrap_or_default();
    let has_autoinc = crate::db::ddl::sqlite_words(&create_sql).iter().any(|w| w == "AUTOINCREMENT");
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

    let list: Vec<(String, bool, String, bool)> =
        sqlx::query_as(r#"SELECT name, "unique" = 1, origin, partial = 1 FROM pragma_index_list(?1) WHERE origin <> 'pk' ORDER BY name"#)
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
        let plain = !partial && keys.iter().all(|(n, coll, desc)| n.is_some() && !desc && coll.as_deref().is_none_or(|c| c.eq_ignore_ascii_case("BINARY")));
        let raw = if plain { None } else { Some(create_sql_of(c, "index", &name).await?.unwrap_or_else(|| name.clone())) };
        let columns = keys.into_iter().filter_map(|k| k.0).collect();
        indexes.push(IndexDef { orig_name: Some(name.clone()), name, columns, unique, constraint: origin == "u", raw });
    }

    let fk_rows: Vec<(i64, String, String, Option<String>, String, String)> =
        sqlx::query_as("SELECT id, \"table\", \"from\", \"to\", on_update, on_delete FROM pragma_foreign_key_list(?1) ORDER BY id, seq")
            .bind(table)
            .fetch_all(&mut *c)
            .await?;
    let grouped = group_by_name(fk_rows.into_iter().map(|(id, t, from, to, u, d)| (id.to_string(), (t, from, to, u, d))).collect());
    let foreign_keys = grouped
        .into_iter()
        .map(|(id, parts)| ForeignKeyDef {
            orig_name: Some(format!("#{id}")),
            name: String::new(),
            columns: parts.iter().map(|p| p.1.clone()).collect(),
            ref_schema: None,
            ref_table: parts[0].0.clone(),
            ref_columns: if parts.iter().all(|p| p.2.is_none()) { vec![] } else { parts.iter().map(|p| p.2.clone().unwrap_or_default()).collect() },
            on_update: fk_action(&parts[0].3),
            on_delete: fk_action(&parts[0].4),
        })
        .collect();

    let checks = crate::db::ddl::sqlite_checks(&create_sql)
        .into_iter()
        .enumerate()
        .map(|(i, (name, expr))| CheckDef { orig_name: Some(name.clone().unwrap_or_else(|| format!("#{i}"))), name: name.unwrap_or_default(), expr: unwrap_parens(&expr) })
        .collect();
    Ok(TableStructure { columns, primary_key, primary_key_name: None, indexes, foreign_keys, checks, checks_unsupported: false, options: TableOptions::default() })
}

/// SQLite 재생성에 필요한 원문 (CREATE TABLE·트리거)
#[derive(Debug, Clone, Default)]
pub struct LiteAux {
    pub create_sql: String,
    pub triggers: Vec<String>,
    /// AUTOINCREMENT 카운터 (sqlite_sequence)
    pub seq: Option<i64>,
}

pub async fn load_sqlite_aux(c: &mut sqlx::SqliteConnection, table: &str) -> AppResult<LiteAux> {
    let create_sql = create_sql_of(c, "table", table).await?.unwrap_or_default();
    let triggers = sqlx::query_scalar("SELECT sql FROM sqlite_master WHERE type = 'trigger' AND tbl_name = ?1 AND sql IS NOT NULL ORDER BY name")
        .bind(table)
        .fetch_all(&mut *c)
        .await?;
    // sqlite_sequence는 AUTOINCREMENT 테이블이 처음 생길 때 만들어진다
    let has_seq: bool = sqlx::query_scalar("SELECT EXISTS (SELECT 1 FROM sqlite_master WHERE name = 'sqlite_sequence')").fetch_one(&mut *c).await?;
    let seq = if has_seq {
        sqlx::query_scalar("SELECT seq FROM sqlite_sequence WHERE name = ?1").bind(table).fetch_optional(&mut *c).await?
    } else {
        None
    };
    Ok(LiteAux { create_sql, triggers, seq })
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
        // MySQL 5.7
        assert_eq!(mysql_default(Some("CURRENT_TIMESTAMP"), "on update CURRENT_TIMESTAMP", "timestamp", false).unwrap(), "CURRENT_TIMESTAMP");
        assert_eq!(mysql_default(Some("CURRENT_TIMESTAMP"), "", "varchar", false).unwrap(), "'CURRENT_TIMESTAMP'");
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

    #[test]
    fn outer_parens() {
        assert_eq!(strip_outer_parens("((a > 0))"), "(a > 0)");
        assert_eq!(strip_outer_parens("(a > 0) AND (b > 0)"), "(a > 0) AND (b > 0)");
        assert_eq!(strip_outer_parens("(a <> ')')"), "a <> ')'");
        assert_eq!(strip_outer_parens("a > 0"), "a > 0");
    }
}
