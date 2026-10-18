import { describe, expect, it } from "vitest";
import { argOf, toHex, unescapeRedis } from "./bytes";
import { buildKeyTree, sortedChildren, type ScanKey } from "./keys";

const k = (v: string, type = "string"): ScanKey => ({ name: { t: "Text", v }, type });

describe("buildKeyTree", () => {
  it("groups keys by separator and keeps a key and a folder with the same name", () => {
    const root = buildKeyTree([k("user:1:profile", "hash"), k("user:2"), k("user"), k("plain")], ":");
    expect(root.count).toBe(4);
    const { folders, keys } = sortedChildren(root);
    expect(folders.map((f) => [f.name, f.count])).toEqual([["user", 2]]);
    expect(keys.map((x) => x.label)).toEqual(["plain", "user"]);
    const user = folders[0];
    expect(user.keys.map((x) => x.label)).toEqual(["2"]);
    expect(user.folders.get("1")!.keys[0].key.type).toBe("hash");
    expect(user.folders.get("1")!.path).toBe("user:1:");
  });

  it("supports another separator, empty segments and binary keys", () => {
    const root = buildKeyTree([k("a::b"), k("x/y"), { name: { t: "Bin", v: "\\xff:1" }, type: "string" }], "/");
    expect([...root.folders.keys()]).toEqual(["x"]);
    expect(root.keys.map((x) => x.label).sort()).toEqual(['"\\xff:1"', "a::b"]);
    const colon = buildKeyTree([k("a::b")], ":");
    expect(colon.folders.get("a")!.folders.get("")!.keys[0].label).toBe("b");
  });
});

describe("bytes", () => {
  it("round-trips redis-cli escapes", () => {
    expect(toHex(unescapeRedis('\\xff\\"\\n\\x00a'))).toBe("ff220a0061");
    expect(toHex(unescapeRedis("한"))).toBe("ed959c");
    expect(argOf({ t: "Bin", v: "\\x00\\xfe" })).toEqual({ hex: "00fe" });
    expect(argOf({ t: "Text", v: "k" })).toBe("k");
  });
});
