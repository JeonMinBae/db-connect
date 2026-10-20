import { describe, expect, it } from "vitest";
import { baseName, isUnder, join, normalize, parent } from "./path";

describe("remote path", () => {
  it("정규화", () => {
    expect(normalize("")).toBe("/");
    expect(normalize("a//b/./c/")).toBe("/a/b/c");
    expect(normalize("/a/../../b")).toBe("/b");
  });
  it("join / parent / baseName", () => {
    expect(join("/a", "b c")).toBe("/a/b c");
    expect(join("/", "x")).toBe("/x");
    expect(parent("/a/b")).toBe("/a");
    expect(parent("/")).toBe("/");
    expect(baseName("/a/b.txt")).toBe("b.txt");
  });
});

describe("isUnder", () => {
  it("자신·하위는 true, 이름이 앞부분만 같은 형제는 false", () => {
    expect(isUnder("/a/b", "/a/b")).toBe(true);
    expect(isUnder("/a/b/c", "/a/b/")).toBe(true);
    expect(isUnder("/a/bc", "/a/b")).toBe(false);
    expect(isUnder("/x", "/")).toBe(true);
    expect(isUnder("/a", "/a/b")).toBe(false);
  });
});
