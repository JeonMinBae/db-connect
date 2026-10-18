import { GridCellKind, type GridCell } from "@glideapps/glide-data-grid";
import type { Cell, ColumnInfo } from "../api/types";

const NUMERIC = new Set([
  "INT", "INT2", "INT4", "INT8", "INTEGER", "TINYINT", "SMALLINT", "MEDIUMINT", "BIGINT", "SERIAL", "BIGSERIAL",
  "NUMERIC", "DECIMAL", "FLOAT", "FLOAT4", "FLOAT8", "DOUBLE", "REAL", "MONEY", "OID", "YEAR",
]);

export const isNumericType = (typeName: string) => NUMERIC.has(typeName.toUpperCase().split(/[ (]/)[0]);

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
  return `${(n / 1024 / 1024).toFixed(1)} MB`;
}

/** 표시용 문자열 (한 줄) */
export function displayText(c: Cell): string {
  switch (c.t) {
    case "Null":
      return "<null>";
    case "Blob":
      return `<blob ${fmtBytes(c.v)}>`;
    case "Unsupported":
      return `<${c.v}>`;
    case "Text":
      return c.v.length > 500 ? c.v.slice(0, 500).replace(/\r?\n/g, "↵") + "…" : c.v.replace(/\r?\n/g, "↵");
  }
}

/** 복사용 문자열 (TSV) */
export function copyText(c: Cell): string {
  return c.t === "Text" ? c.v : "";
}

export interface CellStyle {
  muted: string;
  bg?: string;
  strike?: boolean;
}

/** numeric: 컬럼이 숫자 타입인지 (컬럼마다 한 번만 계산해 넘긴다) */
export function toGridCell(c: Cell, numeric: boolean, editable: boolean, style: CellStyle): GridCell {
  const special = c.t !== "Text";
  // 셀마다 호출되므로 꼭 필요할 때만 테마 객체를 만든다
  let themeOverride: { textDark?: string; bgCell?: string } | undefined;
  if (special || style.strike || style.bg) {
    themeOverride = {};
    if (special || style.strike) themeOverride.textDark = style.muted;
    if (style.bg) themeOverride.bgCell = style.bg;
  }
  return {
    kind: GridCellKind.Text,
    data: c.t === "Text" ? c.v : "",
    displayData: displayText(c),
    copyData: copyText(c),
    allowOverlay: editable || c.t === "Text",
    readonly: !editable,
    contentAlign: !special && numeric ? "right" : "left",
    themeOverride,
  };
}

/** 첫 페이지 값 길이로 컬럼 폭을 정한다 (최대 400px) */
export function columnWidths(columns: ColumnInfo[], rows: Cell[][]): number[] {
  return columns.map((col, i) => {
    let max = col.name.length + 2;
    for (let r = 0; r < Math.min(rows.length, 200); r++) {
      const len = displayText(rows[r][i]).length;
      if (len > max) max = len;
    }
    return Math.max(60, Math.min(400, Math.round(max * 7.2 + 20)));
  });
}
