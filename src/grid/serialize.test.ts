import { describe, expect, it } from "vitest";
import { NULL, text, type Cell } from "../api/types";
import { slice, sqlLiteral, toInsert, toJson, toTsv } from "./serialize";

const columns = [
  { name: "id", type_name: "INT4" },
  { name: "name", type_name: "TEXT" },
  { name: "pic", type_name: "BYTEA" },
];
const rows: Cell[][] = [
  [text("1"), text("O'Brien, \"Bob\""), { t: "Blob", v: 3 }],
  [text("2"), NULL, NULL],
  [text("3"), text("back\\slash"), NULL],
];
const all = { columns, rows };

describe("serialize", () => {
  it("slices by range or selected rows", () => {
    const get = (r: number) => rows[r];
    expect(slice(columns, get, 3, null, []).rows).toHaveLength(3);
    expect(slice(columns, get, 3, { x: 1, y: 1, width: 1, height: 2 }, [])).toEqual({ columns: [columns[1]], rows: [[NULL], [text("back\\slash")]] });
    expect(slice(columns, get, 3, null, [2]).rows).toEqual([rows[2]]);
  });

  it("slices the given data columns when the grid columns were reordered", () => {
    const get = (r: number) => rows[r];
    // 화면에서 pic, id 순으로 옮겨 고른 범위 → 원래 순서(id, pic)로 잘라 낸다
    expect(slice(columns, get, 3, { x: 0, y: 0, width: 2, height: 1 }, [], [0, 2])).toEqual({ columns: [columns[0], columns[2]], rows: [[text("1"), { t: "Blob", v: 3 }]] });
  });

  it("writes TSV", () => {
    expect(toTsv({ columns, rows: [rows[1]] }, true)).toBe("id\tname\tpic\r\n2\t\t");
  });

  it("writes JSON with string values", () => {
    expect(JSON.parse(toJson(all))).toEqual([
      { id: "1", name: 'O\'Brien, "Bob"', pic: null },
      { id: "2", name: null, pic: null },
      { id: "3", name: "back\\slash", pic: null },
    ]);
  });

  it("escapes newlines so the clipboard cannot change them", () => {
    expect(sqlLiteral("postgres", "a\nb'c\\")).toBe("E'a\\nb''c\\\\'");
    expect(sqlLiteral("mysql", "a\r\nb")).toBe("'a\\r\\nb'");
    expect(sqlLiteral("sqlite", "a\nb")).toBe("'a' || char(10) || 'b'");
    expect(sqlLiteral("sqlite", "plain")).toBe("'plain'");
  });

  it("writes INSERT statements per dialect", () => {
    const pg = toInsert({ columns: columns.slice(0, 2), rows: rows.map((r) => r.slice(0, 2)) }, "postgres", '"users"');
    expect(pg.split("\n")).toEqual([
      `INSERT INTO "users" ("id", "name") VALUES ('1', 'O''Brien, "Bob"');`,
      `INSERT INTO "users" ("id", "name") VALUES ('2', NULL);`,
      `INSERT INTO "users" ("id", "name") VALUES ('3', 'back\\slash');`,
    ]);
    const my = toInsert({ columns, rows: [rows[2], rows[0]] }, "mysql", "`users`").split("\n");
    expect(my[0]).toBe("INSERT INTO `users` (`id`, `name`, `pic`) VALUES ('3', 'back\\\\slash', NULL);");
    expect(my[1]).toContain("-- 바이너리 값은 NULL로 대체됨");
  });
});
