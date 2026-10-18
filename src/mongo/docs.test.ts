import { describe, expect, it } from "vitest";
import { text } from "../api/types";
import { PendingChanges } from "../grid/pending";
import { parseMongoCommand } from "./console";
import { docColumns, docRows, formatOp, MISSING, mongoEditInfo, mongoOps, UNSET } from "./docs";
import type { EJson } from "./shell";

const oid = (n: number) => ({ $oid: String(n).padStart(24, "0") });
const docs: EJson[] = [
  { name: "kim", _id: oid(1), age: { $numberInt: "31" }, score: { $numberDouble: "1.5" }, tags: ["a"] },
  { _id: oid(2), name: "lee", city: null },
];

describe("doc grid", () => {
  it("unions fields with _id first and marks missing fields", () => {
    const cols = docColumns(docs);
    expect(cols).toEqual(["_id", "name", "age", "score", "tags", "city"]);
    const rows = docRows(docs, cols);
    expect(rows[0]).toEqual([text('ObjectId("000000000000000000000001")'), text('"kim"'), text("31"), text("1.5"), text('[ "a" ]'), MISSING]);
    expect(rows[1][5]).toEqual({ t: "Null" });
    expect(mongoEditInfo(cols, docs)).toHaveProperty("colMeta");
    expect(mongoEditInfo(["n"], [{ n: 1 }])).toHaveProperty("reason");
  });
});

describe("mongoOps", () => {
  const cols = docColumns(docs);
  const rows = docRows(docs, cols);

  it("builds updateOne with original values as conditions and keeps types", () => {
    const p = new PendingChanges(rows, cols.length);
    p.edit(0, 1, text("park")); // 문자열 칸: 따옴표 없이
    p.edit(0, 3, text("2")); // double 칸 → 2.0
    p.edit(0, 2, UNSET);
    p.edit(1, 5, text("서울"));
    const ops = mongoOps("users", docs, cols, p);
    expect(ops[0]).toEqual({
      kind: "updateOne",
      coll: "users",
      filter: { _id: oid(1), name: "kim", score: { $numberDouble: "1.5" }, age: { $numberInt: "31" } },
      update: { $set: { name: "park", score: { $numberDouble: "2.0" } }, $unset: { age: "" } },
      upsert: false,
    });
    expect(ops[1]).toMatchObject({ filter: { _id: oid(2), city: null }, update: { $set: { city: "서울" } } });
  });

  it("adds missing fields with $exists false, inserts and deletes", () => {
    const p = new PendingChanges(rows, cols.length);
    p.edit(1, 2, text("40"));
    p.deleteRows([0]);
    const r = p.addRow();
    p.edit(r, 1, text('"new"'));
    p.edit(r, 2, text("NumberLong(7)"));
    const ops = mongoOps("users", docs, cols, p);
    expect(ops.map((o) => o.kind)).toEqual(["deleteOne", "updateOne", "insertOne"]);
    expect(ops[1]).toMatchObject({ filter: { _id: oid(2), age: { $exists: false } }, update: { $set: { age: { $numberInt: "40" } } } });
    expect(ops[2]).toMatchObject({ doc: { name: "new", age: { $numberLong: "7" } } });
  });

  it("formats ops so the console parser reads them back", () => {
    const p = new PendingChanges(rows, cols.length);
    p.edit(0, 1, text("it's"));
    for (const op of mongoOps("my coll", docs, cols, p)) expect(parseMongoCommand(formatOp(op))).toEqual(op);
    const ins = { kind: "insertOne" as const, coll: "u", doc: { a: { $numberInt: "1" } } };
    expect(parseMongoCommand(formatOp(ins))).toEqual(ins);
  });
});
