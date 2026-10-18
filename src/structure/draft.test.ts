import { describe, expect, it } from "vitest";
import type { ColumnDef, TableStructure } from "../api/types";
import { changeCount, changedFields, moveRow, newRow, orderChanged, revertRow, rowState, rowsOf, toDraft } from "./draft";

const col = (name: string, full_type = "int"): ColumnDef => ({
  orig_name: name,
  name,
  full_type,
  nullable: true,
  default: null,
  auto_increment: false,
  generated: false,
  comment: null,
  charset: null,
  collation: null,
  on_update: null,
});
const s: TableStructure = { columns: [col("id"), col("name", "text"), col("qty")], primary_key: ["id"] };

describe("structure draft", () => {
  it("행 상태: 추가/삭제/수정/이름 변경", () => {
    const rows = rowsOf(s);
    expect(rows.map((r) => rowState(s, r))).toEqual(["same", "same", "same"]);
    rows[1] = { ...rows[1], col: { ...rows[1].col, name: "nm" } };
    rows[2] = { ...rows[2], deleted: true };
    const added = newRow();
    rows.push(added);
    expect(rows.map((r) => rowState(s, r))).toEqual(["same", "modified", "deleted", "added"]);
    expect([...changedFields(s, rows[1])]).toEqual(["name"]);
    expect(changeCount(s, rows)).toBe(3);
  });

  it("타입 앞뒤 공백은 변경이 아니다", () => {
    const rows = rowsOf(s);
    rows[0].col.full_type = " int ";
    expect(rowState(s, rows[0])).toBe("same");
  });

  it("되돌리기와 전체 취소", () => {
    let rows = rowsOf(s);
    rows[1].col.full_type = "varchar(10)";
    rows[2].deleted = true;
    const n = newRow();
    rows.push(n);
    rows = revertRow(s, rows, rows[1].key);
    expect(rows[1].col).toEqual(s.columns[1]);
    rows = revertRow(s, rows, rows[2].key);
    expect(rows[2].deleted).toBe(false);
    rows = revertRow(s, rows, n.key);
    expect(rows).toHaveLength(3);
    expect(changeCount(s, rows)).toBe(0);
  });

  it("순서 변경 판정", () => {
    const rows = rowsOf(s);
    expect(orderChanged(s, rows)).toBe(false);
    expect(orderChanged(s, moveRow(rows, rows[0].key, 1))).toBe(true);
    // 새 컬럼이 맨 뒤면 순서 변경이 아니고, 중간이면 순서 변경이다
    const withNew = [...rows, newRow()];
    expect(orderChanged(s, withNew)).toBe(false);
    expect(orderChanged(s, moveRow(withNew, withNew[3].key, -1))).toBe(true);
    // 삭제한 컬럼은 순서 판단에서 빠진다
    const del = rowsOf(s);
    del[0].deleted = true;
    expect(orderChanged(s, moveRow(del, del[0].key, 1))).toBe(false);
    expect(moveRow(rows, rows[0].key, -1)).toBe(rows);
  });

  it("초안: 삭제 행 제외, 빈 기본값은 null", () => {
    const rows = rowsOf(s);
    rows[0].deleted = true;
    rows[1].col.default = "  ";
    const d = toDraft(s, rows);
    expect(d.columns.map((c) => c.name)).toEqual(["name", "qty"]);
    expect(d.columns[0].default).toBeNull();
    expect(d.primary_key).toEqual(["id"]);
  });
});
