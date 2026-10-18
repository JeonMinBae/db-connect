import type { ColumnDef, Driver, TableStructure } from "../api/types";

/** 구조 탭의 컬럼 행. 삭제한 원래 컬럼도 되돌릴 수 있게 목록에 남긴다. */
export interface Row {
  key: string;
  col: ColumnDef;
  deleted: boolean;
}

export type RowState = "added" | "deleted" | "modified" | "same";

/** 비교하는 필드 (orig_name 제외) */
export const FIELDS = ["name", "full_type", "nullable", "default", "auto_increment", "comment", "charset", "collation", "on_update"] as const;
export type Field = (typeof FIELDS)[number];

export const rowsOf = (s: TableStructure): Row[] => s.columns.map((c) => ({ key: "o:" + c.name, col: { ...c }, deleted: false }));

export const newRow = (): Row => ({
  key: "n:" + crypto.randomUUID(),
  col: { orig_name: null, name: "", full_type: "", nullable: true, default: null, auto_increment: false, generated: false, comment: null, charset: null, collation: null, on_update: null },
  deleted: false,
});

export const origOf = (s: TableStructure, r: Row) => (r.col.orig_name === null ? null : (s.columns.find((c) => c.name === r.col.orig_name) ?? null));

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

/** 서버로 보낼 초안 */
export const toDraft = (s: TableStructure, rows: Row[]): TableStructure => ({
  columns: rows.filter((r) => !r.deleted).map((r) => ({ ...r.col, default: r.col.default?.trim() ? r.col.default : null })),
  primary_key: s.primary_key,
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
