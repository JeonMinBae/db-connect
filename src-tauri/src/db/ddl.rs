//! 구조 탭의 변경 → DDL 문장과 실행 (DESIGN.md "스키마 편집").

use std::collections::{HashMap, HashSet};

use serde::Serialize;

use crate::db::edit::{literal, quote_ident, table_ref};
use crate::db::pool::AnyConn;
use crate::db::structure::{CheckDef, ColumnDef, ForeignKeyDef, IndexDef, LiteAux, TableOptions, TableStructure};
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

// ---------------------------------------------------------------- 차이 계산

/// 원래 구조의 항목과 짝지을 수 있는 정의 (orig_name이 키)
trait Item: PartialEq + Clone {
    fn key(&self) -> Option<&str>;
    fn without_key(&self) -> Self;
}

macro_rules! item {
    ($t:ty) => {
        impl Item for $t {
            fn key(&self) -> Option<&str> {
                self.orig_name.as_deref()
            }
            fn without_key(&self) -> Self {
                Self { orig_name: None, ..self.clone() }
            }
        }
    };
}
item!(ColumnDef);
item!(IndexDef);
item!(ForeignKeyDef);
item!(CheckDef);

/// 초안 순서의 (원래 항목, 새 정의)와 삭제된 원래 항목
struct Matched<'a, T> {
    drops: Vec<&'a T>,
    items: Vec<(Option<&'a T>, &'a T)>,
}

fn match_items<'a, T: Item>(what: &str, orig: &'a [T], draft: &'a [T]) -> AppResult<Matched<'a, T>> {
    let mut used = HashSet::new();
    let mut items = Vec::with_capacity(draft.len());
    for b in draft {
        let a = match b.key() {
            None => None,
            Some(k) => {
                let a = orig.iter().find(|a| a.key() == Some(k)).ok_or_else(|| AppError::user(format!("원래 {what} {k}을(를) 찾을 수 없습니다. 구조를 다시 읽어 주세요.")))?;
                if !used.insert(k) {
                    return Err(AppError::user(format!("원래 {what} {k}이(가) 두 번 쓰였습니다")));
                }
                Some(a)
            }
        };
        items.push((a, b));
    }
    let drops = orig.iter().filter(|a| a.key().is_none_or(|k| !used.contains(k))).collect();
    Ok(Matched { drops, items })
}

/// 원래 → 초안의 바뀐 항목: (지울 것, 만들 것). 바뀐 항목은 지우고 다시 만든다.
fn changed<'a, T: Item>(m: &Matched<'a, T>, same: impl Fn(&T, &T) -> bool) -> (Vec<&'a T>, Vec<&'a T>) {
    let mut drop = m.drops.clone();
    let mut add = Vec::new();
    for (a, b) in &m.items {
        match a {
            Some(a) if same(a, b) => {}
            Some(a) => {
                drop.push(a);
                add.push(*b);
            }
            None => add.push(*b),
        }
    }
    (drop, add)
}

/// 이름을 뺀 컬럼 정의가 같은지
fn same_def(a: &ColumnDef, b: &ColumnDef) -> bool {
    let strip = |c: &ColumnDef| ColumnDef { orig_name: None, name: String::new(), full_type: c.full_type.trim().to_string(), ..c.clone() };
    strip(a) == strip(b)
}

struct Diff<'a> {
    cols: Matched<'a, ColumnDef>,
    /// 컬럼 순서가 처음으로 달라지는 초안 위치 (기준: 남은 컬럼의 원래 순서 + 새 컬럼은 맨 뒤)
    first_moved: Option<usize>,
    renamed: HashMap<String, String>,
    pk_changed: bool,
    idx_drop: Vec<&'a IndexDef>,
    idx_add: Vec<&'a IndexDef>,
    fk_drop: Vec<&'a ForeignKeyDef>,
    fk_add: Vec<&'a ForeignKeyDef>,
    ck_drop: Vec<&'a CheckDef>,
    ck_add: Vec<&'a CheckDef>,
}

impl Diff<'_> {
    fn map_cols(&self, cols: &[String]) -> Vec<String> {
        cols.iter().map(|c| self.renamed.get(c).cloned().unwrap_or_else(|| c.clone())).collect()
    }
    fn constraints_changed(&self) -> bool {
        self.pk_changed || !self.fk_drop.is_empty() || !self.fk_add.is_empty() || !self.ck_drop.is_empty() || !self.ck_add.is_empty()
    }
}

fn validate(d: Driver, draft: &TableStructure) -> AppResult<()> {
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
    let has = |c: &String| draft.columns.iter().any(|x| &x.name == c);
    let missing = |what: String, cols: &[String]| -> AppResult<()> {
        if cols.is_empty() {
            return Err(AppError::user(format!("{what}에 컬럼이 없습니다")));
        }
        match cols.iter().find(|c| !has(c)) {
            Some(c) => Err(AppError::user(format!("{what}이(가) 없는 컬럼 {c}을(를) 씁니다. 삭제한 컬럼이면 {what}도 고치거나 삭제하세요."))),
            None => Ok(()),
        }
    };
    if !draft.primary_key.is_empty() {
        missing("기본키".into(), &draft.primary_key)?;
    }
    let mut names = HashSet::new();
    for ix in &draft.indexes {
        if ix.name.trim().is_empty() && !ix.constraint {
            return Err(AppError::user("인덱스 이름이 비어 있습니다"));
        }
        if !ix.name.is_empty() && !names.insert(ix.name.to_lowercase()) {
            return Err(AppError::user(format!("인덱스 이름 {}이(가) 중복됩니다", ix.name)));
        }
        if ix.raw.is_none() {
            missing(format!("인덱스 {}", ix.name), &ix.columns)?;
        }
    }
    for fk in &draft.foreign_keys {
        let what = if fk.name.is_empty() { format!("{} 참조 외래 키", fk.ref_table) } else { format!("외래 키 {}", fk.name) };
        missing(what.clone(), &fk.columns)?;
        if fk.ref_table.trim().is_empty() {
            return Err(AppError::user(format!("{what}의 참조 테이블이 비어 있습니다")));
        }
        let implicit = d == Driver::Sqlite && fk.ref_columns.is_empty();
        if !implicit && fk.ref_columns.len() != fk.columns.len() {
            return Err(AppError::user(format!("{what}: 컬럼 수와 참조 컬럼 수가 다릅니다")));
        }
    }
    if let Some(ck) = draft.checks.iter().find(|c| c.expr.trim().is_empty()) {
        return Err(AppError::user(format!("CHECK 제약 {}의 식이 비어 있습니다", ck.name)));
    }
    Ok(())
}

fn diff<'a>(d: Driver, orig: &'a TableStructure, draft: &'a TableStructure) -> AppResult<Diff<'a>> {
    validate(d, draft)?;
    let cols = match_items("컬럼", &orig.columns, &draft.columns)?;
    for (a, b) in &cols.items {
        if let Some(a) = a {
            if a.generated && !(same_def(a, b) && a.name == b.name) {
                return Err(AppError::user(format!("생성 컬럼 {}은(는) 구조 탭에서 바꿀 수 없습니다. SQL로 직접 바꿔 주세요.", a.name)));
            }
        } else if b.generated {
            return Err(AppError::user("생성 컬럼은 구조 탭에서 만들 수 없습니다"));
        }
    }
    // 기준 순서: 남은 컬럼은 원래 순서, 새 컬럼은 초안 순서로 맨 뒤
    let items = &cols.items;
    let pos_of = |name: &str| orig.columns.iter().position(|c| c.name == name).unwrap_or(usize::MAX);
    let mut baseline: Vec<usize> = (0..items.len()).filter(|&i| items[i].0.is_some()).collect();
    baseline.sort_by_key(|&i| pos_of(&items[i].0.unwrap().name));
    baseline.extend((0..items.len()).filter(|&i| items[i].0.is_none()));
    let first_moved = baseline.iter().enumerate().position(|(k, &i)| k != i);
    let renamed: HashMap<String, String> =
        items.iter().filter_map(|(a, b)| a.filter(|a| a.name != b.name).map(|a| (a.name.clone(), b.name.clone()))).collect();

    let mut diff = Diff {
        first_moved,
        renamed,
        pk_changed: false,
        idx_drop: vec![],
        idx_add: vec![],
        fk_drop: vec![],
        fk_add: vec![],
        ck_drop: vec![],
        ck_add: vec![],
        cols,
    };
    diff.pk_changed = diff.map_cols(&orig.primary_key) != draft.primary_key;

    let ix = match_items("인덱스", &orig.indexes, &draft.indexes)?;
    for (a, b) in &ix.items {
        match a {
            Some(a) if a.raw.is_some() && a.without_key() != b.without_key() => {
                return Err(AppError::user(format!("식·부분 인덱스 {}은(는) 구조 탭에서 바꿀 수 없습니다. 삭제하거나 SQL로 바꿔 주세요.", a.name)))
            }
            None if b.raw.is_some() => return Err(AppError::user("식 인덱스는 구조 탭에서 만들 수 없습니다")),
            _ => {}
        }
    }
    (diff.idx_drop, diff.idx_add) = changed(&ix, |a, b| a.raw.is_some() || (a.name == b.name && a.unique == b.unique && diff.map_cols(&a.columns) == b.columns));
    let fk = match_items("외래 키", &orig.foreign_keys, &draft.foreign_keys)?;
    (diff.fk_drop, diff.fk_add) = changed(&fk, |a, b| ForeignKeyDef { columns: diff.map_cols(&a.columns), ..a.without_key() } == b.without_key());
    let ck = match_items("CHECK 제약", &orig.checks, &draft.checks)?;
    (diff.ck_drop, diff.ck_add) = changed(&ck, |a, b| a.name == b.name && a.expr.trim() == b.expr.trim());
    Ok(diff)
}

/// 원래 구조 → 초안으로 바꾸는 문장들. SQLite 재생성에는 aux가 필요하다.
pub fn plan_alter(d: Driver, schema: Option<&str>, table: &str, orig: &TableStructure, draft: &TableStructure, aux: Option<&LiteAux>) -> AppResult<DdlPlan> {
    let diff = diff(d, orig, draft)?;
    let t = table_ref(d, schema, table);
    let mut plan = match d {
        Driver::Postgres => pg_plan(&t, schema.unwrap_or("public"), orig, draft, &diff),
        Driver::Mysql => my_plan(&t, schema, orig, draft, &diff),
        Driver::Sqlite => lite_plan(table, draft, &diff, aux.ok_or_else(|| AppError::user("SQLite 테이블 정보가 없습니다"))?),
        _ => Err(AppError::user("SQL 접속이 아닙니다")),
    }?;
    let mut warnings: Vec<String> = diff.cols.drops.iter().map(|c| format!("컬럼 {} 삭제: 이 컬럼의 데이터가 사라집니다.", c.name)).collect();
    for (a, b) in &diff.cols.items {
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

/// 테이블 이름 변경 (다른 변경 뒤에 붙인다)
pub fn plan_rename(d: Driver, schema: Option<&str>, table: &str, new_name: &str) -> AppResult<DdlStmt> {
    if new_name.trim().is_empty() {
        return Err(AppError::user("테이블 이름이 비어 있습니다"));
    }
    let from = table_ref(d, schema, table);
    let sql = match d {
        Driver::Mysql => format!("RENAME TABLE {from} TO {}", table_ref(d, schema, new_name)),
        _ => format!("ALTER TABLE {from} RENAME TO {}", quote_ident(d, new_name)),
    };
    Ok(DdlStmt { sql, destructive: false })
}

pub fn plan_drop(d: Driver, schema: Option<&str>, table: &str) -> DdlStmt {
    DdlStmt { sql: format!("DROP TABLE {}", table_ref(d, schema, table)), destructive: true }
}

/// 새 테이블. 인덱스는 CREATE TABLE 뒤에 따로 만든다 (MySQL은 본문 안에).
pub fn plan_create(d: Driver, schema: Option<&str>, table: &str, draft: &TableStructure) -> AppResult<DdlPlan> {
    if table.trim().is_empty() {
        return Err(AppError::user("테이블 이름이 비어 있습니다"));
    }
    if draft.columns.is_empty() {
        return Err(AppError::user("컬럼이 하나 이상 있어야 합니다"));
    }
    validate(d, draft)?;
    if draft.columns.iter().any(|c| c.generated) {
        return Err(AppError::user("생성 컬럼은 구조 탭에서 만들 수 없습니다"));
    }
    let t = table_ref(d, schema, table);
    let q = |s: &str| quote_ident(d, s);
    let mut p = DdlPlan::default();
    let body = match d {
        Driver::Sqlite => lite_table_body(draft)?,
        Driver::Postgres | Driver::Mysql => {
            let mut lines = Vec::new();
            for c in &draft.columns {
                lines.push(if d == Driver::Mysql {
                    my_col_def(c)
                } else {
                    pg_check(c)?;
                    let mut s = format!("{} {}", q(&c.name), pg_type(c));
                    if c.auto_increment {
                        s += " GENERATED BY DEFAULT AS IDENTITY";
                    }
                    if !c.nullable {
                        s += " NOT NULL";
                    }
                    if let Some(e) = &c.default {
                        s += &format!(" DEFAULT {e}");
                    }
                    s
                });
            }
            if !draft.primary_key.is_empty() {
                lines.push(format!("PRIMARY KEY ({})", col_list(d, &draft.primary_key)));
            }
            if d == Driver::Mysql {
                for ix in &draft.indexes {
                    lines.push(format!("{}INDEX {} ({})", if ix.unique { "UNIQUE " } else { "" }, q(&ix.name), col_list(d, &ix.columns)));
                }
            }
            for c in &draft.checks {
                lines.push(check_clause(d, c));
            }
            for f in &draft.foreign_keys {
                lines.push(fk_clause(d, schema, f));
            }
            lines.join(",\n  ")
        }
        _ => return Err(AppError::user("SQL 접속이 아닙니다")),
    };
    let suffix = if d == Driver::Mysql { my_create_options(&draft.options) } else { String::new() };
    p.push(format!("CREATE TABLE {t} (\n  {body}\n){suffix}"), false);
    if d != Driver::Mysql {
        for ix in draft.indexes.iter().filter(|ix| !(d == Driver::Sqlite && ix.constraint)) {
            p.push(format!("CREATE {}INDEX {} ON {t} ({})", if ix.unique { "UNIQUE " } else { "" }, q(&ix.name), col_list(d, &ix.columns)), false);
        }
    }
    if d == Driver::Postgres {
        if let Some(c) = &draft.options.comment {
            p.push(format!("COMMENT ON TABLE {t} IS {}", literal(d, Some(c))), false);
        }
        for c in draft.columns.iter().filter(|c| c.comment.is_some()) {
            p.push(comment_on(&t, &q(&c.name), c.comment.as_deref()), false);
        }
    }
    Ok(p)
}

// ---------------------------------------------------------------- 공통 조각

fn col_list(d: Driver, cols: &[String]) -> String {
    cols.iter().map(|c| quote_ident(d, c)).collect::<Vec<_>>().join(", ")
}

fn named(d: Driver, name: &str) -> String {
    if name.trim().is_empty() {
        String::new()
    } else {
        format!("CONSTRAINT {} ", quote_ident(d, name))
    }
}

fn check_clause(d: Driver, c: &CheckDef) -> String {
    format!("{}CHECK ({})", named(d, &c.name), c.expr.trim())
}

/// `FOREIGN KEY (...) REFERENCES ...` (CONSTRAINT 이름 포함)
fn fk_clause(d: Driver, schema: Option<&str>, f: &ForeignKeyDef) -> String {
    let rs = f.ref_schema.as_deref().or(schema);
    let mut s = format!("{}FOREIGN KEY ({}) REFERENCES {}", named(d, &f.name), col_list(d, &f.columns), table_ref(d, rs, &f.ref_table));
    if !f.ref_columns.is_empty() {
        s += &format!(" ({})", col_list(d, &f.ref_columns));
    }
    for (kw, v) in [("ON UPDATE", &f.on_update), ("ON DELETE", &f.on_delete)] {
        let v = v.trim().to_ascii_uppercase();
        if !v.is_empty() && v != "NO ACTION" {
            s += &format!(" {kw} {v}");
        }
    }
    s
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

fn pg_plan(t: &str, schema: &str, orig: &TableStructure, draft: &TableStructure, d: &Diff) -> AppResult<DdlPlan> {
    const PG: Driver = Driver::Postgres;
    if d.first_moved.is_some() {
        return Err(AppError::user("PostgreSQL은 컬럼 순서를 바꿀 수 없습니다. 새 컬럼은 맨 뒤에 추가됩니다."));
    }
    let q = |s: &str| quote_ident(PG, s);
    let mut p = DdlPlan::default();

    // 1) 바뀌거나 지운 제약·인덱스부터 지운다 (컬럼 이름이 바뀌기 전 이름으로)
    for f in &d.fk_drop {
        p.push(format!("ALTER TABLE {t} DROP CONSTRAINT {}", q(&f.name)), false);
    }
    for c in &d.ck_drop {
        p.push(format!("ALTER TABLE {t} DROP CONSTRAINT {}", q(&c.name)), false);
    }
    for ix in &d.idx_drop {
        if ix.constraint {
            p.push(format!("ALTER TABLE {t} DROP CONSTRAINT {}", q(&ix.name)), false);
        } else {
            p.push(format!("DROP INDEX {}.{}", q(schema), q(&ix.name)), false);
        }
    }
    if d.pk_changed && !orig.primary_key.is_empty() {
        let name = orig.primary_key_name.as_deref().ok_or_else(|| AppError::user("기본키 제약 이름을 알 수 없습니다"))?;
        p.push(format!("ALTER TABLE {t} DROP CONSTRAINT {}", q(name)), false);
    }

    // 2) 컬럼
    for c in &d.cols.drops {
        p.push(format!("ALTER TABLE {t} DROP COLUMN {}", q(&c.name)), true);
    }
    for (a, b) in &d.cols.items {
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

    // 3) 새 제약·인덱스
    if d.pk_changed && !draft.primary_key.is_empty() {
        p.push(format!("ALTER TABLE {t} ADD PRIMARY KEY ({})", col_list(PG, &draft.primary_key)), false);
    }
    for ix in &d.idx_add {
        p.push(format!("CREATE {}INDEX {} ON {t} ({})", if ix.unique { "UNIQUE " } else { "" }, q(&ix.name), col_list(PG, &ix.columns)), false);
    }
    for c in &d.ck_add {
        p.push(format!("ALTER TABLE {t} ADD {}", check_clause(PG, c)), false);
    }
    for f in &d.fk_add {
        p.push(format!("ALTER TABLE {t} ADD {}", fk_clause(PG, Some(schema), f)), false);
    }
    if orig.options.comment != draft.options.comment {
        p.push(format!("COMMENT ON TABLE {t} IS {}", draft.options.comment.as_deref().map_or("NULL".to_string(), |c| literal(PG, Some(c)))), false);
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

fn opt(v: &Option<String>) -> Option<&str> {
    v.as_deref().map(str::trim).filter(|s| !s.is_empty())
}

/// MySQL 테이블 옵션을 바꾸는 절과 경고
fn my_option_clauses(a: &TableOptions, b: &TableOptions) -> AppResult<(Vec<String>, Vec<String>)> {
    let mut clauses = Vec::new();
    let mut warnings = Vec::new();
    if opt(&a.engine) != opt(&b.engine) {
        if let Some(e) = opt(&b.engine) {
            clauses.push(format!("ENGINE = {e}"));
            warnings.push(format!("엔진 변경 ({} → {e}): 테이블 전체를 다시 쓰고, 그동안 테이블이 잠깁니다.", opt(&a.engine).unwrap_or("?")));
        }
    }
    if opt(&a.charset) != opt(&b.charset) || opt(&a.collation) != opt(&b.collation) {
        let cs = opt(&b.charset).ok_or_else(|| AppError::user("테이블 문자셋을 지정하세요"))?;
        let co = opt(&b.collation).map(|c| format!(" COLLATE {c}")).unwrap_or_default();
        if b.convert {
            clauses.push(format!("CONVERT TO CHARACTER SET {cs}{co}"));
            warnings.push(format!("문자셋 변환 ({} → {cs}): 모든 문자열 컬럼의 데이터를 변환하고 테이블을 다시 씁니다.", opt(&a.charset).unwrap_or("?")));
        } else {
            clauses.push(format!("DEFAULT CHARACTER SET {cs}{co}"));
        }
    }
    if opt(&a.row_format) != opt(&b.row_format) {
        if let Some(r) = opt(&b.row_format) {
            clauses.push(format!("ROW_FORMAT = {r}"));
        }
    }
    if opt(&a.comment) != opt(&b.comment) {
        clauses.push(format!("COMMENT = {}", literal(Driver::Mysql, Some(opt(&b.comment).unwrap_or("")))));
    }
    Ok((clauses, warnings))
}

/// CREATE TABLE 뒤의 MySQL 테이블 옵션
fn my_create_options(o: &TableOptions) -> String {
    let mut s = String::new();
    if let Some(e) = opt(&o.engine) {
        s += &format!(" ENGINE={e}");
    }
    if let Some(cs) = opt(&o.charset) {
        s += &format!(" DEFAULT CHARSET={cs}");
    }
    if let Some(co) = opt(&o.collation) {
        s += &format!(" COLLATE={co}");
    }
    if let Some(r) = opt(&o.row_format) {
        s += &format!(" ROW_FORMAT={r}");
    }
    if let Some(c) = opt(&o.comment) {
        s += &format!(" COMMENT={}", literal(Driver::Mysql, Some(c)));
    }
    s
}

/// 한 테이블의 변경을 ALTER TABLE 한 문장으로 묶는다 (MySQL DDL은 문장마다 암묵 커밋되므로).
/// 같은 이름의 외래 키를 지우고 다시 만들 때만 지우는 문장을 앞에 따로 둔다.
fn my_plan(t: &str, schema: Option<&str>, orig: &TableStructure, draft: &TableStructure, d: &Diff) -> AppResult<DdlPlan> {
    const MY: Driver = Driver::Mysql;
    let q = |s: &str| quote_ident(MY, s);
    let mut p = DdlPlan::default();
    let mut clauses = Vec::new();
    let mut destructive = false;

    let readd: HashSet<&str> = d.fk_add.iter().map(|f| f.name.as_str()).filter(|n| !n.is_empty()).collect();
    let fk_drops: Vec<String> = d.fk_drop.iter().map(|f| format!("DROP FOREIGN KEY {}", q(&f.name))).collect();
    if d.fk_drop.iter().any(|f| readd.contains(f.name.as_str())) {
        p.push(format!("ALTER TABLE {t}\n  {}", fk_drops.join(",\n  ")), false);
    } else {
        clauses.extend(fk_drops);
    }
    for c in &d.ck_drop {
        clauses.push(format!("DROP CONSTRAINT {}", q(&c.name)));
    }
    for ix in &d.idx_drop {
        clauses.push(format!("DROP INDEX {}", q(&ix.name)));
    }
    if d.pk_changed && !orig.primary_key.is_empty() {
        clauses.push("DROP PRIMARY KEY".into());
    }
    for c in &d.cols.drops {
        clauses.push(format!("DROP COLUMN {}", q(&c.name)));
        destructive = true;
    }
    for (k, (a, b)) in d.cols.items.iter().enumerate() {
        let pos = match d.first_moved {
            Some(m) if k >= m => Some(if k == 0 { " FIRST".to_string() } else { format!(" AFTER {}", q(&d.cols.items[k - 1].1.name)) }),
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
    if d.pk_changed && !draft.primary_key.is_empty() {
        clauses.push(format!("ADD PRIMARY KEY ({})", col_list(MY, &draft.primary_key)));
    }
    for ix in &d.idx_add {
        clauses.push(format!("ADD {}INDEX {} ({})", if ix.unique { "UNIQUE " } else { "" }, q(&ix.name), col_list(MY, &ix.columns)));
    }
    for c in &d.ck_add {
        clauses.push(format!("ADD {}", check_clause(MY, c)));
    }
    for f in &d.fk_add {
        clauses.push(format!("ADD {}", fk_clause(MY, schema, f)));
    }
    let (opts, warnings) = my_option_clauses(&orig.options, &draft.options)?;
    clauses.extend(opts);
    destructive |= !warnings.is_empty();
    p.warnings.extend(warnings);
    if !clauses.is_empty() {
        p.push(format!("ALTER TABLE {t}\n  {}", clauses.join(",\n  ")), destructive);
    }
    Ok(p)
}

// ---------------------------------------------------------------- SQLite

enum Tok<'a> {
    Word(&'a str),
    /// 따옴표 식별자 (따옴표 포함 원문)
    Ident(&'a str),
    Punct(char, usize),
}

/// SQLite DDL 토큰. 문자열 리터럴과 주석은 건너뛴다.
fn sqlite_tokens(sql: &str) -> Vec<Tok<'_>> {
    let b = sql.as_bytes();
    let mut out = Vec::new();
    let mut i = 0;
    while i < b.len() {
        let c = b[i];
        match c {
            b'\'' | b'"' | b'`' | b'[' => {
                let s = i;
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
                if c != b'\'' {
                    out.push(Tok::Ident(&sql[s..i.min(sql.len())]));
                }
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

/// CREATE 문의 낱말들 (대문자, 따옴표 식별자 제외)
pub fn sqlite_words(sql: &str) -> Vec<String> {
    sqlite_tokens(sql)
        .into_iter()
        .filter_map(|t| match t {
            Tok::Word(w) => Some(w.to_ascii_uppercase()),
            _ => None,
        })
        .collect()
}

fn unquote(s: &str) -> String {
    let (open, close) = match s.chars().next() {
        Some('[') => ('[', ']'),
        Some(q @ ('"' | '`')) => (q, q),
        _ => return s.to_string(),
    };
    let inner = s.strip_prefix(open).and_then(|x| x.strip_suffix(close)).unwrap_or(s);
    if open == '[' { inner.to_string() } else { inner.replace(&format!("{close}{close}"), &close.to_string()) }
}

/// CREATE TABLE 안의 CHECK 제약: (CONSTRAINT 이름, 바깥 괄호를 뺀 식). 컬럼 CHECK도 포함한다.
pub fn sqlite_checks(sql: &str) -> Vec<(Option<String>, String)> {
    let toks = sqlite_tokens(sql);
    let mut out = Vec::new();
    for (i, t) in toks.iter().enumerate() {
        let Tok::Word(w) = t else { continue };
        if !w.eq_ignore_ascii_case("CHECK") {
            continue;
        }
        let Some(Tok::Punct('(', open)) = toks.get(i + 1) else { continue };
        let mut depth = 0;
        let close = toks[i + 1..].iter().find_map(|t| match t {
            Tok::Punct('(', _) => {
                depth += 1;
                None
            }
            Tok::Punct(')', at) => {
                depth -= 1;
                (depth == 0).then_some(*at)
            }
            _ => None,
        });
        let Some(close) = close else { continue };
        let name = match (i.checked_sub(2).map(|k| &toks[k]), i.checked_sub(1).map(|k| &toks[k])) {
            (Some(Tok::Word(c)), Some(Tok::Word(n))) if c.eq_ignore_ascii_case("CONSTRAINT") => Some(n.to_string()),
            (Some(Tok::Word(c)), Some(Tok::Ident(n))) if c.eq_ignore_ascii_case("CONSTRAINT") => Some(unquote(n)),
            _ => None,
        };
        out.push((name, sql[open + 1..close].trim().to_string()));
    }
    out
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

/// 재생성 때 만드는 임시 테이블 이름 앞부분
const REBUILD_PREFIX: &str = "_dbc_new_";

/// 재생성할 때 옮길 수 없는 정의 (구조 탭이 모델링하지 않아 잃어버리게 되는 것)
const LITE_UNSUPPORTED: &[&str] = &["COLLATE", "CONFLICT", "GENERATED", "DEFERRABLE"];

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

fn lite_create_index(t: &str, ix: &IndexDef) -> String {
    let q = |s: &str| quote_ident(Driver::Sqlite, s);
    format!("CREATE {}INDEX {} ON {t} ({})", if ix.unique { "UNIQUE " } else { "" }, q(&ix.name), col_list(Driver::Sqlite, &ix.columns))
}

/// CREATE TABLE 본문 (컬럼·기본키·UNIQUE·CHECK·외래 키)
fn lite_table_body(draft: &TableStructure) -> AppResult<String> {
    let q = |s: &str| quote_ident(Driver::Sqlite, s);
    let pk = &draft.primary_key;
    let autos: Vec<&ColumnDef> = draft.columns.iter().filter(|c| c.auto_increment).collect();
    if let Some(a) = autos.first() {
        if autos.len() > 1 || pk != std::slice::from_ref(&a.name) || !a.full_type.trim().eq_ignore_ascii_case("INTEGER") {
            return Err(AppError::user("SQLite 자동 증가는 INTEGER 타입의 단일 기본키 컬럼에만 쓸 수 있습니다"));
        }
    }
    let inline_pk = autos.first().map(|a| a.name.clone());
    let mut lines: Vec<String> = draft.columns.iter().map(|c| lite_col_def(c, inline_pk.as_deref() == Some(&c.name))).collect();
    if !pk.is_empty() && inline_pk.is_none() {
        lines.push(format!("PRIMARY KEY ({})", pk.iter().map(|c| q(c)).collect::<Vec<_>>().join(", ")));
    }
    for ix in draft.indexes.iter().filter(|ix| ix.constraint) {
        lines.push(format!("UNIQUE ({})", col_list(Driver::Sqlite, &ix.columns)));
    }
    for c in &draft.checks {
        lines.push(check_clause(Driver::Sqlite, c));
    }
    for f in &draft.foreign_keys {
        lines.push(fk_clause(Driver::Sqlite, None, f));
    }
    Ok(lines.join(",\n  "))
}

fn lite_plan(table: &str, draft: &TableStructure, d: &Diff, aux: &LiteAux) -> AppResult<DdlPlan> {
    let q = |s: &str| quote_ident(Driver::Sqlite, s);
    let t = q(table);
    let cols_simple = d.first_moved.is_none()
        && d.cols.items.iter().all(|(a, b)| match a {
            Some(a) => same_def(a, b),
            None => !b.auto_increment && (b.nullable || b.default.is_some()),
        });
    let constraint_ix = d.idx_drop.iter().chain(&d.idx_add).any(|ix| ix.constraint);
    let mut p = DdlPlan::default();
    if cols_simple && !d.constraints_changed() && !constraint_ix {
        for ix in &d.idx_drop {
            p.push(format!("DROP INDEX {}", q(&ix.name)), false);
        }
        for (a, b) in &d.cols.items {
            if let Some(a) = a.filter(|a| a.name != b.name) {
                p.push(format!("ALTER TABLE {t} RENAME COLUMN {} TO {}", q(&a.name), q(&b.name)), false);
            }
        }
        for c in &d.cols.drops {
            p.push(format!("ALTER TABLE {t} DROP COLUMN {}", q(&c.name)), true);
        }
        for (a, b) in &d.cols.items {
            if a.is_none() {
                p.push(format!("ALTER TABLE {t} ADD COLUMN {}", lite_col_def(b, false)), false);
            }
        }
        for ix in &d.idx_add {
            p.push(lite_create_index(&t, ix), false);
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
    p.notes.push("SQLite는 이 변경을 ALTER로 할 수 없어 테이블을 새로 만들고 데이터를 옮깁니다.".into());
    if !d.renamed.is_empty() && !draft.checks.is_empty() {
        p.notes.push("CHECK 식은 적은 그대로 씁니다. 이름을 바꾼 컬럼을 쓰는 식은 함께 고쳐 주세요.".into());
    }

    let tmp = q(&format!("{REBUILD_PREFIX}{table}"));
    p.push(format!("CREATE TABLE {tmp} (\n  {}\n){}", lite_table_body(draft)?, sqlite_tail(&aux.create_sql)), false);
    let kept: Vec<(&ColumnDef, &ColumnDef)> = d.cols.items.iter().filter_map(|(a, b)| a.map(|a| (a, *b))).collect();
    if !kept.is_empty() {
        let to = kept.iter().map(|(_, b)| q(&b.name)).collect::<Vec<_>>().join(", ");
        let from = kept.iter().map(|(a, _)| q(&a.name)).collect::<Vec<_>>().join(", ");
        p.push(format!("INSERT INTO {tmp} ({to})\n  SELECT {from} FROM {t}"), false);
    }
    p.push(format!("DROP TABLE {t}"), true);
    p.push(format!("ALTER TABLE {tmp} RENAME TO {t}"), false);

    for ix in draft.indexes.iter().filter(|ix| !ix.constraint) {
        match &ix.raw {
            Some(sql) => {
                if !d.renamed.is_empty() {
                    p.notes.push(format!("인덱스 {}는 원문 그대로 다시 만듭니다. 이름을 바꾼 컬럼을 식이나 조건에서 쓰면 실패하니 SQL을 고쳐 주세요.", ix.name));
                }
                p.push(sql.clone(), false);
            }
            None => p.push(lite_create_index(&t, ix), false),
        }
    }
    if !aux.triggers.is_empty() && (!d.renamed.is_empty() || !d.cols.drops.is_empty()) {
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
        // 재생성이 아니면 그대로 실행한다. 테이블·컬럼 이름 변경이 트리거·뷰·다른 테이블의 외래 키까지 고치도록
        // legacy_alter_table은 끈 채로 둔다.
        AnyConn::Lite(_) if !stmts.iter().any(|s| s.contains(REBUILD_PREFIX)) => run_in_tx(conn, stmts, false).await,
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
#[path = "ddl_tests.rs"]
mod tests;
