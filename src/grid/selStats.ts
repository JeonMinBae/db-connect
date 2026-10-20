import type { Cell } from "../api/types";

export type Rect = { x: number; y: number; width: number; height: number };

/** 칸 값 → 숫자. undefined 는 집계에서 빼는 빈 칸(NULL·없는 필드), null 은 숫자가 아닌 칸 */
export type NumberOf = (cell: Cell, col: number) => number | null | undefined;

export interface SelStats {
  count: number;
  /** 빈 칸을 뺀 나머지가 모두 숫자일 때만 */
  sum: number | null;
  avg: number | null;
}

// Number("") 가 0, Number("0x1f") 가 31 이 되는 것을 막으려고 십진 표기만 받는다
const DECIMAL = /^[+-]?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/;
const SPECIAL = new Set(["NaN", "Infinity", "-Infinity"]);

export const parseNumber = (s: string): number | null => (DECIMAL.test(s) || SPECIAL.has(s) ? Number(s) : null);

/** SQL: 숫자 타입 컬럼의 텍스트만 숫자로 본다 */
export const sqlNumberOf =
  (numericCols: boolean[]): NumberOf =>
  (c, col) =>
    c.t === "Null" ? undefined : numericCols[col] && c.t === "Text" ? parseNumber(c.v) : null;

/**
 * 범위 여러 개와 통째로 고른 행·컬럼이 덮는 칸을 겹침 없이 한 번씩 넘긴다 (표시 좌표).
 * 고른 컬럼은 전체 높이의 범위로 바꿔 범위와 같이 합친다.
 * 결과를 새로 받아 행이 줄어도 선택은 남아 있을 수 있으므로 size 밖은 자른다.
 */
export function forEachSelectedCell(
  ranges: Rect[],
  rows: number[],
  cols: number[],
  size: { cols: number; rows: number },
  fn: (x: number, y: number) => void,
) {
  const full = new Set(rows.filter((y) => y < size.rows));
  for (const y of full) for (let x = 0; x < size.cols; x++) fn(x, y);
  const all = [...ranges, ...cols.map((x) => ({ x, y: 0, width: 1, height: size.rows }))];
  // 행마다 덮는 컬럼 구간 [시작, 끝)
  const spans = new Map<number, [number, number][]>();
  for (const r of all)
    for (let y = r.y; y < Math.min(r.y + r.height, size.rows); y++) {
      if (full.has(y)) continue;
      const span: [number, number] = [r.x, Math.min(r.x + r.width, size.cols)];
      const s = spans.get(y);
      if (s) s.push(span);
      else spans.set(y, [span]);
    }
  for (const [y, s] of spans) {
    s.sort((a, b) => a[0] - b[0]);
    let end = -1;
    for (const [a, b] of s) {
      for (let x = Math.max(a, end); x < b; x++) fn(x, y);
      end = Math.max(end, b);
    }
  }
}

export function selectionStats(visit: (fn: (x: number, y: number) => void) => void, cellAt: (x: number, y: number) => Cell, numberOf: NumberOf): SelStats {
  let count = 0;
  let sum = 0;
  let n = 0;
  let numeric = true;
  visit((x, y) => {
    count++;
    if (!numeric) return;
    const v = numberOf(cellAt(x, y), x);
    if (v === null) numeric = false;
    else if (v !== undefined) (sum += v), n++;
  });
  return numeric && n ? { count, sum, avg: sum / n } : { count, sum: null, avg: null };
}

export const fmtStat = (v: number) => (Number.isFinite(v) ? v.toLocaleString(undefined, { maximumFractionDigits: 2 }) : String(v));

export const fmtElapsed = (ms: number) => (ms < 1000 ? `${ms} ms` : `${(ms / 1000).toFixed(2)} s`);
