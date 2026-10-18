//! 구조 탭의 변경 → DDL 문장과 실행 (DESIGN.md "스키마 편집").

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::db::edit::{literal, quote_ident, table_ref};
use crate::db::pool::AnyConn;
use crate::db::structure::{ColumnDef, LiteAux, TableStructure};
use crate::error::{AppError, AppResult};
use crate::store::config::Driver;

#[derive(Serialize, Debug, Clone, PartialEq)]
pub struct DdlStmt {
    pub sql: String,
    /// 데이터가 사라지거나 바뀔 수 있는 문장 (미리보기에서 강조)
    pub destructive: bool,
}

#[derive(Serialize, Debug, Clone, Default)]
pub struct DdlPlan {
    pub statements: Vec<DdlStmt>,
    /// 데이터가 사라지거나 바뀔 수 있는 변경을 사람이 읽을 말로 (미리보기의 경고 상자)
    pub warnings: Vec<String>,
    /// 미리보기에 함께 보여 줄 안내
    pub notes: Vec<String>,
}

impl DdlPlan {
    fn push(&mut self, sql: String, destructive: bool) {
        self.statements.push(DdlStmt { sql, destructive });
    }
}

/// 원래 구조와 초안의 차이
struct Diff<'a> {
    drops: Vec<&'a ColumnDef>,
    /// 초안 순서. 원래 컬럼이 None이면 새 컬럼이다.
    items: Vec<(Option<&'a ColumnDef>, &'a ColumnDef)>,
    /// 컬럼 순서가 처음으로 달라지는 초안 위치 (기준: 남은 컬럼의 원래 순서 + 새 컬럼은 맨 뒤)
    first_moved: Option<usize>,
}

impl Diff<'_> {
    fn renamed(&self) -> HashMap<&str, &str> {
        self.items.iter().filter_map(|(a, b)| a.filter(|a| a.name != b.name).map(|a| (a.name.as_str(), b.name.as_str()))).collect()
    }
}

/// 이름을 뺀 정의가 같은지
fn same_def(a: &ColumnDef, b: &ColumnDef) -> bool {
    let strip = |c: &ColumnDef| ColumnDef { orig_name: None, name: String::new(), full_type: c.full_type.trim().to_string(), ..c.clone() };
    strip(a) == strip(b)
}

fn diff<'a>(d: Driver, orig: &'a TableStructure, draft: &'a TableStructure) -> AppResult<Diff<'a>> {
    let mut seen = HashSet::new();
    for c in &draft.columns {
        if c.name.trim().is_empty() {
            return Err(AppError::user("컬럼 이름이 비어 있습니다"));
        }
        if c.full_type.trim().is_empty() && d != Driver::Sqlite {
            return Err(AppError::user(format!("컬럼 {}의 타입이 비어 있습니다", c.name)));
        }
        if !seen.insert(c.name.to_lowercase()) {
            return Err(AppError::user(format!("컬럼 이름 {}이(가) 중복됩니다", c.name)));
        }
    }
    let mut used = HashSet::new();
    let mut items = Vec::with_capacity(draft.columns.len());
    for b in &draft.columns {
        let a = match &b.orig_name {
            None => None,
            Some(o) => {
                let a = orig.columns.iter().find(|c| &c.name == o).ok_or_else(|| AppError::user(format!("원래 컬럼 {o}을(를) 찾을 수 없습니다. 구조를 다시 읽어 주세요.")))?;
                if !used.insert(o.as_str()) {
                    return Err(AppError::user(format!("원래 컬럼 {o}이(가) 두 번 쓰였습니다")));
                }
                if a.generated && !(same_def(a, b) && a.name == b.name) {
                    return Err(AppError::user(format!("생성 컬럼 {o}은(는) 구조 탭에서 바꿀 수 없습니다. SQL로 직접 바꿔 주세요.")));
                }
                Some(a)
            }
        };
        if a.is_none() && b.generated {
            return Err(AppError::user("생성 컬럼은 구조 탭에서 만들 수 없습니다"));
        }
        items.push((a, b));
    }
    let drops: Vec<&ColumnDef> = orig.columns.iter().filter(|c| !used.contains(c.name.as_str())).collect();
    // 기준 순서: 남은 컬럼은 원래 순서, 새 컬럼은 초안 순서로 맨 뒤
    let pos_of = |name: &str| orig.columns.iter().position(|c| c.name == name).unwrap_or(usize::MAX);
    let mut baseline: Vec<usize> = (0..items.len()).filter(|&i| items[i].0.is_some()).collect();
    baseline.sort_by_key(|&i| pos_of(&items[i].0.unwrap().name));
    baseline.extend((0..items.len()).filter(|&i| items[i].0.is_none()));
    let first_moved = baseline.iter().enumerate().position(|(k, &i)| k != i);
    Ok(Diff { drops, items, first_moved })
}

/// 원래 구조 → 초안으로 바꾸는 문장들. SQLite 재생성에는 aux가 필요하다.
pub fn plan_alter(d: Driver, schema: Option<&str>, table: &str, orig: &TableStructure, draft: &TableStructure, aux: Option<&LiteAux>) -> AppResult<DdlPlan> {
    let diff = diff(d, orig, draft)?;
    let t = table_ref(d, schema, table);
    let mut plan = match d {
        Driver::Postgres => pg_plan(&t, &diff),
        Driver::Mysql => my_plan(&t, &diff),
        Driver::Sqlite => lite_plan(table, orig, &diff, aux.ok_or_else(|| AppError::user("SQLite 테이블 정보가 없습니다"))?),
        _ => Err(AppError::user("SQL 접속이 아닙니다")),
    }?;
    let mut warnings: Vec<String> = diff.drops.iter().map(|c| format!("컬럼 {} 삭제: 이 컬럼의 데이터가 사라집니다.", c.name)).collect();
    for (a, b) in &diff.items {
        if let Some(a) = a.filter(|a| !a.full_type.trim().eq_ignore_ascii_case(b.full_type.trim())) {
            warnings.push(format!("컬럼 {} 타입 변경 ({} → {}): 값이 바뀌거나 변환에 실패할 수 있습니다.", b.name, a.full_type.trim(), b.full_type.trim()));
        }
    }
    if plan.statements.iter().any(|s| s.sql.starts_with("DROP TABLE")) {
        warnings.push("테이블을 새로 만들어 데이터를 옮긴 뒤 원래 테이블을 삭제합니다(DROP TABLE). 실패하면 모두 롤백됩니다.".into());
    }
    warnings.append(&mut plan.warnings);
    plan.warnings = warnings;
    Ok(plan)
}

// ---------------------------------------------------------------- PostgreSQL

fn pg_type(c: &ColumnDef) -> String {
    let mut s = c.full_type.trim().to_string();
    if let Some(co) = &c.collation {
        s += &format!(" COLLATE {}", quote_ident(Driver::Postgres, co));
    }
    s
}

fn pg_check(c: &ColumnDef) -> AppResult<()> {
    if c.auto_increment && c.nullable {
        return Err(AppError::user(format!("자동 증가 컬럼 {}은(는) NULL을 허용할 수 없습니다", c.name)));
    }
    if c.auto_increment && c.default.is_some() {
        return Err(AppError::user(format!("자동 증가 컬럼 {}에는 기본값을 둘 수 없습니다", c.name)));
    }
    Ok(())
}

fn comment_on(t: &str, c: &str, comment: Option<&str>) -> String {
    let v = comment.map_or("NULL".to_string(), |s| literal(Driver::Postgres, Some(s)));
    format!("COMMENT ON COLUMN {t}.{c} IS {v}")
}

fn pg_plan(t: &str, d: &Diff) -> AppResult<DdlPlan> {
    if d.first_moved.is_some() {
        return Err(AppError::user("PostgreSQL은 컬럼 순서를 바꿀 수 없습니다. 새 컬럼은 맨 뒤에 추가됩니다."));
    }
    let q = |s: &str| quote_ident(Driver::Postgres, s);
    let mut p = DdlPlan::default();
    for c in &d.drops {
        p.push(format!("ALTER TABLE {t} DROP COLUMN {}", q(&c.name)), true);
    }
    for (a, b) in &d.items {
        pg_check(b)?;
        let c = q(&b.name);
        let Some(a) = a else {
            let mut s = format!("ALTER TABLE {t} ADD COLUMN {c} {}", pg_type(b));
            if b.auto_increment {
                s += " GENERATED BY DEFAULT AS IDENTITY";
            }
            if !b.nullable {
                s += " NOT NULL";
            }
            if let Some(e) = &b.default {
                s += &format!(" DEFAULT {e}");
            }
            p.push(s, false);
            if b.comment.is_some() {
                p.push(comment_on(t, &c, b.comment.as_deref()), false);
            }
            continue;
        };
        if a.name != b.name {
            p.push(format!("ALTER TABLE {t} RENAME COLUMN {} TO {c}", q(&a.name)), false);
        }
        if a.full_type.trim() != b.full_type.trim() || a.collation != b.collation {
            let ty = b.full_type.trim();
            p.push(format!("ALTER TABLE {t} ALTER COLUMN {c} TYPE {} USING {c}::{ty}", pg_type(b)), true);
        }
        if a.auto_increment && !b.auto_increment {
            p.push(format!("ALTER TABLE {t} ALTER COLUMN {c} DROP IDENTITY IF EXISTS"), false);
        }
        if a.default != b.default {
            p.push(
                match &b.default {
                    Some(e) => format!("ALTER TABLE {t} ALTER COLUMN {c} SET DEFAULT {e}"),
                    None => format!("ALTER TABLE {t} ALTER COLUMN {c} DROP DEFAULT"),
                },
                false,
            );
        }
        if a.nullable != b.nullable {
            p.push(format!("ALTER TABLE {t} ALTER COLUMN {c} {} NOT NULL", if b.nullable { "DROP" } else { "SET" }), false);
        }
        if !a.auto_increment && b.auto_increment {
            p.push(format!("ALTER TABLE {t} ALTER COLUMN {c} ADD GENERATED BY DEFAULT AS IDENTITY"), false);
        }
        if a.comment != b.comment {
            p.push(comment_on(t, &c, b.comment.as_deref()), false);
        }
    }
    Ok(p)
}

// ---------------------------------------------------------------- MySQL

const MY_TEXTUAL: &[&str] = &["char", "varchar", "tinytext", "text", "mediumtext", "longtext", "enum", "set"];

fn my_textual(ty: &str) -> bool {
    let base = ty.trim().split(|c: char| c == '(' || c.is_whitespace()).next().unwrap_or("").to_ascii_lowercase();
    MY_TEXTUAL.contains(&base.as_str())
}

/// 컬럼 전체 정의. MODIFY/CHANGE는 정의를 통째로 바꾸므로 코멘트·문자셋·ON UPDATE도 다시 쓴다.
fn my_col_def(c: &ColumnDef) -> String {
    let mut s = format!("{} {}", quote_ident(Driver::Mysql, &c.name), c.full_type.trim());
    if my_textual(&c.full_type) {
        if let Some(cs) = &c.charset {
            s += &format!(" CHARACTER SET {cs}");
        }
        if let Some(co) = &c.collation {
            s += &format!(" COLLATE {co}");
        }
    }
    s += if c.nullable { " NULL" } else { " NOT NULL" };
    if let Some(e) = &c.default {
        s += &format!(" DEFAULT {e}");
    }
    if let Some(u) = &c.on_update {
        s += &format!(" ON UPDATE {u}");
    }
    if c.auto_increment {
        s += " AUTO_INCREMENT";
    }
    if let Some(cm) = &c.comment {
        s += &format!(" COMMENT {}", literal(Driver::Mysql, Some(cm)));
    }
    s
}

/// 한 테이블의 변경을 ALTER TABLE 한 문장으로 묶는다 (MySQL DDL은 문장마다 암묵 커밋되므로).
fn my_plan(t: &str, d: &Diff) -> AppResult<DdlPlan> {
    let q = |s: &str| quote_ident(Driver::Mysql, s);
    let mut clauses = Vec::new();
    let mut destructive = false;
    for c in &d.drops {
        clauses.push(format!("DROP COLUMN {}", q(&c.name)));
        destructive = true;
    }
    for (k, (a, b)) in d.items.iter().enumerate() {
        let pos = match d.first_moved {
            Some(m) if k >= m => Some(if k == 0 { " FIRST".to_string() } else { format!(" AFTER {}", q(&d.items[k - 1].1.name)) }),
            _ => None,
        };
        let pos_s = pos.clone().unwrap_or_default();
        match a {
            None => clauses.push(format!("ADD COLUMN {}{pos_s}", my_col_def(b))),
            Some(a) if a.generated => {
                if pos.is_some() {
                    return Err(AppError::user(format!("생성 컬럼 {}의 위치는 구조 탭에서 바꿀 수 없습니다", a.name)));
                }
            }
            Some(a) if a.name != b.name => {
                clauses.push(format!("CHANGE COLUMN {} {}{pos_s}", q(&a.name), my_col_def(b)));
                destructive |= !a.full_type.trim().eq_ignore_ascii_case(b.full_type.trim());
            }
            Some(a) if !same_def(a, b) || pos.is_some() => {
                clauses.push(format!("MODIFY COLUMN {}{pos_s}", my_col_def(b)));
                destructive |= !a.full_type.trim().eq_ignore_ascii_case(b.full_type.trim());
            }
            Some(_) => {}
        }
    }
    let mut p = DdlPlan::default();
    if !clauses.is_empty() {
        p.push(format!("ALTER TABLE {t}\n  {}", clauses.join(",\n  ")), destructive);
    }
    Ok(p)
}

// ---------------------------------------------------------------- SQLite

enum Tok<'a> {
    Word(&'a str),
    Punct(char, usize),
}

/// SQLite DDL 토큰. 문자열·따옴표 식별자·주석은 건너뛴다.
fn sqlite_tokens(sql: &str) -> Vec<Tok<'_>> {
    let b = sql.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        match c {
            b'\'' | b'"' | b'`' | b'[' => {
                let close = if c == b'[' { b']' } else { c };
                i += 1;
                while i < b.len() {
                    if b[i] == close {
                        // 같은 따옴표 두 개는 이스케이프
                        if close != b']' && b.get(i + 1) == Some(&close) {
                            i += 2;
                            continue;
                        }
                        break;
                    }
                    i += 1;
                }
                i += 1;
            }
            b'-' if b.get(i + 1) == Some(&b'-') => {
                while i < b.len() && b[i] != b'\n' {
                    i += 1;
                }
            }
            b'/' if b.get(i + 1) == Some(&b'*') => {
                i += 2;
                while i < b.len() && !(b[i] == b'*' && b.get(i + 1) == Some(&b'/')) {
                    i += 1;
                }
                i += 2;
            }
            _ if c.is_ascii_alphanumeric() || c == b'_' || c >= 0x80 => {
                let s = i;
                while i < b.len() && (b[i].is_ascii_alphanumeric() || b[i] == b'_' || b[i] >= 0x80) {
                    i += 1;
                }
                out.push(Tok::Word(&sql[s..i]));
            }
            _ => {
                if !c.is_ascii_whitespace() {
                    out.push(Tok::Punct(c as char, i));
                }
                i += 1;
            }
        }
    }
    out
}

/// CREATE 문의 낱말들 (대문자)
pub fn sqlite_words(sql: &str) -> Vec<String> {
    sqlite_tokens(sql)
        .into_iter()
        .filter_map(|t| match t {
            Tok::Word(w) => Some(w.to_ascii_uppercase()),
            _ => None,
        })
        .collect()
}

/// 컬럼 목록 괄호 뒤의 테이블 옵션 (WITHOUT ROWID, STRICT)
fn sqlite_tail(sql: &str) -> String {
    let mut depth = 0;
    for t in sqlite_tokens(sql) {
        match t {
            Tok::Punct('(', _) => depth += 1,
            Tok::Punct(')', at) => {
                depth -= 1;
                if depth == 0 {
                    let rest = sql[at + 1..].trim().trim_end_matches(';').trim();
                    return if rest.is_empty() { String::new() } else { format!(" {rest}") };
                }
            }
            _ => {}
        }
    }
    String::new()
}

/// 재생성할 때 옮길 수 없는 정의 (구조 탭이 모델링하지 않아 잃어버리게 되는 것)
const LITE_UNSUPPORTED: &[&str] = &["CHECK", "COLLATE", "CONFLICT", "GENERATED", "DEFERRABLE"];

fn lite_col_def(c: &ColumnDef, inline_pk: bool) -> String {
    let q = |s: &str| quote_ident(Driver::Sqlite, s);
    let mut s = q(&c.name);
    if !c.full_type.trim().is_empty() {
        s += &format!(" {}", c.full_type.trim());
    }
    if inline_pk {
        s += " PRIMARY KEY AUTOINCREMENT";
    }
    if !c.nullable {
        s += " NOT NULL";
    }
    if let Some(e) = &c.default {
        s += &format!(" DEFAULT {e}");
    }
    s
}

fn lite_plan(table: &str, orig: &TableStructure, d: &Diff, aux: &LiteAux) -> AppResult<DdlPlan> {
    let q = |s: &str| quote_ident(Driver::Sqlite, s);
    let t = q(table);
    let dropped: HashSet<&str> = d.drops.iter().map(|c| c.name.as_str()).collect();
    let in_use = |name: &str| {
        orig.primary_key.iter().any(|p| p == name)
            || aux.indexes.iter().any(|ix| ix.keys.iter().any(|k| k.0.as_deref() == Some(name)))
            || aux.fks.iter().any(|f| f.from.iter().any(|x| x == name))
    };
    let simple = d.first_moved.is_none()
        && d.items.iter().all(|(a, b)| match a {
            Some(a) => same_def(a, b),
            None => !b.auto_increment && (b.nullable || b.default.is_some()),
        })
        && d.drops.iter().all(|c| !in_use(&c.name));
    let mut p = DdlPlan::default();
    if simple {
        for (a, b) in &d.items {
            if let Some(a) = a.filter(|a| a.name != b.name) {
                p.push(format!("ALTER TABLE {t} RENAME COLUMN {} TO {}", q(&a.name), q(&b.name)), false);
            }
        }
        for c in &d.drops {
            p.push(format!("ALTER TABLE {t} DROP COLUMN {}", q(&c.name)), true);
        }
        for (a, b) in &d.items {
            if a.is_none() {
                p.push(format!("ALTER TABLE {t} ADD COLUMN {}", lite_col_def(b, false)), false);
            }
        }
        return Ok(p);
    }

    // 재생성 (https://www.sqlite.org/lang_altertable.html#otheralter)
    let words = sqlite_words(&aux.create_sql);
    if let Some(w) = LITE_UNSUPPORTED.iter().find(|w| words.iter().any(|x| x == *w)) {
        return Err(AppError::user(format!(
            "이 테이블에는 구조 탭이 아직 다루지 않는 정의({w})가 있어 다시 만들 수 없습니다. SQL로 직접 바꿔 주세요."
        )));
    }
    let renamed = d.renamed();
    let new_name = |old: &str| renamed.get(old).copied().unwrap_or(old).to_string();
    p.notes.push("SQLite는 이 변경을 ALTER로 할 수 없어 테이블을 새로 만들고 데이터를 옮깁니다.".into());

    let mut pk: Vec<String> = orig.primary_key.iter().map(|c| new_name(c)).collect();
    if let Some(c) = orig.primary_key.iter().find(|c| dropped.contains(c.as_str())) {
        p.notes.push(format!("기본키 컬럼 {c}을(를) 삭제하므로 기본키가 없어집니다."));
        pk.clear();
    }
    let autos: Vec<&ColumnDef> = d.items.iter().map(|(_, b)| *b).filter(|b| b.auto_increment).collect();
    if let Some(a) = autos.first() {
        if autos.len() > 1 || pk != [a.name.clone()] || !a.full_type.trim().eq_ignore_ascii_case("INTEGER") {
            return Err(AppError::user("SQLite 자동 증가는 INTEGER 타입의 단일 기본키 컬럼에만 쓸 수 있습니다"));
        }
    }
    let inline_pk = autos.first().map(|a| a.name.clone());

    let mut lines: Vec<String> = d.items.iter().map(|(_, b)| lite_col_def(b, inline_pk.as_deref() == Some(&b.name))).collect();
    if !pk.is_empty() && inline_pk.is_none() {
        lines.push(format!("PRIMARY KEY ({})", pk.iter().map(|c| q(c)).collect::<Vec<_>>().join(", ")));
    }
    for ix in aux.indexes.iter().filter(|ix| ix.origin == "u") {
        let cols: Option<Vec<&str>> = ix.keys.iter().map(|k| k.0.as_deref()).collect();
        match cols {
            Some(cols) if !cols.iter().any(|c| dropped.contains(c)) => {
                lines.push(format!("UNIQUE ({})", cols.iter().map(|c| q(&new_name(c))).collect::<Vec<_>>().join(", ")))
            }
            _ => p.notes.push(format!("UNIQUE 제약 ({})은 삭제한 컬럼을 써서 없어집니다.", ix.keys.iter().filter_map(|k| k.0.clone()).collect::<Vec<_>>().join(", "))),
        }
    }
    for fk in &aux.fks {
        if let Some(c) = fk.from.iter().find(|c| dropped.contains(c.as_str())) {
            p.notes.push(format!("컬럼 {c}의 외래 키({} 참조)는 삭제한 컬럼을 써서 없어집니다.", fk.table));
            continue;
        }
        let from = fk.from.iter().map(|c| q(&new_name(c))).collect::<Vec<_>>().join(", ");
        let to = if fk.to.iter().all(|c| c.is_none()) {
            String::new()
        } else {
            format!(" ({})", fk.to.iter().map(|c| q(c.as_deref().unwrap_or(""))).collect::<Vec<_>>().join(", "))
        };
        let mut s = format!("FOREIGN KEY ({from}) REFERENCES {}{to}", q(&fk.table));
        if fk.on_update != "NO ACTION" {
            s += &format!(" ON UPDATE {}", fk.on_update);
        }
        if fk.on_delete != "NO ACTION" {
            s += &format!(" ON DELETE {}", fk.on_delete);
        }
        lines.push(s);
    }

    let tmp = q(&format!("_dbc_new_{table}"));
    p.push(format!("CREATE TABLE {tmp} (\n  {}\n){}", lines.join(",\n  "), sqlite_tail(&aux.create_sql)), false);
    let kept: Vec<(&ColumnDef, &ColumnDef)> = d.items.iter().filter_map(|(a, b)| a.map(|a| (a, *b))).collect();
    if !kept.is_empty() {
        let to = kept.iter().map(|(_, b)| q(&b.name)).collect::<Vec<_>>().join(", ");
        let from = kept.iter().map(|(a, _)| q(&a.name)).collect::<Vec<_>>().join(", ");
        p.push(format!("INSERT INTO {tmp} ({to})\n  SELECT {from} FROM {t}"), false);
    }
    p.push(format!("DROP TABLE {t}"), true);
    p.push(format!("ALTER TABLE {tmp} RENAME TO {t}"), false);

    for ix in aux.indexes.iter().filter(|ix| ix.origin == "c") {
        let Some(sql) = &ix.sql else { continue };
        if ix.keys.iter().any(|k| k.0.as_deref().is_some_and(|c| dropped.contains(c))) {
            p.notes.push(format!("인덱스 {}는 삭제한 컬럼을 써서 다시 만들지 않습니다.", ix.name));
            continue;
        }
        let touched = ix.keys.iter().any(|k| k.0.as_deref().is_some_and(|c| renamed.contains_key(c)));
        let plain = !ix.partial && ix.keys.iter().all(|k| k.0.is_some());
        if touched && plain {
            let keys = ix
                .keys
                .iter()
                .map(|(c, coll, desc)| {
                    let mut s = q(&new_name(c.as_deref().unwrap_or("")));
                    if !coll.is_empty() && !coll.eq_ignore_ascii_case("BINARY") {
                        s += &format!(" COLLATE {coll}");
                    }
                    if *desc {
                        s += " DESC";
                    }
                    s
                })
                .collect::<Vec<_>>()
                .join(", ");
            p.push(format!("CREATE {}INDEX {} ON {t} ({keys})", if ix.unique { "UNIQUE " } else { "" }, q(&ix.name)), false);
        } else {
            if !renamed.is_empty() && !plain {
                p.notes.push(format!("인덱스 {}는 원문 그대로 다시 만듭니다. 이름을 바꾼 컬럼을 식이나 조건에서 쓰면 실패하니 SQL을 고쳐 주세요.", ix.name));
            }
            p.push(sql.clone(), false);
        }
    }
    if !aux.triggers.is_empty() && (!renamed.is_empty() || !dropped.is_empty()) {
        p.notes.push("트리거는 원문 그대로 다시 만듭니다. 이름을 바꾸거나 삭제한 컬럼을 쓰는 트리거는 SQL을 고쳐 주세요.".into());
    }
    for tr in &aux.triggers {
        p.push(tr.clone(), false);
    }
    Ok(p)
}

// ---------------------------------------------------------------- 실행

fn failed(e: impl std::fmt::Display, i: usize, tail: &str) -> AppError {
    AppError::Submit { message: format!("{e}\n{tail}"), change_index: i, affected: 0 }
}

/// 한 트랜잭션으로 실행한다 (PG·SQLite). SQLite는 커밋 전에 외래 키 검사를 한다.
async fn run_in_tx(conn: &mut AnyConn<'_>, stmts: &[String], fk_check: bool) -> AppResult<()> {
    conn.execute_raw("BEGIN").await?;
    let mut body = Ok(());
    for (i, s) in stmts.iter().enumerate() {
        if let Err(e) = conn.execute_raw(s).await {
            body = Err(failed(e, i, "모든 변경을 롤백했습니다."));
            break;
        }
    }
    if body.is_ok() && fk_check {
        if let AnyConn::Lite(c) = conn {
            match sqlx::query("PRAGMA foreign_key_check").fetch_all(&mut **c).await {
                Ok(rows) if !rows.is_empty() => body = Err(AppError::user(format!("외래 키가 어긋나는 행이 {}개 있어 모든 변경을 롤백했습니다.", rows.len()))),
                Ok(_) => {}
                Err(e) => body = Err(e.into()),
            }
        }
    }
    match body {
        Ok(()) => match conn.execute_raw("COMMIT").await {
            Ok(_) => Ok(()),
            Err(e) => {
                let _ = conn.execute_raw("ROLLBACK").await;
                Err(e)
            }
        },
        Err(e) => {
            let _ = conn.execute_raw("ROLLBACK").await;
            Err(e)
        }
    }
}

async fn lite_pragma(conn: &mut AnyConn<'_>, name: &str) -> AppResult<i64> {
    match conn {
        AnyConn::Lite(c) => Ok(sqlx::query_scalar(&format!("PRAGMA {name}")).fetch_one(&mut **c).await?),
        _ => Ok(0),
    }
}

/// DDL 문장들을 실행한다. 자동 커밋 연결(콘솔의 Manual 트랜잭션과 무관한 연결)을 받는다.
/// - PG·SQLite: 하나의 트랜잭션. 실패하면 모두 롤백.
/// - MySQL: DDL은 암묵 커밋이라 차례로 실행하고, 실패하면 어디까지 반영됐는지 알린다.
pub async fn apply(conn: &mut AnyConn<'_>, stmts: &[String]) -> AppResult<()> {
    if stmts.is_empty() {
        return Err(AppError::user("실행할 문장이 없습니다"));
    }
    match conn {
        AnyConn::My(_) => {
            for (i, s) in stmts.iter().enumerate() {
                if let Err(e) = conn.execute_raw(s).await {
                    let tail = if i == 0 { "반영된 문장은 없습니다.".to_string() } else { format!("앞의 {i}개 문장은 이미 반영되었습니다 (MySQL DDL은 되돌릴 수 없습니다).") };
                    return Err(failed(e, i, &tail));
                }
            }
            Ok(())
        }
        AnyConn::Pg(_) => run_in_tx(conn, stmts, false).await,
        AnyConn::Lite(_) => {
            // 재생성 중 DROP TABLE이 외래 키 동작을 일으키지 않게 끄고(트랜잭션 밖에서만 바꿀 수 있다),
            // 이 테이블을 참조하는 뷰 때문에 RENAME이 실패하지 않게 legacy_alter_table을 켠다.
            let fk = lite_pragma(conn, "foreign_keys").await?;
            let legacy = lite_pragma(conn, "legacy_alter_table").await?;
            conn.execute_raw("PRAGMA foreign_keys = OFF").await?;
            conn.execute_raw("PRAGMA legacy_alter_table = ON").await?;
            let r = run_in_tx(conn, stmts, fk != 0).await;
            let _ = conn.execute_raw(&format!("PRAGMA legacy_alter_table = {legacy}")).await;
            let _ = conn.execute_raw(&format!("PRAGMA foreign_keys = {fk}")).await;
            r
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::db::structure::{load_sqlite, load_sqlite_aux};
    use sqlx::{Connection, SqliteConnection};

    fn col(name: &str, ty: &str) -> ColumnDef {
        ColumnDef { orig_name: Some(name.into()), name: name.into(), full_type: ty.into(), nullable: true, ..Default::default() }
    }
    fn new_col(name: &str, ty: &str) -> ColumnDef {
        ColumnDef { orig_name: None, ..col(name, ty) }
    }
    fn st(cols: Vec<ColumnDef>, pk: &[&str]) -> TableStructure {
        TableStructure { columns: cols, primary_key: pk.iter().map(|s| s.to_string()).collect() }
    }
    fn sqls(p: &DdlPlan) -> Vec<&str> {
        p.statements.iter().map(|s| s.sql.as_str()).collect()
    }

    #[test]
    fn pg_columns() {
        let a = st(vec![col("id", "integer"), col("name", "text"), col("old", "text")], &["id"]);
        let mut b = a.clone();
        b.columns.remove(2);
        b.columns[1].name = "full name".into();
        b.columns[1].full_type = "varchar(100)".into();
        b.columns[1].nullable = false;
        b.columns[1].default = Some("'x'".into());
        b.columns[0].auto_increment = true;
        b.columns[0].nullable = false;
        b.columns.push(ColumnDef { nullable: false, default: Some("0".into()), comment: Some("it's".into()), ..new_col("qty", "int") });
        let p = plan_alter(Driver::Postgres, Some("public"), "t", &a, &b, None).unwrap();
        assert_eq!(
            sqls(&p),
            [
                r#"ALTER TABLE "public"."t" DROP COLUMN "old""#,
                r#"ALTER TABLE "public"."t" ALTER COLUMN "id" SET NOT NULL"#,
                r#"ALTER TABLE "public"."t" ALTER COLUMN "id" ADD GENERATED BY DEFAULT AS IDENTITY"#,
                r#"ALTER TABLE "public"."t" RENAME COLUMN "name" TO "full name""#,
                r#"ALTER TABLE "public"."t" ALTER COLUMN "full name" TYPE varchar(100) USING "full name"::varchar(100)"#,
                r#"ALTER TABLE "public"."t" ALTER COLUMN "full name" SET DEFAULT 'x'"#,
                r#"ALTER TABLE "public"."t" ALTER COLUMN "full name" SET NOT NULL"#,
                r#"ALTER TABLE "public"."t" ADD COLUMN "qty" int NOT NULL DEFAULT 0"#,
                r#"COMMENT ON COLUMN "public"."t"."qty" IS 'it''s'"#,
            ]
        );
        assert!(p.statements[0].destructive && p.statements[4].destructive && !p.statements[3].destructive);
        assert_eq!(p.warnings.len(), 2);
        assert!(p.warnings[0].contains("old") && p.warnings[1].contains("text → varchar(100)"));
        // 순서 변경은 거부
        let mut moved = a.clone();
        moved.columns.swap(0, 1);
        assert!(plan_alter(Driver::Postgres, Some("public"), "t", &a, &moved, None).is_err());
        // 변경 없음
        assert!(plan_alter(Driver::Postgres, Some("public"), "t", &a, &a, None).unwrap().statements.is_empty());
    }

    #[test]
    fn mysql_one_statement() {
        let mut name = col("name", "varchar(50)");
        name.charset = Some("latin1".into());
        name.collation = Some("latin1_swedish_ci".into());
        name.comment = Some("a\\b".into());
        let mut ts = col("ts", "timestamp");
        ts.default = Some("CURRENT_TIMESTAMP".into());
        ts.on_update = Some("CURRENT_TIMESTAMP".into());
        let a = st(vec![col("id", "int"), name, ts, col("gone", "int")], &["id"]);
        let mut b = a.clone();
        b.columns.remove(3);
        b.columns[1].name = "nm".into();
        b.columns[2].nullable = false;
        b.columns.insert(1, new_col("x`y", "int"));
        let p = plan_alter(Driver::Mysql, Some("db"), "t", &a, &b, None).unwrap();
        assert_eq!(
            sqls(&p),
            ["ALTER TABLE `db`.`t`\n  DROP COLUMN `gone`,\n  ADD COLUMN `x``y` int NULL AFTER `id`,\n  CHANGE COLUMN `name` `nm` varchar(50) CHARACTER SET latin1 COLLATE latin1_swedish_ci NULL COMMENT 'a\\\\b' AFTER `x``y`,\n  MODIFY COLUMN `ts` timestamp NOT NULL DEFAULT CURRENT_TIMESTAMP ON UPDATE CURRENT_TIMESTAMP AFTER `nm`"]
        );
        assert!(p.statements[0].destructive);
        // 맨 앞으로 이동
        let mut first = a.clone();
        first.columns.swap(0, 1);
        assert_eq!(sqls(&plan_alter(Driver::Mysql, Some("db"), "t", &a, &first, None).unwrap())[0].lines().nth(1).unwrap().trim(), "MODIFY COLUMN `name` varchar(50) CHARACTER SET latin1 COLLATE latin1_swedish_ci NULL COMMENT 'a\\\\b' FIRST,");
        // 문자열이 아닌 타입으로 바꾸면 문자셋을 붙이지 않는다
        let mut num = a.clone();
        num.columns[1].full_type = "int".into();
        assert!(sqls(&plan_alter(Driver::Mysql, None, "t", &a, &num, None).unwrap())[0].contains("MODIFY COLUMN `name` int NULL COMMENT"));
    }

    #[test]
    fn validation() {
        let a = st(vec![col("id", "int")], &[]);
        let dup = st(vec![col("id", "int"), new_col("ID", "int")], &[]);
        assert!(plan_alter(Driver::Mysql, None, "t", &a, &dup, None).is_err());
        let empty = st(vec![new_col("x", " ")], &[]);
        assert!(plan_alter(Driver::Postgres, None, "t", &a, &empty, None).is_err());
        let mut g = a.clone();
        g.columns[0].generated = true;
        let mut g2 = g.clone();
        g2.columns[0].name = "id2".into();
        assert!(plan_alter(Driver::Postgres, None, "t", &g, &g2, None).is_err());
    }

    #[test]
    fn sqlite_scanner() {
        let sql = "CREATE TABLE \"a(b\" (x 'CHECK', y INT /* COLLATE */ -- GENERATED\n, [z)] TEXT) WITHOUT ROWID;";
        assert_eq!(sqlite_words(sql), ["CREATE", "TABLE", "x", "y", "INT", "TEXT", "WITHOUT", "ROWID"].map(|s| s.to_uppercase()));
        assert_eq!(sqlite_tail(sql), " WITHOUT ROWID");
        assert_eq!(sqlite_tail("CREATE TABLE t (a, b)"), "");
    }

    async fn db(sql: &str) -> SqliteConnection {
        let mut c = SqliteConnection::connect("sqlite::memory:").await.unwrap();
        sqlx::raw_sql("PRAGMA foreign_keys = ON").execute(&mut c).await.unwrap();
        sqlx::raw_sql(sql).execute(&mut c).await.unwrap();
        c
    }

    async fn plan_and_apply(c: &mut SqliteConnection, table: &str, edit: impl FnOnce(&mut TableStructure)) -> AppResult<DdlPlan> {
        let a = load_sqlite(c, table).await.unwrap();
        let aux = load_sqlite_aux(c, table).await.unwrap();
        let mut b = a.clone();
        edit(&mut b);
        let p = plan_alter(Driver::Sqlite, None, table, &a, &b, Some(&aux))?;
        let stmts: Vec<String> = p.statements.iter().map(|s| s.sql.clone()).collect();
        apply(&mut AnyConn::Lite(c), &stmts).await?;
        Ok(p)
    }

    async fn rows(c: &mut SqliteConnection, sql: &str) -> Vec<(String,)> {
        sqlx::query_as(sql).fetch_all(c).await.unwrap()
    }

    #[tokio::test]
    async fn sqlite_simple_alter() {
        let mut c = db("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT, junk TEXT); INSERT INTO t VALUES (1, 'a', 'j');").await;
        let p = plan_and_apply(&mut c, "t", |b| {
            b.columns[1].name = "nm".into();
            b.columns.remove(2);
            b.columns.push(ColumnDef { default: Some("'d'".into()), nullable: false, ..new_col("extra", "TEXT") });
        })
        .await
        .unwrap();
        assert!(p.notes.is_empty(), "ALTER만으로 처리해야 한다");
        assert_eq!(rows(&mut c, "SELECT nm || ',' || extra FROM t").await, [("a,d".to_string(),)]);
    }

    #[tokio::test]
    async fn sqlite_rebuild_keeps_data_indexes_fks_triggers() {
        let mut c = db(
            "CREATE TABLE p (id INTEGER PRIMARY KEY);
             INSERT INTO p VALUES (1), (2);
             CREATE TABLE t (id INTEGER PRIMARY KEY AUTOINCREMENT, pid INTEGER REFERENCES p(id) ON DELETE CASCADE,
                             name TEXT, qty TEXT DEFAULT '0', UNIQUE (name));
             CREATE INDEX t_qty ON t (qty DESC);
             CREATE INDEX t_lower ON t (lower(name));
             CREATE TABLE log (m TEXT);
             CREATE TRIGGER t_ins AFTER INSERT ON t BEGIN INSERT INTO log VALUES ('ins'); END;
             CREATE VIEW v AS SELECT id FROM t;
             INSERT INTO t (pid, name, qty) VALUES (1, 'a', '5'), (2, 'b', '7');",
        )
        .await;
        let p = plan_and_apply(&mut c, "t", |b| {
            b.columns[3].name = "amount".into();
            b.columns[3].full_type = "INTEGER".into();
            b.columns[3].nullable = false;
            b.columns.swap(1, 2);
        })
        .await
        .unwrap();
        assert!(sqls(&p).iter().any(|s| s.starts_with("DROP TABLE")));
        assert_eq!(rows(&mut c, "SELECT group_concat(name || amount, ',') FROM t").await, [("a5,b7".to_string(),)]);
        let s = load_sqlite(&mut c, "t").await.unwrap();
        assert_eq!(s.columns.iter().map(|c| c.name.as_str()).collect::<Vec<_>>(), ["id", "name", "pid", "amount"]);
        assert!(s.columns[0].auto_increment && !s.columns[3].nullable && s.columns[3].full_type == "INTEGER");
        let aux = load_sqlite_aux(&mut c, "t").await.unwrap();
        let qty = aux.indexes.iter().find(|i| i.name == "t_qty").unwrap();
        assert_eq!(qty.keys, [(Some("amount".to_string()), "BINARY".to_string(), true)]);
        assert!(aux.indexes.iter().any(|i| i.name == "t_lower"));
        assert!(aux.indexes.iter().any(|i| i.origin == "u"));
        assert_eq!(aux.fks.len(), 1);
        assert_eq!(aux.fks[0].on_delete, "CASCADE");
        assert_eq!(aux.triggers.len(), 1);
        // 뷰와 외래 키 동작이 그대로다
        assert_eq!(rows(&mut c, "SELECT CAST(count(*) AS TEXT) FROM v").await, [("2".to_string(),)]);
        sqlx::raw_sql("DELETE FROM p WHERE id = 1").execute(&mut c).await.unwrap();
        assert_eq!(rows(&mut c, "SELECT name FROM t").await, [("b".to_string(),)]);
        let fk_on: i64 = sqlx::query_scalar("PRAGMA foreign_keys").fetch_one(&mut c).await.unwrap();
        assert_eq!(fk_on, 1);
    }

    #[tokio::test]
    async fn sqlite_rebuild_failure_keeps_table() {
        let mut c = db("CREATE TABLE t (id INTEGER PRIMARY KEY, name TEXT); INSERT INTO t VALUES (1, NULL);").await;
        // 기존 NULL 값 때문에 NOT NULL 재생성이 실패한다
        let r = plan_and_apply(&mut c, "t", |b| b.columns[1].nullable = false).await;
        assert!(matches!(r, Err(AppError::Submit { change_index: 1, .. })), "{r:?}");
        let s = load_sqlite(&mut c, "t").await.unwrap();
        assert!(s.columns[1].nullable);
        assert_eq!(rows(&mut c, "SELECT name FROM sqlite_master WHERE name LIKE '_dbc%'").await, Vec::<(String,)>::new());
    }

    #[tokio::test]
    async fn sqlite_rebuild_fk_violation_rolls_back() {
        let mut c = db(
            "CREATE TABLE p (id INTEGER PRIMARY KEY); INSERT INTO p VALUES (1);
             CREATE TABLE t (id INTEGER PRIMARY KEY, pid INTEGER REFERENCES p(id)); INSERT INTO t VALUES (1, 1);
             PRAGMA foreign_keys = OFF; INSERT INTO t VALUES (2, 99); PRAGMA foreign_keys = ON;",
        )
        .await;
        let r = plan_and_apply(&mut c, "t", |b| b.columns[1].full_type = "INT".into()).await;
        assert!(matches!(r, Err(AppError::User(ref m)) if m.contains("외래 키")), "{r:?}");
        assert_eq!(load_sqlite(&mut c, "t").await.unwrap().columns[1].full_type, "INTEGER");
    }

    #[tokio::test]
    async fn sqlite_rebuild_refuses_unmodeled() {
        let mut c = db("CREATE TABLE t (id INTEGER PRIMARY KEY, n INT CHECK (n > 0));").await;
        let r = plan_and_apply(&mut c, "t", |b| b.columns[1].nullable = false).await;
        assert!(matches!(r, Err(AppError::User(ref m)) if m.contains("CHECK")));
    }

    #[tokio::test]
    async fn sqlite_rebuild_keeps_expression_defaults() {
        let mut c = db("CREATE TABLE t (id INTEGER PRIMARY KEY, a INT DEFAULT (1 + 2), s TEXT DEFAULT 'x''y', ts TEXT DEFAULT CURRENT_TIMESTAMP);").await;
        plan_and_apply(&mut c, "t", |b| b.columns[1].full_type = "INTEGER".into()).await.unwrap();
        sqlx::raw_sql("INSERT INTO t (id) VALUES (1)").execute(&mut c).await.unwrap();
        let r: (i64, String, bool) = sqlx::query_as("SELECT a, s, ts IS NOT NULL FROM t").fetch_one(&mut c).await.unwrap();
        assert_eq!(r, (3, "x'y".to_string(), true));
    }

    #[tokio::test]
    async fn sqlite_drop_indexed_column_rebuilds() {
        let mut c = db("CREATE TABLE t (id INTEGER PRIMARY KEY, a TEXT, b TEXT); CREATE INDEX t_a ON t (a); INSERT INTO t VALUES (1, 'x', 'y');").await;
        let p = plan_and_apply(&mut c, "t", |b| {
            b.columns.remove(1);
        })
        .await
        .unwrap();
        assert!(p.notes.iter().any(|n| n.contains("t_a")));
        assert_eq!(rows(&mut c, "SELECT b FROM t").await, [("y".to_string(),)]);
    }
}
