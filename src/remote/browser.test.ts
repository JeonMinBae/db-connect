import { describe, expect, it } from "vitest";
import { dragNames, History, isInside, mtimeText, parseMode, permText, sizeText, sortEntries, visibleEntries } from "./browser";

const e = (name: string, dir = false, size = 0, mtime: number | null = null) => ({ name, dir, size, mtime, perm: null });

describe("sortEntries", () => {
  it("폴더가 항상 먼저, 이름은 숫자 인식 정렬", () => {
    const out = sortEntries([e("file10"), e("b", true), e("file2"), e("A", true)], "name", true);
    expect(out.map((x) => x.name)).toEqual(["A", "b", "file2", "file10"]);
  });
  it("크기 내림차순이어도 폴더는 위, 같은 크기는 이름순", () => {
    const out = sortEntries([e("x", false, 5), e("d", true), e("b", false, 9), e("a", false, 5)], "size", false);
    expect(out.map((x) => x.name)).toEqual(["d", "b", "a", "x"]);
  });
});

describe("sortEntries perm", () => {
  const p = (name: string, perm: number | null, dir = false) => ({ ...e(name, dir), perm });
  it("perm 오름차순은 null 이 먼저, 폴더는 위, 동률은 이름순", () => {
    const list = [p("b", 0o644), p("a", 0o755), p("n", null), p("d", 0o600, true), p("c", 0o644)];
    expect(sortEntries(list, "perm", true).map((x) => x.name)).toEqual(["d", "n", "b", "c", "a"]);
    expect(sortEntries(list, "perm", false).map((x) => x.name)).toEqual(["d", "a", "b", "c", "n"]);
  });
});

describe("dragNames", () => {
  it("선택된 행을 끌면 선택 전체, 아니면 Ctrl 은 더하고 일반은 그 행만", () => {
    expect(dragNames(["a", "b"], "a", false)).toEqual(["a", "b"]);
    expect(dragNames(["a", "b"], "c", true)).toEqual(["a", "b", "c"]);
    expect(dragNames(["a", "b"], "c", false)).toEqual(["c"]);
  });
});

describe("visibleEntries", () => {
  it("숨김 파일은 토글로, 필터는 대소문자 무시", () => {
    const list = [e(".env"), e("App.ts"), e("app.css")];
    expect(visibleEntries(list, { showHidden: false, filter: "" }).map((x) => x.name)).toEqual(["App.ts", "app.css"]);
    expect(visibleEntries(list, { showHidden: true, filter: "APP" }).map((x) => x.name)).toEqual(["App.ts", "app.css"]);
  });
});

describe("History", () => {
  it("back 은 이전 경로, up 은 부모로 이동하며 기록에 쌓인다", () => {
    const h = new History("/");
    h.push("/a");
    h.push("/a/b");
    expect(h.back()).toBe("/a");
    expect(h.up()).toBe("/");
    expect(h.back()).toBe("/a");
    expect(new History("/").back()).toBeNull();
    expect(new History("/").up()).toBeNull();
  });
});

describe("표시 형식", () => {
  it("크기·권한·수정일", () => {
    expect(sizeText(512)).toBe("512 B");
    expect(sizeText(1536)).toBe("1.5 KB");
    expect(sizeText(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(permText(0o755)).toBe("rwxr-xr-x");
    expect(permText(null)).toBe("");
    expect(mtimeText(null)).toBe("");
    expect(mtimeText(new Date(2026, 0, 2, 3, 4).getTime())).toBe("2026-01-02 03:04");
  });
});

describe("parseMode / isInside", () => {
  it("8진수 3~4자리만 허용", () => {
    expect(parseMode("755")).toBe(0o755);
    expect(parseMode("0644")).toBe(0o644);
    expect(parseMode("8")).toBeNull();
    expect(parseMode("rwx")).toBeNull();
    expect(parseMode("77777")).toBeNull();
  });
  it("접두어가 같은 형제 폴더는 하위가 아니다", () => {
    expect(isInside("/a/b", "/a")).toBe(true);
    expect(isInside("/a", "/a")).toBe(true);
    expect(isInside("/ab", "/a")).toBe(false);
  });
});
