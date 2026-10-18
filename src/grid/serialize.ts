import type { Cell, ColumnInfo, Driver } from "../api/types";
import { quoteIdent, quoteLiteral } from "../sql/quote";

/**
 * INSERT용 리터럴. Windows 클립보드는 LF를 CRLF로 바꾸므로 줄바꿈은 이스케이프로 쓴다.
 */
export function sqlLiteral(driver: Driver, s: string): string {
  if (!/[\r\n]/.test(s)) return quoteLiteral(driver, s);
  if (driver === "mysql") return quoteLiteral(driver, s).replaceAll("\n", "\\n").replaceAll("\r", "\\r");
  if (driver === "postgres")
    return "E'" + s.replaceAll("\\", "\\\\").replaceAll("'", "''").replaceAll("\n", "\\n").replaceAll("\r", "\\r") + "'";
  // SQLite에는 이스케이프가 없어 char()로 잇는다
  return s
    .split(/(\r|\n)/)
    .filter((p) => p !== "")
    .map((p) => (p === "\n" ? "char(10)" : p === "\r" ? "char(13)" : quoteLiteral(driver, p)))
    .join(" || ");
}

export interface Slice {
  columns: ColumnInfo[];
  rows: Cell[][];
}

/** 선택 범위(없으면 전체)를 잘라 낸다. rowsSel은 행 마커로 고른 행들. */
export function slice(
  columns: ColumnInfo[],
  getRow: (r: number) => Cell[],
  rowCount: number,
  range: { x: number; y: number; width: number; height: number } | null,
  rowsSel: number[],
): Slice {
  if (rowsSel.length && (!range || range.width * range.height <= 1)) return { columns, rows: rowsSel.map(getRow) };
  if (!range || range.width * range.height <= 1) return { columns, rows: Array.from({ length: rowCount }, (_, i) => getRow(i)) };
  const cols = columns.slice(range.x, range.x + range.width);
  const rows: Cell[][] = [];
  for (let y = range.y; y < range.y + range.height; y++) rows.push(getRow(y).slice(range.x, range.x + range.width));
  return { columns: cols, rows };
}

const plain = (c: Cell): string | null => (c.t === "Text" ? c.v : null);

export function toTsv(s: Slice, header = false): string {
  const esc = (v: string) => (/[\t\n\r"]/.test(v) ? `"${v.replaceAll('"', '""')}"` : v);
  const lines = s.rows.map((r) => r.map((c) => esc(plain(c) ?? "")).join("\t"));
  if (header) lines.unshift(s.columns.map((c) => esc(c.name)).join("\t"));
  return lines.join("\r\n");
}

/** 행 배열 JSON. 값은 문자열 그대로(정밀도 보존), NULL·바이너리는 null */
export function toJson(s: Slice): string {
  const objs = s.rows.map((r) => Object.fromEntries(s.columns.map((c, i) => [c.name, plain(r[i])])));
  return JSON.stringify(objs, null, 2);
}

/** 선택 행을 INSERT 문으로. 바이너리 값은 NULL로 쓰고 주석을 단다. */
export function toInsert(s: Slice, driver: Driver, table: string): string {
  const cols = s.columns.map((c) => quoteIdent(driver, c.name)).join(", ");
  return s.rows
    .map((r) => {
      const hasBlob = r.some((c) => c.t === "Blob" || c.t === "Unsupported");
      const vals = r.map((c) => (c.t === "Text" ? sqlLiteral(driver, c.v) : "NULL")).join(", ");
      return `INSERT INTO ${table} (${cols}) VALUES (${vals});${hasBlob ? " -- 바이너리 값은 NULL로 대체됨" : ""}`;
    })
    .join("\n");
}
