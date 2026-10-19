import { describe, expect, it } from "vitest";
import type { TableInfo } from "../api/types";
import { matchRanges, searchOpenKeys, type SearchData } from "./sidebar";
import { nodeKey, useTree } from "./tree";

const t = (name: string, kind = "TABLE") => ({ name, kind }) as TableInfo;
const empty: SearchData = { configs: [], schemas: {}, tables: {}, redisDbs: {}, redisScans: {}, mongoDbs: {}, mongoColls: {} };

describe("matchRanges", () => {
  it("대소문자를 무시하고 모든 일치 구간을 찾는다", () => {
    expect(matchRanges("tb_User_user", "USER")).toEqual([
      [3, 7],
      [8, 12],
    ]);
    expect(matchRanges("orders", "x")).toEqual([]);
    expect(matchRanges("orders", "")).toEqual([]);
  });
});

describe("searchOpenKeys", () => {
  it("단일 스키마는 스키마 줄 없이 접속과 tables 폴더만 펼친다", () => {
    const keys = searchOpenKeys("user", {
      ...empty,
      configs: [{ id: "c", key_separator: ":" }],
      schemas: { c: ["app"] },
      tables: { [nodeKey("c", "app")]: [t("users"), t("orders"), t("user_v", "VIEW")] },
    });
    expect(keys.sort()).toEqual(["c", nodeKey("c", "app", "#tables"), nodeKey("c", "app", "#views")].sort());
  });

  it("여러 스키마면 스키마도 펼치고, 일치 없는 스키마는 건드리지 않는다", () => {
    const keys = searchOpenKeys("ord", {
      ...empty,
      configs: [{ id: "c", key_separator: ":" }],
      schemas: { c: ["a", "b"] },
      tables: { [nodeKey("c", "a")]: [t("orders")], [nodeKey("c", "b")]: [t("users")] },
    });
    expect(keys.sort()).toEqual(["c", nodeKey("c", "a"), nodeKey("c", "a", "#tables")].sort());
  });

  it("Redis 키는 구분자 폴더 경로를 따라 펼친다", () => {
    const keys = searchOpenKeys("42", {
      ...empty,
      configs: [{ id: "r", key_separator: ":" }],
      redisDbs: { r: [{ db: 0 }] },
      redisScans: { "r|0": { keys: [{ name: { t: "Text", v: "user:session:42" }, type: "string" }] } },
    });
    const dk = nodeKey("r", "db0");
    expect(keys.sort()).toEqual(["r", dk, nodeKey(dk, "#k:user:"), nodeKey(dk, "#k:user:session:")].sort());
  });

  it("Mongo 컬렉션은 DB와 collections 폴더를 펼친다", () => {
    const keys = searchOpenKeys("log", {
      ...empty,
      configs: [{ id: "m", key_separator: ":" }],
      mongoDbs: { m: [{ name: "app" }] },
      mongoColls: { "m|app": [{ name: "logs", kind: "collection" }] },
    });
    expect(keys.sort()).toEqual(["m", nodeKey("m", "app"), nodeKey("m", "app", "#collections")].sort());
  });
});

describe("applySearchOpen", () => {
  it("자동으로 펼친 것만 되돌리고 검색 중 직접 조작한 것은 남긴다", () => {
    useTree.setState({ expanded: { a: false } });
    const { applySearchOpen, toggle } = useTree.getState();
    applySearchOpen(["a", "b", "c"]);
    expect(useTree.getState().expanded).toEqual({ a: true, b: true, c: true });
    toggle("b", false); // 직접 접음 → 다시 자동으로 펼치지 않는다
    toggle("d", true); // 직접 펼침 → 검색이 끝나도 유지
    applySearchOpen(["a", "b", "c"]);
    expect(useTree.getState().expanded.b).toBe(false);
    applySearchOpen(null);
    expect(useTree.getState().expanded).toEqual({ a: false, b: false, d: true });
  });
});
