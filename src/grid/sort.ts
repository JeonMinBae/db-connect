import type { Cell, ColumnInfo, Driver } from "../api/types";
import { quoteIdent } from "../sql/quote";
import { isNumericType } from "./cells";

export interface SortKey {
  col: number;
  desc: boolean;
}

/** 헤더 클릭: ASC → DESC → 해제. shift면 다중 정렬에 추가/변경한다. */
export function cycleSort(keys: SortKey[], col: number, shift: boolean): SortKey[] {
  const cur = keys.find((k) => k.col === col);
  const next: SortKey | null = !cur ? { col, desc: false } : !cur.desc ? { col, desc: true } : null;
  if (!shift) return next ? [next] : [];
  const rest = keys.filter((k) => k.col !== col);
  if (!next) return rest;
  return cur ? keys.map((k) => (k.col === col ? next : k)) : [...rest, next];
}

export function orderByText(keys: SortKey[], columns: ColumnInfo[], driver: Driver): string {
  return keys.map((k) => quoteIdent(driver, columns[k.col].name) + (k.desc ? " DESC" : "")).join(", ");
}

export function sortSuffix(keys: SortKey[], col: number): string {
  const i = keys.findIndex((k) => k.col === col);
  if (i < 0) return "";
  return (keys[i].desc ? " ▼" : " ▲") + (keys.length > 1 ? String(i + 1) : "");
}

/** 현재 페이지를 클라이언트에서 정렬한 행 순서. NULL은 맨 뒤. */
export function clientOrder(rows: Cell[][], keys: SortKey[], columns: ColumnInfo[]): number[] {
  const idx = rows.map((_, i) => i);
  if (!keys.length) return idx;
  const numeric = columns.map((c) => isNumericType(c.type_name));
  const cmp = (a: Cell, b: Cell, num: boolean): number => {
    if (a.t !== "Text" || b.t !== "Text") return (a.t === "Text" ? 0 : 1) - (b.t === "Text" ? 0 : 1);
    if (num) return Number(a.v) - Number(b.v);
    return a.v < b.v ? -1 : a.v > b.v ? 1 : 0;
  };
  return idx.sort((x, y) => {
    for (const k of keys) {
      const nullish = rows[x][k.col].t !== "Text" || rows[y][k.col].t !== "Text";
      const c = cmp(rows[x][k.col], rows[y][k.col], numeric[k.col]);
      if (c) return k.desc && !nullish ? -c : c;
    }
    return x - y;
  });
}
