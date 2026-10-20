import { describe, expect, it } from "vitest";
import type { Cell } from "../api/types";
import { MISSING, mongoNumberOf } from "../mongo/docs";
import { fmtElapsed, fmtStat, forEachSelectedCell, parseNumber, selectionStats, sqlNumberOf, type Rect } from "./selStats";

const cellsOf = (ranges: Rect[], rows: number[] = [], cols: number[] = [], size = { cols: 4, rows: 5 }) => {
  const out: string[] = [];
  forEachSelectedCell(ranges, rows, cols, size, (x, y) => out.push(`${x},${y}`));
  return out.sort();
};

const t = (v: string): Cell => ({ t: "Text", v });
const NULL: Cell = { t: "Null" };

describe("forEachSelectedCell", () => {
  it("겹친 범위는 한 번만 센다", () => {
    expect(cellsOf([{ x: 0, y: 0, width: 2, height: 2 }, { x: 1, y: 1, width: 2, height: 1 }])).toEqual(["0,0", "0,1", "1,0", "1,1", "2,1"]);
  });
  it("통째로 고른 행과 범위가 겹쳐도 한 번", () => {
    expect(cellsOf([{ x: 0, y: 1, width: 1, height: 2 }], [1])).toEqual(["0,1", "0,2", "1,1", "2,1", "3,1"]);
  });
  it("고른 컬럼은 전체 높이", () => {
    expect(cellsOf([], [], [2], { cols: 3, rows: 2 })).toEqual(["2,0", "2,1"]);
  });
  it("결과보다 큰 선택은 자른다", () => {
    expect(cellsOf([{ x: 1, y: 1, width: 5, height: 5 }], [9], [], { cols: 2, rows: 2 })).toEqual(["1,1"]);
  });
});

describe("selectionStats", () => {
  const stats = (grid: Cell[][], numeric: boolean[]) =>
    selectionStats(
      (fn) => forEachSelectedCell([{ x: 0, y: 0, width: grid[0].length, height: grid.length }], [], [], { cols: grid[0].length, rows: grid.length }, fn),
      (x, y) => grid[y][x],
      sqlNumberOf(numeric),
    );

  it("NULL은 칸 수에만 들어간다", () => {
    expect(stats([[t("1")], [NULL], [t("2.5")]], [true])).toEqual({ count: 3, sum: 3.5, avg: 1.75 });
  });
  it("숫자가 아닌 컬럼이 섞이면 합계·평균 없음", () => {
    expect(stats([[t("1"), t("a")]], [true, false])).toEqual({ count: 2, sum: null, avg: null });
  });
  it("모두 NULL이면 합계·평균 없음", () => {
    expect(stats([[NULL], [NULL]], [true])).toEqual({ count: 2, sum: null, avg: null });
  });
});

describe("숫자 읽기", () => {
  it("십진 표기와 NaN·Infinity만", () => {
    expect(parseNumber("-1.5e3")).toBe(-1500);
    expect(parseNumber("Infinity")).toBe(Infinity);
    expect(parseNumber("")).toBeNull();
    expect(parseNumber("0x1f")).toBeNull();
    expect(parseNumber(" 1")).toBeNull();
  });
  it("Mongo는 칸 값으로 판정하고 없는 필드는 뺀다", () => {
    expect(mongoNumberOf(t('NumberLong("12")'), 0)).toBe(12);
    expect(mongoNumberOf(t('NumberDecimal("1.5")'), 0)).toBe(1.5);
    expect(mongoNumberOf(t("3.0"), 0)).toBe(3);
    expect(mongoNumberOf(t('"12"'), 0)).toBeNull();
    expect(mongoNumberOf(MISSING, 0)).toBeUndefined();
  });
});

describe("표시 형식", () => {
  it("합계·평균은 소수 둘째 자리까지", () => {
    expect(fmtStat(1234567.891)).toBe((1234567.89).toLocaleString());
    expect(fmtStat(NaN)).toBe("NaN");
  });
  it("1초부터 초 단위", () => {
    expect(fmtElapsed(245)).toBe("245 ms");
    expect(fmtElapsed(1234)).toBe("1.23 s");
  });
});
