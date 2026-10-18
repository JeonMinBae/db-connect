import { describe, expect, it } from "vitest";
import { splitStatements, statementAt } from "./split";

const texts = (src: string, d: "postgres" | "mysql" | "sqlite" = "postgres") => splitStatements(src, d).map((s) => s.text);

describe("splitStatements", () => {
  it("splits on top-level semicolons", () => {
    expect(texts("SELECT 1; SELECT 2;\n\nSELECT 3")).toEqual(["SELECT 1", "SELECT 2", "SELECT 3"]);
  });

  it("ignores semicolons in strings and comments", () => {
    expect(texts("SELECT 'a;b'; -- x;y\nSELECT /* ; */ 2")).toEqual(["SELECT 'a;b'", "-- x;y\nSELECT /* ; */ 2"]);
    expect(texts("SELECT 'it''s;'; SELECT 2")).toEqual(["SELECT 'it''s;'", "SELECT 2"]);
  });

  it("handles PG dollar quoting and E strings", () => {
    const src = "CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql; SELECT E'a\\';b'";
    expect(texts(src)).toEqual(["CREATE FUNCTION f() RETURNS int AS $$ BEGIN RETURN 1; END; $$ LANGUAGE plpgsql", "SELECT E'a\\';b'"]);
    expect(texts("SELECT $tag$ ; $tag$; SELECT $1")).toEqual(["SELECT $tag$ ; $tag$", "SELECT $1"]);
  });

  it("handles MySQL backticks, # comments and backslash escapes", () => {
    expect(texts("SELECT `a;b` FROM t # c;d\n; SELECT 'x\\';y'", "mysql")).toEqual(["SELECT `a;b` FROM t # c;d", "SELECT 'x\\';y'"]);
  });

  it("drops comment-only fragments", () => {
    expect(texts("-- only comment\n;  ;\nSELECT 1")).toEqual(["SELECT 1"]);
  });

  it("keeps absolute offsets", () => {
    const src = "  SELECT 1;\nSELECT 2";
    const [a, b] = splitStatements(src, "sqlite");
    expect(src.slice(a.from, a.to)).toBe("SELECT 1");
    expect(src.slice(b.from, b.to)).toBe("SELECT 2");
  });
});

describe("analyze", () => {
  const one = (src: string, d: "postgres" | "mysql" | "sqlite" = "postgres") => splitStatements(src, d)[0];

  it("classifies kinds", () => {
    expect(one("select * from t").kind).toBe("query");
    expect(one("WITH x AS (SELECT 1) SELECT * FROM x").kind).toBe("query");
    const w = one("WITH x AS (SELECT id FROM t) UPDATE t SET a = 1 WHERE id IN (SELECT id FROM x)");
    expect(w.kind).toBe("dml");
    expect(w.dmlVerb).toBe("UPDATE");
    expect(one("BEGIN").kind).toBe("tx");
    expect(one("START TRANSACTION", "mysql").kind).toBe("tx");
    expect(one("CREATE TABLE t (a int)").kind).toBe("other");
    expect(one("SHOW TABLES", "mysql").isQuery).toBe(true);
    expect(one("INSERT INTO t VALUES (1) RETURNING id").isQuery).toBe(true);
  });

  it("detects top-level LIMIT only", () => {
    expect(one("SELECT * FROM t LIMIT 10").hasTopLevelLimit).toBe(true);
    const sub = one("SELECT * FROM (SELECT * FROM t LIMIT 5) s");
    expect(sub.hasTopLevelLimit).toBe(false);
    expect(sub.pageable).toBe(true);
    expect(one("SELECT * FROM t FOR UPDATE").pageable).toBe(false);
    expect(one("SELECT 'LIMIT 1' FROM t").pageable).toBe(true);
  });

  it("detects top-level WHERE only", () => {
    expect(one("DELETE FROM t").hasTopLevelWhere).toBe(false);
    expect(one("DELETE FROM t WHERE id = 1").hasTopLevelWhere).toBe(true);
    expect(one("UPDATE t SET a = (SELECT b FROM u WHERE u.id = 1)").hasTopLevelWhere).toBe(false);
    expect(one("DELETE FROM t -- WHERE id = 1").hasTopLevelWhere).toBe(false);
    expect(one("DELETE FROM t WHERE id IN (SELECT id FROM u WHERE x)").hasTopLevelWhere).toBe(true);
  });
});

describe("statementAt", () => {
  const src = "SELECT 1;\n\nSELECT 2;   \nSELECT 3";
  const stmts = splitStatements(src, "postgres");
  const at = (needle: string, delta = 0) => statementAt(stmts, src.indexOf(needle) + delta)?.text;

  it("finds the statement under the cursor", () => {
    expect(at("SELECT 2", 3)).toBe("SELECT 2");
    expect(at("SELECT 3", 8)).toBe("SELECT 3");
    expect(statementAt(stmts, 0)?.text).toBe("SELECT 1");
  });

  it("uses the previous statement in gaps and right after ';'", () => {
    expect(at(";", 1)).toBe("SELECT 1");
    expect(at("\n\nSELECT 2", 1)).toBe("SELECT 1");
    expect(at("   \nSELECT 3", 2)).toBe("SELECT 2");
  });

  it("is fast on large scripts", () => {
    const big = "SELECT a, 'x;y', \"q\" FROM t WHERE b = 1;\n".repeat(2500);
    expect(big.length).toBeGreaterThan(100_000);
    const t0 = performance.now();
    const r = splitStatements(big, "postgres");
    expect(r.length).toBe(2500);
    expect(performance.now() - t0).toBeLessThan(50);
  });
});

describe("nested DML", () => {
  it("does not page queries that modify data in a CTE", () => {
    const s = splitStatements("WITH d AS (DELETE FROM t WHERE x RETURNING *) SELECT * FROM d", "postgres")[0];
    expect(s.kind).toBe("query");
    expect(s.nestedDml).toBe(true);
    expect(s.pageable).toBe(false);
    const plain = splitStatements("SELECT * FROM t WHERE id IN (SELECT id FROM u)", "postgres")[0];
    expect(plain.nestedDml).toBe(false);
    expect(plain.pageable).toBe(true);
    // 문자열 안의 단어나 REPLACE() 함수는 무시한다
    expect(splitStatements("SELECT replace(a, 'x', 'y'), 'delete' FROM t", "mysql")[0].pageable).toBe(true);
  });
});
