import { describe, expect, it } from "vitest";
import { splitStatements } from "./split";
import { isRisky, pickStatements, riskyTable, toSubmitStatements } from "./statements";

const one = (sql: string, d: "postgres" | "mysql" | "sqlite" = "postgres") => splitStatements(sql, d)[0];

describe("pickStatements", () => {
  const doc = "SELECT 1;\nSELECT 2;\nSELECT 3";
  it("uses the cursor statement without a selection", () => {
    const pos = doc.indexOf("SELECT 2") + 2;
    expect(pickStatements(doc, { from: pos, to: pos, head: pos }, "postgres").map((s) => s.text)).toEqual(["SELECT 2"]);
  });
  it("splits the selection and keeps absolute offsets", () => {
    const from = doc.indexOf("SELECT 2");
    const r = pickStatements(doc, { from, to: doc.length, head: doc.length }, "postgres");
    expect(r.map((s) => s.text)).toEqual(["SELECT 2", "SELECT 3"]);
    expect(doc.slice(r[1].from, r[1].to)).toBe("SELECT 3");
  });
});

describe("isRisky / riskyTable", () => {
  it("flags UPDATE/DELETE without a top-level WHERE", () => {
    expect(isRisky(one("DELETE FROM t"))).toBe(true);
    expect(isRisky(one("UPDATE t SET a = 1"))).toBe(true);
    expect(isRisky(one("UPDATE t SET a = (SELECT 1 FROM u WHERE x)"))).toBe(true);
    expect(isRisky(one("DELETE FROM t WHERE id = 1"))).toBe(false);
    expect(isRisky(one("INSERT INTO t SELECT * FROM u"))).toBe(false);
    expect(isRisky(one("WITH x AS (SELECT 1) DELETE FROM t"))).toBe(true);
  });
  it("names the target table", () => {
    expect(riskyTable(one("DELETE FROM public.Users"), "postgres")).toBe("public.users");
    expect(riskyTable(one('UPDATE "My Table" SET a = 1'), "postgres")).toBe("My Table");
    expect(riskyTable(one("DELETE FROM `db`.`t`", "mysql"), "mysql")).toBe("db.t");
  });
});

describe("toSubmitStatements", () => {
  it("marks UPDATE/DELETE as single-row and keeps INSERT free", () => {
    const r = toSubmitStatements("UPDATE t SET a = 'x;y' WHERE id = 1;\n\nINSERT INTO t (a) VALUES ('z');\nDELETE FROM t WHERE id = 2;", "postgres");
    if ("error" in r) throw new Error(r.error);
    expect(r.stmts).toEqual([
      { sql: "UPDATE t SET a = 'x;y' WHERE id = 1", expect_one: true },
      { sql: "INSERT INTO t (a) VALUES ('z')", expect_one: false },
      { sql: "DELETE FROM t WHERE id = 2", expect_one: true },
    ]);
  });
  it("rejects transaction control and empty text", () => {
    expect(toSubmitStatements("UPDATE t SET a = 1 WHERE id = 1; COMMIT;", "mysql")).toHaveProperty("error");
    expect(toSubmitStatements("  -- nothing\n", "sqlite")).toHaveProperty("error");
  });
});
