import { describe, expect, it, vi } from "vitest";
import { routeDrop, type DropHandler } from "./drops";

const ev = { pick: { pick_id: "p1", names: ["a.txt"] }, x: 200, y: 100 };

describe("os-drop 라우팅", () => {
  it("처리한 핸들러가 있으면 해제하지 않는다", () => {
    const no: DropHandler = () => false;
    const yes = vi.fn<DropHandler>(() => true);
    const release = vi.fn();
    expect(routeDrop(ev, [no, yes], release)).toBe(true);
    expect(yes).toHaveBeenCalledWith(ev.pick, 200, 100);
    expect(release).not.toHaveBeenCalled();
  });
  it("아무도 받지 않으면 해제한다", () => {
    const release = vi.fn();
    expect(routeDrop(ev, [() => false], release)).toBe(false);
    expect(release).toHaveBeenCalledWith("p1");
  });
  it("핸들러가 없어도 해제한다", () => {
    const release = vi.fn();
    routeDrop(ev, [], release);
    expect(release).toHaveBeenCalledWith("p1");
  });
});
