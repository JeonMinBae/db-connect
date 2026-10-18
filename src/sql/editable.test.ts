import { describe, expect, it } from "vitest";
import type { ColumnMeta, Driver } from "../api/types";
import { analyzeEditable, resolveEdit } from "./editable";
import { splitStatements } from "./split";

const target = (sql: string, d: Driver = "postgres") => analyzeEditable(splitStatements(sql, d)[0], d);

describe("analyzeEditable", () => {
  it("accepts single-table selects", () => {
    expect(target("SELECT * FROM users")).toEqual({ schema: null, table: "users" });
    expect(target("select id, name from public.Users u where id > 1 order by id limit 10")).toEqual({ schema: "public", table: "users" });
    expect(target('SELECT * FROM "Weird ""Name"" Table" AS w')).toEqual({ schema: null, table: 'Weird "Name" Table' });
    expect(target("SELECT * FROM `Weird \"Name\" Table`", "mysql")).toEqual({ schema: null, table: 'Weird "Name" Table' });
    expect(target("SELECT * FROM Users", "mysql")).toEqual({ schema: null, table: "Users" });
    expect(target("SELECT * FROM t WHERE id IN (SELECT id FROM u JOIN v ON true)")).toEqual({ schema: null, table: "t" });
  });

  it("rejects multi-table and computed results", () => {
    const rejected = [
      "SELECT * FROM a JOIN b ON a.id = b.id",
      "SELECT * FROM a, b",
      "SELECT * FROM (SELECT 1) s",
      "SELECT grp, count(*) FROM big GROUP BY grp",
      "SELECT count(*) FROM big",
      "SELECT DISTINCT grp FROM big",
      "SELECT 1 UNION SELECT 2",
      "WITH x AS (SELECT 1) SELECT * FROM x",
      "SELECT 1",
      "UPDATE t SET a = 1",
    ];
    for (const sql of rejected) expect("reason" in target(sql), sql).toBe(true);
  });
});

const m = (name: string, o: Partial<ColumnMeta> = {}): ColumnMeta => ({
  name,
  data_type: "text",
  full_type: "text",
  nullable: true,
  is_pk: false,
  is_unique_not_null: false,
  enum_values: null,
  ordinal: 0,
  ...o,
});
const cols = (...names: string[]) => names.map((name) => ({ name, type_name: "TEXT" }));

describe("resolveEdit", () => {
  it("prefers the primary key", () => {
    const r = resolveEdit(cols("name", "id"), [m("id", { is_pk: true }), m("name")]);
    expect(r).toMatchObject({ key: { mode: "pk", cols: [1] } });
  });

  it("needs every pk column for composite keys", () => {
    const meta = [m("a", { is_pk: true }), m("b", { is_pk: true }), m("u", { is_unique_not_null: true }), m("x")];
    expect(resolveEdit(cols("a", "b", "x"), meta)).toMatchObject({ key: { mode: "pk", cols: [0, 1] } });
    expect(resolveEdit(cols("a", "u", "x"), meta)).toMatchObject({ key: { mode: "unique", cols: [1] } });
  });

  it("falls back to all non-binary columns", () => {
    const meta = [m("label"), m("qty"), m("pic", { data_type: "bytea" })];
    const r = resolveEdit([...cols("label", "qty", "pic"), { name: "calc", type_name: "INT" }], meta);
    expect(r).toMatchObject({ key: { mode: "allColumns", cols: [0, 1] } });
    if ("colMeta" in r) expect(r.colMeta[3]).toBeNull();
  });

  it("rejects results without identifiable columns", () => {
    expect("reason" in resolveEdit(cols("calc"), [m("label")])).toBe(true);
  });
});
