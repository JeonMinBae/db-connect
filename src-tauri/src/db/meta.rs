use serde::Serialize;
use sqlx::Row;

use crate::db::pool::DbPool;
use crate::error::AppResult;

#[derive(Serialize, Debug, Clone)]
pub struct TableInfo {
    pub name: String,
    /// "TABLE" | "VIEW"
    pub kind: String,
}

#[derive(Serialize, Debug, Clone)]
pub struct ColumnMeta {
    pub name: String,
    pub data_type: String,
    pub full_type: String,
    pub nullable: bool,
    pub is_pk: bool,
    pub is_unique_not_null: bool,
    pub enum_values: Option<Vec<String>>,
    pub ordinal: i64,
}

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct IndexInfo {
    pub name: String,
    /// 키 순서대로. 식(expression) 인덱스 항목은 식 텍스트 또는 "<expr>"
    pub columns: Vec<String>,
    pub unique: bool,
    pub primary: bool,
}

#[derive(Serialize, Debug, Clone)]
pub struct SnapshotTable {
    pub schema: String,
    pub table: String,
    pub columns: Vec<String>,
}

/// MySQL information_schema는 VARBINARY로 오는 경우가 있어 타입 검사를 건너뛴다.
fn s<R: Row>(row: &R, i: usize) -> String
where
    for<'r> String: sqlx::Decode<'r, R::Database>,
    usize: sqlx::ColumnIndex<R>,
{
    row.try_get_unchecked::<Option<String>, _>(i).ok().flatten().unwrap_or_default()
}

pub async fn schemas(pool: &DbPool) -> AppResult<Vec<String>> {
    Ok(match pool {
        DbPool::Pg(p) => sqlx::query_scalar(
            "SELECT nspname::text FROM pg_namespace
             WHERE nspname NOT LIKE 'pg\\_%' AND nspname <> 'information_schema'
             ORDER BY nspname",
        )
        .fetch_all(p)
        .await?,
        DbPool::My(p) => sqlx::query("SELECT SCHEMA_NAME FROM information_schema.SCHEMATA ORDER BY SCHEMA_NAME")
            .fetch_all(p)
            .await?
            .iter()
            .map(|r| s(r, 0))
            .collect(),
        DbPool::Lite(_) => vec!["main".to_string()],
    })
}

pub async fn tables(pool: &DbPool, schema: &str) -> AppResult<Vec<TableInfo>> {
    let rows: Vec<(String, String)> = match pool {
        DbPool::Pg(p) => sqlx::query_as(
            "SELECT c.relname::text, CASE WHEN c.relkind IN ('v','m') THEN 'VIEW' ELSE 'TABLE' END
             FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE n.nspname = $1 AND c.relkind IN ('r','p','v','m','f')
             ORDER BY c.relname",
        )
        .bind(schema)
        .fetch_all(p)
        .await?,
        DbPool::My(p) => sqlx::query(
            "SELECT TABLE_NAME, CASE WHEN TABLE_TYPE = 'VIEW' THEN 'VIEW' ELSE 'TABLE' END
             FROM information_schema.TABLES WHERE TABLE_SCHEMA = ? ORDER BY TABLE_NAME",
        )
        .bind(schema)
        .fetch_all(p)
        .await?
        .iter()
        .map(|r| (s(r, 0), s(r, 1)))
        .collect(),
        DbPool::Lite(p) => sqlx::query_as(
            "SELECT name, upper(type) FROM sqlite_master
             WHERE type IN ('table','view') AND name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
             ORDER BY name",
        )
        .fetch_all(p)
        .await?,
    };
    Ok(rows.into_iter().map(|(name, kind)| TableInfo { name, kind }).collect())
}

const PG_COLUMNS: &str = r#"
SELECT a.attname::text,
       t.typname::text,
       format_type(a.atttypid, a.atttypmod),
       NOT a.attnotnull,
       EXISTS (SELECT 1 FROM pg_index i WHERE i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)),
       a.attnotnull AND EXISTS (SELECT 1 FROM pg_index u WHERE u.indrelid = c.oid AND u.indisunique
                                AND NOT u.indisprimary AND u.indnatts = 1 AND u.indkey[0] = a.attnum),
       ARRAY(SELECT e.enumlabel::text FROM pg_enum e WHERE e.enumtypid = a.atttypid ORDER BY e.enumsortorder),
       a.attnum::int8
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum"#;

const MY_COLUMNS: &str = r#"
SELECT COLUMN_NAME, DATA_TYPE, COLUMN_TYPE,
       IS_NULLABLE = 'YES',
       COLUMN_KEY = 'PRI',
       COLUMN_KEY = 'UNI' AND IS_NULLABLE = 'NO',
       ORDINAL_POSITION
FROM information_schema.COLUMNS
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
ORDER BY ORDINAL_POSITION"#;

const LITE_COLUMNS: &str = r#"
SELECT p.name, p.type, p."notnull" = 0, p.pk > 0,
       p."notnull" = 1 AND EXISTS (
         SELECT 1 FROM pragma_index_list(?1) il
         WHERE il."unique" = 1 AND il.origin <> 'pk'
           AND (SELECT count(*) FROM pragma_index_info(il.name)) = 1
           AND (SELECT ii.name FROM pragma_index_info(il.name) ii) = p.name),
       p.cid
FROM pragma_table_info(?1) p
ORDER BY p.cid"#;

/// MySQL COLUMN_TYPE "enum('a','b''c')" → ["a", "b'c"]
pub fn parse_mysql_enum(column_type: &str) -> Option<Vec<String>> {
    // SET은 여러 값을 고르는 타입이라 enum 목록으로 다루지 않는다 (텍스트로 편집)
    let inner = column_type.strip_prefix("enum(")?.strip_suffix(')')?;
    let mut out = Vec::new();
    let mut cur = String::new();
    let mut chars = inner.chars().peekable();
    let mut in_str = false;
    while let Some(ch) = chars.next() {
        match (in_str, ch) {
            (false, '\'') => in_str = true,
            (true, '\'') if chars.peek() == Some(&'\'') => {
                chars.next();
                cur.push('\'');
            }
            (true, '\'') => {
                in_str = false;
                out.push(std::mem::take(&mut cur));
            }
            (true, '\\') => {
                if let Some(n) = chars.next() {
                    cur.push(n);
                }
            }
            (true, c) => cur.push(c),
            (false, _) => {}
        }
    }
    Some(out)
}

pub async fn columns(pool: &DbPool, schema: &str, table: &str) -> AppResult<Vec<ColumnMeta>> {
    Ok(match pool {
        DbPool::Pg(p) => {
            let rows: Vec<(String, String, String, bool, bool, bool, Vec<String>, i64)> =
                sqlx::query_as(PG_COLUMNS).bind(schema).bind(table).fetch_all(p).await?;
            rows.into_iter()
                .map(|(name, data_type, full_type, nullable, is_pk, uniq, enums, ordinal)| ColumnMeta {
                    name,
                    data_type,
                    full_type,
                    nullable,
                    is_pk,
                    is_unique_not_null: uniq,
                    enum_values: if enums.is_empty() { None } else { Some(enums) },
                    ordinal,
                })
                .collect()
        }
        DbPool::My(p) => sqlx::query(MY_COLUMNS)
            .bind(schema)
            .bind(table)
            .fetch_all(p)
            .await?
            .iter()
            .map(|r| {
                let full_type = s(r, 2);
                let flag = |i: usize| r.try_get_unchecked::<Option<i64>, _>(i).ok().flatten().unwrap_or(0) != 0;
                ColumnMeta {
                    name: s(r, 0),
                    data_type: s(r, 1),
                    enum_values: parse_mysql_enum(&full_type),
                    full_type,
                    nullable: flag(3),
                    is_pk: flag(4),
                    is_unique_not_null: flag(5),
                    ordinal: r.try_get_unchecked::<Option<i64>, _>(6).ok().flatten().unwrap_or(0),
                }
            })
            .collect(),
        DbPool::Lite(p) => {
            let rows: Vec<(String, String, bool, bool, bool, i64)> =
                sqlx::query_as(LITE_COLUMNS).bind(table).fetch_all(p).await?;
            rows.into_iter()
                .map(|(name, ty, nullable, is_pk, uniq, cid)| ColumnMeta {
                    name,
                    data_type: ty.to_lowercase(),
                    full_type: ty,
                    nullable,
                    is_pk,
                    is_unique_not_null: uniq,
                    enum_values: None,
                    ordinal: cid + 1,
                })
                .collect()
        }
    })
}

const PG_INDEXES: &str = r#"
SELECT i.relname::text, ix.indisunique, ix.indisprimary, pg_get_indexdef(ix.indexrelid, k, true)
FROM pg_index ix
JOIN pg_class i ON i.oid = ix.indexrelid
JOIN pg_class c ON c.oid = ix.indrelid
JOIN pg_namespace n ON n.oid = c.relnamespace
CROSS JOIN LATERAL generate_series(1, ix.indnatts::int) k
WHERE n.nspname = $1 AND c.relname = $2
ORDER BY ix.indisprimary DESC, i.relname, k"#;

const MY_INDEXES: &str = r#"
SELECT INDEX_NAME, NON_UNIQUE = 0, INDEX_NAME = 'PRIMARY', COALESCE(COLUMN_NAME, '<expr>')
FROM information_schema.STATISTICS
WHERE TABLE_SCHEMA = ? AND TABLE_NAME = ?
ORDER BY INDEX_NAME = 'PRIMARY' DESC, INDEX_NAME, SEQ_IN_INDEX"#;

const LITE_INDEXES: &str = r#"
SELECT il.name, il."unique" = 1, il.origin = 'pk', coalesce(ii.name, '<expr>')
FROM pragma_index_list(?1) il JOIN pragma_index_info(il.name) ii
ORDER BY il.origin = 'pk' DESC, il.name, ii.seqno"#;

/// (인덱스, unique, primary, 컬럼) 행을 인덱스별로 묶는다. 같은 인덱스의 행은 연속해서 온다.
fn group_indexes(rows: impl IntoIterator<Item = (String, bool, bool, String)>) -> Vec<IndexInfo> {
    let mut out: Vec<IndexInfo> = Vec::new();
    for (name, unique, primary, col) in rows {
        match out.last_mut() {
            Some(i) if i.name == name => i.columns.push(col),
            _ => out.push(IndexInfo { name, columns: vec![col], unique, primary }),
        }
    }
    out
}

pub async fn indexes(pool: &DbPool, schema: &str, table: &str) -> AppResult<Vec<IndexInfo>> {
    Ok(match pool {
        DbPool::Pg(p) => {
            let rows: Vec<(String, bool, bool, String)> =
                sqlx::query_as(PG_INDEXES).bind(schema).bind(table).fetch_all(p).await?;
            group_indexes(rows)
        }
        DbPool::My(p) => {
            let rows = sqlx::query(MY_INDEXES).bind(schema).bind(table).fetch_all(p).await?;
            let flag = |r: &sqlx::mysql::MySqlRow, i: usize| r.try_get_unchecked::<Option<i64>, _>(i).ok().flatten().unwrap_or(0) != 0;
            group_indexes(rows.iter().map(|r| (s(r, 0), flag(r, 1), flag(r, 2), s(r, 3))))
        }
        DbPool::Lite(p) => {
            let rows: Vec<(String, bool, bool, String)> = sqlx::query_as(LITE_INDEXES).bind(table).fetch_all(p).await?;
            let mut out = group_indexes(rows);
            // INTEGER PRIMARY KEY(rowid 별칭)는 인덱스 목록에 없으므로 기본키를 따로 보여 준다
            if !out.iter().any(|i| i.primary) {
                let pk: Vec<(String,)> =
                    sqlx::query_as("SELECT name FROM pragma_table_info(?1) WHERE pk > 0 ORDER BY pk").bind(table).fetch_all(p).await?;
                if !pk.is_empty() {
                    let columns = pk.into_iter().map(|(c,)| c).collect();
                    out.insert(0, IndexInfo { name: "PRIMARY KEY".into(), columns, unique: true, primary: true });
                }
            }
            out
        }
    })
}

/// 자동완성용: 시스템 스키마를 제외한 모든 테이블과 컬럼 이름
pub async fn snapshot(pool: &DbPool) -> AppResult<Vec<SnapshotTable>> {
    let rows: Vec<(String, String, String)> = match pool {
        DbPool::Pg(p) => sqlx::query_as(
            "SELECT n.nspname::text, c.relname::text, a.attname::text
             FROM pg_attribute a JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
             WHERE c.relkind IN ('r','p','v','m','f') AND a.attnum > 0 AND NOT a.attisdropped
               AND n.nspname NOT LIKE 'pg\\_%' AND n.nspname <> 'information_schema'
             ORDER BY n.nspname, c.relname, a.attnum",
        )
        .fetch_all(p)
        .await?,
        DbPool::My(p) => sqlx::query(
            "SELECT TABLE_SCHEMA, TABLE_NAME, COLUMN_NAME FROM information_schema.COLUMNS
             WHERE TABLE_SCHEMA NOT IN ('mysql','information_schema','performance_schema','sys')
             ORDER BY TABLE_SCHEMA, TABLE_NAME, ORDINAL_POSITION",
        )
        .fetch_all(p)
        .await?
        .iter()
        .map(|r| (s(r, 0), s(r, 1), s(r, 2)))
        .collect(),
        DbPool::Lite(p) => sqlx::query_as(
            "SELECT 'main', m.name, p.name FROM sqlite_master m JOIN pragma_table_info(m.name) p
             WHERE m.type IN ('table','view') AND m.name NOT LIKE 'sqlite\\_%' ESCAPE '\\'
             ORDER BY m.name, p.cid",
        )
        .fetch_all(p)
        .await?,
    };
    let mut out: Vec<SnapshotTable> = Vec::new();
    for (schema, table, col) in rows {
        match out.last_mut() {
            Some(t) if t.schema == schema && t.table == table => t.columns.push(col),
            _ => out.push(SnapshotTable { schema, table, columns: vec![col] }),
        }
    }
    Ok(out)
}

#[cfg(test)]
mod tests {
    use super::*;
    use sqlx::sqlite::SqlitePoolOptions;

    #[test]
    fn mysql_enum() {
        assert_eq!(parse_mysql_enum("enum('sad','ok','it''s')").unwrap(), vec!["sad", "ok", "it's"]);
        assert!(parse_mysql_enum("varchar(10)").is_none());
        assert!(parse_mysql_enum("set('a','b')").is_none());
    }

    #[tokio::test]
    async fn sqlite_meta() {
        let p = SqlitePoolOptions::new().max_connections(1).connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql(
            "CREATE TABLE a (id INTEGER PRIMARY KEY, email TEXT NOT NULL UNIQUE, name TEXT);
             CREATE TABLE c (x INT, y INT, z TEXT, PRIMARY KEY (x, y));
             CREATE TABLE np (v TEXT);
             CREATE VIEW va AS SELECT id FROM a;",
        )
        .execute(&p)
        .await
        .unwrap();
        let pool = DbPool::Lite(p);
        let t = tables(&pool, "main").await.unwrap();
        assert_eq!(t.iter().map(|t| (t.name.as_str(), t.kind.as_str())).collect::<Vec<_>>(),
                   [("a", "TABLE"), ("c", "TABLE"), ("np", "TABLE"), ("va", "VIEW")]);
        let a = columns(&pool, "main", "a").await.unwrap();
        assert!(a[0].is_pk && !a[1].is_pk);
        assert!(a[1].is_unique_not_null && !a[1].nullable);
        assert!(a[2].nullable && !a[2].is_unique_not_null);
        let c = columns(&pool, "main", "c").await.unwrap();
        assert!(c[0].is_pk && c[1].is_pk && !c[2].is_pk);
        assert!(columns(&pool, "main", "nope").await.unwrap().is_empty());
        if let DbPool::Lite(p) = &pool {
            sqlx::raw_sql("CREATE INDEX a_name_email ON a (name, email); CREATE INDEX np_expr ON np (lower(v));")
                .execute(p)
                .await
                .unwrap();
        }
        let ia = indexes(&pool, "main", "a").await.unwrap();
        assert_eq!(ia[0], IndexInfo { name: "PRIMARY KEY".into(), columns: vec!["id".into()], unique: true, primary: true });
        assert!(ia.iter().any(|i| i.name == "a_name_email" && i.columns == ["name", "email"] && !i.unique));
        assert!(ia.iter().any(|i| i.unique && !i.primary && i.columns == ["email"]));
        let ic = indexes(&pool, "main", "c").await.unwrap();
        assert!(ic[0].primary && ic[0].columns == ["x", "y"] && ic[0].name != "PRIMARY KEY");
        assert_eq!(indexes(&pool, "main", "np").await.unwrap()[0].columns, ["<expr>"]);
        let snap = snapshot(&pool).await.unwrap();
        assert_eq!(snap.len(), 4);
        assert_eq!(snap[0].columns, ["id", "email", "name"]);
    }
}
