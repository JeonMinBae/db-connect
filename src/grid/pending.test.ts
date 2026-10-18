import { describe, expect, it } from "vitest";
import { NULL, text, type ColumnMeta } from "../api/types";
import type { EditInfo } from "../sql/editable";
import { PendingChanges } from "./pending";
import { buildSubmit } from "./submit";

const rows = () => [
  [text("1"), text("a"), NULL],
  [text("2"), text("b"), text("x")],
  [text("3"), text("c"), text("y")],
];

describe("PendingChanges", () => {
  it("tracks edits and drops edits back to the original value", () => {
    const p = new PendingChanges(rows(), 3);
    p.edit(0, 1, text("A"));
    p.edit(0, 1, text("AA"));
    expect(p.value(0, 1)).toEqual(text("AA"));
    expect(p.stateOf(0, 1)).toBe("edit");
    p.edit(0, 1, text("a"));
    expect(p.stateOf(0, 1)).toBeNull();
    expect(p.isEmpty).toBe(true);
    p.edit(0, 2, text(""));
    expect(p.stateOf(0, 2)).toBe("edit");
    p.edit(0, 2, NULL);
    expect(p.isEmpty).toBe(true);
  });

  it("adds, deletes and reverts rows", () => {
    const p = new PendingChanges(rows(), 3);
    const r = p.addRow();
    expect(r).toBe(3);
    expect(p.rowCount).toBe(4);
    p.edit(r, 1, text("new"));
    expect(p.stateOf(r, 1)).toBe("insert");
    p.deleteRows([1, r]);
    expect(p.rowCount).toBe(3);
    expect(p.inserted).toHaveLength(0);
    expect(p.stateOf(1, 0)).toBe("delete");
    p.edit(1, 1, text("ignored"));
    expect(p.edits.size).toBe(0);
    p.revertRows([1]);
    expect(p.isEmpty).toBe(true);
    p.edit(2, 1, text("z"));
    p.addRow();
    expect(p.count).toBe(2);
    p.revertAll();
    expect(p.isEmpty).toBe(true);
  });
});

const meta = (name: string, full_type = "text"): ColumnMeta => ({
  name,
  data_type: full_type,
  full_type,
  nullable: true,
  is_pk: name === "id",
  is_unique_not_null: false,
  enum_values: null,
  ordinal: 0,
});

describe("buildSubmit", () => {
  const info: EditInfo = { colMeta: [meta("id", "integer"), meta("name"), meta("note")], key: { mode: "pk", cols: [0] } };

  it("orders delete → update → insert and maps rows", () => {
    const p = new PendingChanges(rows(), 3);
    p.edit(2, 1, text("C"));
    p.edit(2, 2, NULL);
    p.deleteRows([0]);
    const r = p.addRow();
    p.edit(r, 1, text("new"));
    const b = buildSubmit(p, info);
    expect(b.rows).toEqual([0, 2, 3]);
    expect(b.changes).toEqual([
      { op: "delete", key: [{ col: { name: "id", full_type: "integer" }, value: "1" }] },
      {
        op: "update",
        key: [{ col: { name: "id", full_type: "integer" }, value: "3" }],
        set: [
          { col: { name: "name", full_type: "text" }, value: "C" },
          { col: { name: "note", full_type: "text" }, value: null },
        ],
      },
      { op: "insert", values: [{ col: { name: "name", full_type: "text" }, value: "new" }] },
    ]);
  });

  it("uses null key values for all-column matching", () => {
    const p = new PendingChanges(rows(), 3);
    p.edit(0, 1, text("q"));
    const all: EditInfo = { ...info, key: { mode: "allColumns", cols: [0, 1, 2] } };
    const b = buildSubmit(p, all);
    expect(b.changes[0]).toMatchObject({ op: "update", key: [{ value: "1" }, { value: "a" }, { value: null }] });
  });

  it("refuses binary key values", () => {
    const p = new PendingChanges([[{ t: "Blob", v: 3 }, text("a"), NULL]], 3);
    p.edit(0, 1, text("b"));
    expect(() => buildSubmit(p, info)).toThrow(/키 컬럼/);
  });
});

describe("undo / redo", () => {
  const base = () => new PendingChanges([[text("a"), text("b")], [text("c"), text("d")]], 2);

  it("undoes and redoes one action at a time", () => {
    const p = base();
    p.transact(() => p.edit(0, 0, text("x")));
    p.transact(() => p.deleteRows([1]));
    let r = 0;
    p.transact(() => (r = p.addRow()));
    p.transact(() => p.edit(r, 1, text("new")));
    expect(p.count).toBe(3);
    expect(p.undo()).toBe(true);
    expect(p.insertedTouched[0].size).toBe(0);
    expect(p.undo()).toBe(true);
    expect(p.inserted.length).toBe(0);
    expect(p.undo()).toBe(true);
    expect(p.deleted.size).toBe(0);
    expect(p.value(0, 0)).toEqual(text("x"));
    expect(p.undo()).toBe(true);
    expect(p.isEmpty).toBe(true);
    expect(p.undo()).toBe(false);
    p.redo();
    p.redo();
    p.redo();
    p.redo();
    expect(p.value(2, 1)).toEqual(text("new"));
    expect(p.deleted.has(1)).toBe(true);
    expect(p.redo()).toBe(false);
  });

  it("groups a paste, skips no-ops and clears redo on a new action", () => {
    const p = base();
    p.transact(() => {
      p.edit(0, 0, text("1"));
      p.edit(1, 1, text("2"));
    });
    p.transact(() => p.edit(0, 1, text("b"))); // 원래 값과 같아 바뀐 것 없음
    expect(p.canUndo).toBe(true);
    p.undo();
    expect(p.isEmpty).toBe(true);
    expect(p.canUndo).toBe(false);
    expect(p.canRedo).toBe(true);
    p.transact(() => p.edit(1, 0, text("z")));
    expect(p.canRedo).toBe(false);
  });

  it("restores revertAll", () => {
    const p = base();
    p.transact(() => p.edit(0, 0, text("x")));
    p.transact(() => p.revertAll());
    p.undo();
    expect(p.value(0, 0)).toEqual(text("x"));
  });
});
