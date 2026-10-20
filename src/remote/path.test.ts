import { describe, expect, it } from "vitest";
import { baseName, join, normalize, parent } from "./path";

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
