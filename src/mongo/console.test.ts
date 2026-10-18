import { describe, expect, it } from "vitest";
import { parseMongoCommand, riskyOp, splitMongo, statementAtPos } from "./console";

const i = (n: number) => ({ $numberInt: String(n) });

describe("parseMongoCommand", () => {
  it("parses find with chains in any order", () => {
    expect(parseMongoCommand(`db.users.find({ age: { $gt: 30 } }, { name: 1 }).limit(10).sort({ age: -1 }).skip(5);`)).toEqual({
      kind: "find",
      coll: "users",
      filter: { age: { $gt: i(30) } },
      projection: { name: i(1) },
      sort: { age: i(-1) },
      skip: 5,
      limit: 10,
    });
    expect(parseMongoCommand(`db.getCollection("a-b").findOne()`)).toMatchObject({ kind: "find", coll: "a-b", limit: 1 });
    expect(parseMongoCommand(`db.system.profile.find()`)).toMatchObject({ coll: "system.profile" });
  });

  it("parses aggregate, writes, runCommand, show and use", () => {
    expect(parseMongoCommand(`db.o.aggregate([{ $match: { s: "a;b)" } }, { $count: "n" }])`)).toEqual({
      kind: "aggregate",
      coll: "o",
      pipeline: [{ $match: { s: "a;b)" } }, { $count: "n" }],
    });
    expect(parseMongoCommand(`db.o.updateMany({}, { $set: { x: 1 } }, { upsert: true })`)).toMatchObject({ kind: "updateMany", upsert: true });
    expect(parseMongoCommand(`db.o.deleteOne({ _id: ObjectId("65f0a1b2c3d4e5f601234567") })`)).toEqual({
      kind: "deleteOne",
      coll: "o",
      filter: { _id: { $oid: "65f0a1b2c3d4e5f601234567" } },
    });
    expect(parseMongoCommand(`db.runCommand({ ping: 1 })`)).toEqual({ kind: "runCommand", command: { ping: i(1) } });
    expect(parseMongoCommand("show dbs")).toEqual({ kind: "showDbs" });
    expect(parseMongoCommand("use shop;")).toEqual({ kind: "use", db: "shop" });
    expect(parseMongoCommand(`db.o.distinct("city", { a: 1 })`)).toMatchObject({ kind: "distinct", field: "city" });
  });

  it("rejects unsupported syntax", () => {
    expect(() => parseMongoCommand("var x = 1")).toThrow();
    expect(() => parseMongoCommand("db.o.find().forEach(printjson)")).toThrow(/지원하지 않는/);
    expect(() => parseMongoCommand("db.o.drop()")).toThrow(/지원하지 않는 메서드/);
    expect(() => parseMongoCommand("db.o.aggregate([]).limit(1)")).toThrow(/체인/);
  });

  it("flags risky operations", () => {
    expect(riskyOp(parseMongoCommand("db.o.deleteMany({})"))).toMatch(/모든 문서/);
    expect(riskyOp(parseMongoCommand("db.o.deleteMany({ a: 1 })"))).toBeNull();
    expect(riskyOp(parseMongoCommand("db.runCommand({ drop: 'o' })"))).toMatch(/drop/);
  });
});

describe("splitMongo", () => {
  it("splits on db/show/use line starts and semicolons", () => {
    const src = "db.a.find({\n  x: 1\n});\n\n// note\nshow dbs\ndb.b.find(); db.c.find()\n";
    const s = splitMongo(src);
    expect(s.map((x) => x.text)).toEqual(["db.a.find({\n  x: 1\n})", "show dbs", "db.b.find()", "db.c.find()"]);
    expect(statementAtPos(s, src.indexOf("x: 1"))!.text).toContain("db.a");
    expect(statementAtPos(s, src.indexOf("db.c"))!.text).toBe("db.c.find()");
  });
});
