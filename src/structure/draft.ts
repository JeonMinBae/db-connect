import type { CheckDef, ColumnDef, Driver, FkAction, ForeignKeyDef, IndexDef, TableOptions, TableStructure } from "../api/types";

/** 구조 탭의 컬럼 행. 삭제한 원래 컬럼도 되돌릴 수 있게 목록에 남긴다. */
export interface Row {
  key: string;
  col: ColumnDef;
  deleted: boolean;
}

export type RowState = "added" | "deleted" | "modified" | "same";

/** 비교하는 필드 (orig_name 제외) */
const FIELDS = ["name", "full_type", "nullable", "default", "auto_increment", "comment", "charset", "collation", "on_update"] as const;
type Field = (typeof FIELDS)[number];

export const rowsOf = (s: TableStructure): Row[] => s.columns.map((c) => ({ key: "o:" + c.name, col: { ...c }, deleted: false }));

export const newRow = (): Row => ({
  key: "n:" + crypto.randomUUID(),
  col: { orig_name: null, name: "", full_type: "", nullable: true, default: null, auto_increment: false, generated: false, comment: null, charset: null, collation: null, on_update: null },
  deleted: false,
});

const origOf = (s: TableStructure, r: Row) => (r.col.orig_name === null ? null : (s.columns.find((c) => c.name === r.col.orig_name) ?? null));

const norm = (f: Field, v: unknown) => (typeof v === "string" ? (f === "full_type" ? v.trim() : v) : v);

/** 원래 값과 다른 필드 */
export function changedFields(s: TableStructure, r: Row): Set<Field> {
  const o = origOf(s, r);
  if (!o) return new Set(FIELDS);
  return new Set(FIELDS.filter((f) => norm(f, o[f]) !== norm(f, r.col[f])));
}

export function rowState(s: TableStructure, r: Row): RowState {
  if (r.col.orig_name === null) return "added";
  if (r.deleted) return "deleted";
  return changedFields(s, r).size ? "modified" : "same";
}

/** 남은 원래 컬럼의 순서가 바뀌었거나 새 컬럼이 중간에 있으면 true */
export function orderChanged(s: TableStructure, rows: Row[]): boolean {
  const live = rows.filter((r) => !r.deleted);
  const firstNew = live.findIndex((r) => r.col.orig_name === null);
  if (firstNew >= 0 && live.slice(firstNew).some((r) => r.col.orig_name !== null)) return true;
  const kept = live.filter((r) => r.col.orig_name !== null).map((r) => r.col.orig_name);
  const origOrder = s.columns.map((c) => c.name).filter((n) => kept.includes(n));
  return kept.some((n, i) => n !== origOrder[i]);
}

export const changeCount = (s: TableStructure, rows: Row[]) => rows.filter((r) => rowState(s, r) !== "same").length + (orderChanged(s, rows) ? 1 : 0);

/** 컬럼만 바꾼 초안 (나머지는 원래 구조 그대로) */
export const toDraft = (s: TableStructure, rows: Row[]): TableStructure => ({
  ...s,
  columns: rows.filter((r) => !r.deleted).map((r) => ({ ...r.col, default: r.col.default?.trim() ? r.col.default : null })),
});

/** 행 되돌리기: 새 행은 지우고, 원래 행은 원래 정의로 (위치는 그대로) */
export function revertRow(s: TableStructure, rows: Row[], key: string): Row[] {
  return rows.flatMap((r) => {
    if (r.key !== key) return [r];
    const o = origOf(s, r);
    return o ? [{ ...r, col: { ...o }, deleted: false }] : [];
  });
}

export function moveRow(rows: Row[], key: string, dir: -1 | 1): Row[] {
  const i = rows.findIndex((r) => r.key === key);
  const j = i + dir;
  if (i < 0 || j < 0 || j >= rows.length) return rows;
  const out = rows.slice();
  [out[i], out[j]] = [out[j], out[i]];
  return out;
}

/** 컬럼 순서를 바꿀 수 있는지 (PG는 재생성 말고 방법이 없어 막는다) */
export const canReorder = (d: Driver) => d !== "postgres";

/** 타입 입력란 제안 (자유 입력 가능) */
export const TYPE_SUGGESTIONS: Record<Driver, string[]> = {
  postgres: ["integer", "bigint", "smallint", "numeric(10,2)", "real", "double precision", "boolean", "text", "varchar(255)", "char(10)", "date", "timestamp", "timestamptz", "time", "interval", "uuid", "json", "jsonb", "bytea", "inet"],
  mysql: ["int", "bigint", "tinyint", "smallint", "tinyint(1)", "decimal(10,2)", "float", "double", "varchar(255)", "char(10)", "text", "mediumtext", "longtext", "date", "datetime", "timestamp", "time", "year", "json", "blob", "longblob", "enum('a','b')"],
  sqlite: ["INTEGER", "TEXT", "REAL", "BLOB", "NUMERIC"],
};

// ---------------------------------------------------------------- 인덱스·제약 (S2)

/** 인덱스·외래 키·CHECK 한 줄. 삭제한 원래 항목도 되돌릴 수 있게 남긴다. */
export interface Entry<T> {
  key: string;
  def: T;
  deleted: boolean;
}

type Keyed = { orig_name: string | null };

/** 구조 탭 전체 초안 */
export interface Draft {
  columns: Row[];
  pk: string[];
  indexes: Entry<IndexDef>[];
  fks: Entry<ForeignKeyDef>[];
  checks: Entry<CheckDef>[];
  options: TableOptions;
}

const entriesOf = <T extends Keyed>(list: T[]): Entry<T>[] => list.map((d) => ({ key: "o:" + d.orig_name, def: structuredClone(d), deleted: false }));

export const newEntry = <T>(def: T): Entry<T> => ({ key: "n:" + crypto.randomUUID(), def, deleted: false });

export const draftOf = (s: TableStructure): Draft => ({
  columns: rowsOf(s),
  pk: [...s.primary_key],
  indexes: entriesOf(s.indexes),
  fks: entriesOf(s.foreign_keys),
  checks: entriesOf(s.checks),
  options: { ...s.options },
});

const sameJson = (a: unknown, b: unknown) => JSON.stringify(a) === JSON.stringify(b);

export function entryState<T extends Keyed>(orig: T[], e: Entry<T>): RowState {
  if (e.def.orig_name === null) return "added";
  if (e.deleted) return "deleted";
  const o = orig.find((x) => x.orig_name === e.def.orig_name);
  return o && sameJson(o, e.def) ? "same" : "modified";
}

export function revertEntry<T extends Keyed>(orig: T[], list: Entry<T>[], key: string): Entry<T>[] {
  return list.flatMap((e) => {
    if (e.key !== key) return [e];
    const o = orig.find((x) => x.orig_name === e.def.orig_name);
    return o ? [{ ...e, def: structuredClone(o), deleted: false }] : [];
  });
}

/** 새 항목은 지우고, 원래 항목은 삭제 표시 */
export const removeEntry = <T extends Keyed>(list: Entry<T>[], key: string): Entry<T>[] =>
  list.flatMap((e) => (e.key !== key ? [e] : e.def.orig_name === null ? [] : [{ ...e, deleted: true }]));

export const pkChanged = (s: TableStructure, d: Draft) => !sameJson(s.primary_key, d.pk);

/** 빈 문자열은 없음과 같다. convert는 바꾸는 방법일 뿐이라 비교하지 않는다. */
const blank = (v: string | null) => (v?.trim() ? v : null);
const normOptions = (o: TableOptions): TableOptions => ({
  comment: blank(o.comment),
  engine: blank(o.engine),
  charset: blank(o.charset),
  collation: blank(o.collation),
  row_format: blank(o.row_format),
  convert: false,
});
export const optionsChanged = (s: TableStructure, d: Draft) => !sameJson(normOptions(s.options), normOptions(d.options));
/** 문자셋·정렬규칙이 바뀌었는지 (기존 데이터 변환 여부를 고르게 한다) */
export function charsetChanged(s: TableStructure, d: Draft) {
  const [a, b] = [normOptions(s.options), normOptions(d.options)];
  return a.charset !== b.charset || a.collation !== b.collation;
}

export function draftChangeCount(s: TableStructure, d: Draft): number {
  const n = <T extends Keyed>(orig: T[], list: Entry<T>[]) => list.filter((e) => entryState(orig, e) !== "same").length;
  return changeCount(s, d.columns) + (pkChanged(s, d) ? 1 : 0) + n(s.indexes, d.indexes) + n(s.foreign_keys, d.fks) + n(s.checks, d.checks) + (optionsChanged(s, d) ? 1 : 0);
}

const live = <T>(list: Entry<T>[]) => list.filter((e) => !e.deleted).map((e) => e.def);

/** 서버로 보낼 초안 구조 */
export const toStructure = (s: TableStructure, d: Draft): TableStructure => ({
  ...toDraft(s, d.columns),
  primary_key: d.pk,
  primary_key_name: s.primary_key_name,
  indexes: live(d.indexes),
  foreign_keys: live(d.fks),
  checks: live(d.checks),
  checks_unsupported: s.checks_unsupported,
  options: d.options,
});

/** 컬럼 이름을 바꾸면 기본키·인덱스·외래 키의 컬럼 목록도 따라 바꾼다 (식 인덱스·CHECK 식은 그대로) */
export function renameColumnRefs(d: Draft, from: string, to: string): Draft {
  if (from === to || !from) return d;
  const swap = (cols: string[]) => (cols.includes(from) ? cols.map((c) => (c === from ? to : c)) : cols);
  return {
    ...d,
    pk: swap(d.pk),
    indexes: d.indexes.map((e) => (e.def.raw || !e.def.columns.includes(from) ? e : { ...e, def: { ...e.def, columns: swap(e.def.columns) } })),
    fks: d.fks.map((e) => (e.def.columns.includes(from) ? { ...e, def: { ...e.def, columns: swap(e.def.columns) } } : e)),
  };
}

/** "a, b" ↔ ["a", "b"] */
export const parseList = (s: string) =>
  s
    .split(",")
    .map((x) => x.trim())
    .filter(Boolean);

export const FK_ACTIONS: FkAction[] = ["NO ACTION", "RESTRICT", "CASCADE", "SET NULL", "SET DEFAULT"];

/**
 * 컬럼 이름 변경을 기본키·인덱스·외래 키에 반영한다 (입력을 마쳤을 때 한 번).
 * 바꾸기 전이나 후의 이름이 다른 컬럼과 같으면 어느 컬럼의 참조인지 알 수 없으므로 건드리지 않는다.
 */
export function renameColumnFor(d: Draft, key: string, from: string, to: string): Draft {
  const others = d.columns.filter((r) => r.key !== key && !r.deleted).map((r) => r.col.name);
  if (!to.trim() || others.includes(to) || others.includes(from)) return d;
  return renameColumnRefs(d, from, to);
}

/** 컬럼 행 되돌리기: 정의와 함께 참조 이름도 원래대로 */
export function revertColumn(s: TableStructure, d: Draft, key: string): Draft {
  const row = d.columns.find((r) => r.key === key);
  const o = row && origOf(s, row);
  const next = { ...d, columns: revertRow(s, d.columns, key) };
  return row && o ? renameColumnFor(next, key, row.col.name, o.name) : next;
}

/** MySQL에서 문자셋·정렬규칙을 줄 수 있는 타입 */
export const isTextual = (type: string) => /^\s*(char|varchar|tinytext|text|mediumtext|longtext|enum|set)\b/i.test(type);

export const newIndex = () => newEntry<IndexDef>({ orig_name: null, name: "", columns: [], unique: false, constraint: false, raw: null });
export const newFk = () =>
  newEntry<ForeignKeyDef>({ orig_name: null, name: "", columns: [], ref_schema: null, ref_table: "", ref_columns: [], on_update: "NO ACTION", on_delete: "NO ACTION" });
export const newCheck = () => newEntry<CheckDef>({ orig_name: null, name: "", expr: "" });

export const EMPTY_STRUCTURE: TableStructure = {
  columns: [],
  primary_key: [],
  primary_key_name: null,
  indexes: [],
  foreign_keys: [],
  checks: [],
  checks_unsupported: false,
  options: { comment: null, engine: null, charset: null, collation: null, row_format: null, convert: false },
};

/** 새 테이블 초안: 자동 증가 기본키 id 하나로 시작한다 */
export function newTableDraft(d: Driver): Draft {
  const id = newRow();
  id.col = { ...id.col, name: "id", full_type: d === "sqlite" ? "INTEGER" : "bigint", nullable: false, auto_increment: true };
  return { ...draftOf(EMPTY_STRUCTURE), columns: [id], pk: ["id"] };
}
