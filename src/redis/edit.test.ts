import { describe, expect, it } from "vitest";
import { text } from "../api/types";
import { PendingChanges } from "../grid/pending";
import { formatCommand, quoteArg, riskyCommand, splitRedisArgs } from "./cli";
import { redisCommands } from "./edit";

describe("redisCommands", () => {
  it("hash: rename deletes the old field, edits and inserts use HSET", () => {
    const p = new PendingChanges([[text("a"), text("1")], [text("b"), text("2")], [text("c"), text("3")]], 2);
    p.edit(0, 0, text("a2"));
    p.edit(1, 1, text("22"));
    p.deleteRows([2]);
    const r = p.addRow();
    p.edit(r, 0, text("d"));
    p.edit(r, 1, text("4"));
    expect(redisCommands("hash", "h", p).map(formatCommand)).toEqual(["HDEL h c", "HDEL h a", "HSET h a2 1", "HSET h b 22", "HSET h d 4"]);
  });

  it("list: edits before tombstone deletes, inserts with RPUSH", () => {
    const p = new PendingChanges([[text("0"), text("x")], [text("1"), text("y")], [text("2"), text("z")]], 2);
    p.edit(2, 1, text("Z"));
    p.deleteRows([0]);
    const r = p.addRow();
    p.edit(r, 1, text("w"));
    expect(redisCommands("list", "l", p, "T").map(formatCommand)).toEqual(["LSET l 2 Z", "LSET l 0 T", "LREM l 0 T", "RPUSH l w"]);
  });

  it("zset and set", () => {
    const z = new PendingChanges([[text("m"), text("1")]], 2);
    z.edit(0, 1, text("2.5"));
    expect(redisCommands("zset", "z", z).map(formatCommand)).toEqual(["ZADD z 2.5 m"]);
    z.edit(0, 1, text("abc"));
    expect(() => redisCommands("zset", "z", z)).toThrow(/숫자/);
    const s = new PendingChanges([[text("m")]], 1);
    s.edit(0, 0, text("n o"));
    expect(redisCommands("set", "s", s).map(formatCommand)).toEqual(["SREM s m", 'SADD s "n o"']);
  });

  it("rejects NULL", () => {
    const p = new PendingChanges([[text("a"), text("1")]], 2);
    p.edit(0, 1, { t: "Null" });
    expect(() => redisCommands("hash", "h", p)).toThrow(/NULL/);
  });
});

describe("redis-cli args", () => {
  it("splits quotes and escapes", () => {
    expect(splitRedisArgs(`SET "a b" 'it\\'s' "\\x41\\n" ""`)).toEqual(["SET", "a b", "it's", "A\n", ""]);
    expect(splitRedisArgs(`GET "\\xff\\x00"`)).toEqual(["GET", { hex: "ff00" }]);
    expect(splitRedisArgs("  HGETALL   user:1  ")).toEqual(["HGETALL", "user:1"]);
    expect(() => splitRedisArgs(`GET "abc`)).toThrow(/닫히지/);
    expect(() => splitRedisArgs(`GET "a"b`)).toThrow(/공백/);
  });

  it("quotes only when needed and round-trips", () => {
    for (const a of ["plain", "a b", 'q"x', "back\\slash", "", "줄\n바꿈", { hex: "00ff" }]) {
      expect(splitRedisArgs(quoteArg(a as string))).toEqual([a]);
    }
    expect(quoteArg("plain")).toBe("plain");
  });

  it("flags risky commands", () => {
    expect(riskyCommand(["flushall"])).toMatch(/모든 DB/);
    expect(riskyCommand(["GET", "k"])).toBeNull();
  });
});

describe("renderReply", () => {
  it("matches redis-cli output", async () => {
    const { renderReply } = await import("./reply");
    expect(renderReply({ t: "Array", v: [{ t: "Bulk", v: { t: "Text", v: "a" } }, { t: "Array", v: [{ t: "Int", v: 1 }, { t: "Nil" }] }] })).toBe(
      '1) "a"\n2) 1) (integer) 1\n   2) (nil)',
    );
    expect(renderReply({ t: "Array", v: [] })).toBe("(empty array)");
    expect(renderReply({ t: "Bulk", v: { t: "Bin", v: "\\xff" } })).toBe('"\\xff"');
    expect(renderReply({ t: "Bulk", v: { t: "Text", v: 'a"\n' } })).toBe('"a\\"\\n"');
  });
});
