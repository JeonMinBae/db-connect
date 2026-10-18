import { describe, expect, it } from "vitest";
import type { ColumnDef, TableStructure } from "../api/types";
import { isTextual, newTableDraft, renameColumnFor, revertColumn, changeCount, changedFields, charsetChanged, optionsChanged, draftChangeCount, draftOf, entryState, moveRow, newEntry, newRow, orderChanged, parseList, removeEntry, renameColumnRefs, revertEntry, revertRow, rowState, rowsOf, toDraft, toStructure } from "./draft";

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
const s: TableStructure = { columns: [col("id"), col("name", "text"), col("qty")], primary_key: ["id"], primary_key_name: null, indexes: [], foreign_keys: [], checks: [], checks_unsupported: false, options: { comment: null, engine: null, charset: null, collation: null, row_format: null, convert: false } };

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

describe("indexes and constraints draft", () => {
  const t: TableStructure = {
    ...s,
    primary_key_name: "t_pkey",
    indexes: [{ orig_name: "ix", name: "ix", columns: ["name", "qty"], unique: false, constraint: false, raw: null }],
    foreign_keys: [{ orig_name: "fk", name: "fk", columns: ["qty"], ref_schema: null, ref_table: "p", ref_columns: ["id"], on_update: "NO ACTION", on_delete: "CASCADE" }],
    checks: [{ orig_name: "ck", name: "ck", expr: "qty > 0" }],
  };

  it("상태·되돌리기·삭제", () => {
    let d = draftOf(t);
    expect(draftChangeCount(t, d)).toBe(0);
    d.indexes[0] = { ...d.indexes[0], def: { ...d.indexes[0].def, unique: true } };
    d.checks = removeEntry(d.checks, d.checks[0].key);
    d.fks = [...d.fks, newEntry({ ...t.foreign_keys[0], orig_name: null, name: "" })];
    expect(d.indexes.map((e) => entryState(t.indexes, e))).toEqual(["modified"]);
    expect(d.checks.map((e) => entryState(t.checks, e))).toEqual(["deleted"]);
    expect(d.fks.map((e) => entryState(t.foreign_keys, e))).toEqual(["same", "added"]);
    expect(draftChangeCount(t, d)).toBe(3);
    d = { ...d, indexes: revertEntry(t.indexes, d.indexes, d.indexes[0].key), checks: revertEntry(t.checks, d.checks, d.checks[0].key) };
    d.fks = removeEntry(d.fks, d.fks[1].key);
    expect(draftChangeCount(t, d)).toBe(0);
  });

  it("컬럼 이름 변경이 기본키·인덱스·외래 키에 따라간다", () => {
    const d = renameColumnRefs(draftOf(t), "qty", "amount");
    expect(d.indexes[0].def.columns).toEqual(["name", "amount"]);
    expect(d.fks[0].def.columns).toEqual(["amount"]);
    expect(renameColumnRefs(draftOf(t), "id", "key").pk).toEqual(["key"]);
  });

  it("초안 구조: 삭제 항목 제외, 기본키 반영", () => {
    const d = draftOf(t);
    d.pk = ["id", "name"];
    d.indexes = removeEntry(d.indexes, d.indexes[0].key);
    const out = toStructure(t, d);
    expect(out.primary_key).toEqual(["id", "name"]);
    expect(out.primary_key_name).toBe("t_pkey");
    expect(out.indexes).toEqual([]);
    expect(out.foreign_keys).toHaveLength(1);
    expect(parseList(" a, ,b ,")).toEqual(["a", "b"]);
  });
});

describe("table options draft", () => {
  it("빈 문자열은 없음, convert는 변경이 아님", () => {
    const d = draftOf(s);
    d.options = { ...d.options, comment: "  ", convert: true };
    expect(optionsChanged(s, d)).toBe(false);
    d.options = { ...d.options, charset: "utf8mb4" };
    expect(optionsChanged(s, d)).toBe(true);
    expect(charsetChanged(s, d)).toBe(true);
    expect(draftChangeCount(s, d)).toBe(1);
    expect(toStructure(s, d).options.charset).toBe("utf8mb4");
  });
});

describe("review fixes", () => {
  const t: TableStructure = {
    ...s,
    indexes: [{ orig_name: "ix", name: "ix", columns: ["name"], unique: false, constraint: false, raw: null }],
  };

  it("다른 컬럼과 이름이 겹치면 참조를 옮기지 않는다 (id → idx를 입력하는 중간의 'id')", () => {
    const d = draftOf(t);
    const n = newRow();
    d.columns.push(n);
    // 새 컬럼 이름을 "" → "idx"로 마치면 참조 변화 없음
    expect(renameColumnFor(d, n.key, "", "idx").pk).toEqual(["id"]);
    // 기존 컬럼 이름이 다른 컬럼과 같아지면 건너뜀
    const dup = { ...d, columns: d.columns.map((r) => (r.key === n.key ? { ...r, col: { ...r.col, name: "id" } } : r)) };
    expect(renameColumnFor(dup, d.columns[0].key, "id", "uid").pk).toEqual(["id"]);
    // 정상 이름 변경은 반영
    expect(renameColumnFor(d, d.columns[1].key, "name", "nm").indexes[0].def.columns).toEqual(["nm"]);
  });

  it("행 되돌리기는 참조 이름도 원래대로", () => {
    let d = draftOf(t);
    const key = d.columns[0].key;
    d = { ...d, columns: d.columns.map((r) => (r.key === key ? { ...r, col: { ...r.col, name: "uid" } } : r)) };
    d = renameColumnFor(d, key, "id", "uid");
    expect(d.pk).toEqual(["uid"]);
    d = revertColumn(t, d, key);
    expect(d.pk).toEqual(["id"]);
    expect(d.columns[0].col.name).toBe("id");
  });

  it("문자열 타입 판정, 새 테이블 초안", () => {
    expect(isTextual("varchar(10)")).toBe(true);
    expect(isTextual(" ENUM('a')")).toBe(true);
    expect(isTextual("int")).toBe(false);
    expect(isTextual("textual_type")).toBe(false);
    const n = newTableDraft("sqlite");
    expect(n.columns[0].col).toMatchObject({ name: "id", full_type: "INTEGER", auto_increment: true, nullable: false });
    expect(n.pk).toEqual(["id"]);
    expect(newTableDraft("postgres").columns[0].col.full_type).toBe("bigint");
  });
});
