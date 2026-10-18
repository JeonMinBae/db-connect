import type { Cell, ColumnInfo, ColumnMeta } from "../api/types";
import type { EditInfo } from "../sql/editable";
import type { Bytes } from "./bytes";

export type RedisType = "string" | "hash" | "list" | "set" | "zset" | "stream";
export const CONTAINER_TYPES: RedisType[] = ["hash", "list", "set", "zset", "stream"];

/** 타입별 그리드 컬럼과 편집 가능한 컬럼 */
export const COLUMNS: Record<Exclude<RedisType, "string">, { names: string[]; editable: boolean[] }> = {
  hash: { names: ["field", "value"], editable: [true, true] },
  list: { names: ["index", "value"], editable: [false, true] },
  set: { names: ["member"], editable: [true] },
  zset: { names: ["member", "score"], editable: [true, true] },
  stream: { names: ["id", "fields"], editable: [false, false] },
};

export const columnInfos = (t: Exclude<RedisType, "string">): ColumnInfo[] => COLUMNS[t].names.map((name) => ({ name, type_name: name === "score" || name === "index" ? "numeric" : "text" }));

/** 바이너리 값은 원래 바이트로 되돌릴 수 없으므로 편집하지 않는다 (Unsupported 셀로 표시) */
export const cellOf = (b: Bytes): Cell => (b.t === "Text" ? { t: "Text", v: b.v } : { t: "Unsupported", v: `"${b.v}"` });

const meta = (name: string, ordinal: number): ColumnMeta => ({
  name,
  data_type: name === "score" ? "double" : "text",
  full_type: "text",
  nullable: false,
  is_pk: false,
  is_unique_not_null: false,
  enum_values: null,
  ordinal,
});

/** 기존 그리드 편집기를 쓰기 위한 편집 정보. key는 SQL 편집용이라 쓰지 않는다. */
export function editInfoOf(t: Exclude<RedisType, "string">): EditInfo | null {
  const c = COLUMNS[t];
  if (!c.editable.some(Boolean)) return null;
  return { colMeta: c.names.map((n, i) => (c.editable[i] ? meta(n, i + 1) : null)), key: { mode: "pk", cols: [0] } };
}

/** TTL 표시: -1 없음, -2 키 없음 */
export function ttlText(ttl: number): string {
  if (ttl === -1) return "만료 없음";
  if (ttl === -2) return "키 없음";
  if (ttl < 60) return `${ttl}초`;
  if (ttl < 3600) return `${Math.floor(ttl / 60)}분 ${ttl % 60}초`;
  if (ttl < 86400) return `${Math.floor(ttl / 3600)}시간 ${Math.floor((ttl % 3600) / 60)}분`;
  return `${Math.floor(ttl / 86400)}일 ${Math.floor((ttl % 86400) / 3600)}시간`;
}

export function sizeText(bytes: number | null | undefined): string {
  if (bytes == null) return "?";
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / 1024 / 1024).toFixed(1)} MB`;
}
