import { beforeEach, describe, expect, it, vi } from "vitest";
vi.mock("../api", () => ({ api: { saveWorkspace: vi.fn(), loadWorkspace: vi.fn(), deleteConsole: vi.fn() } }));
vi.mock("./ui", () => ({ confirmDialog: vi.fn(), toast: vi.fn() }));
import { api } from "../api";
import { useTabs } from "./tabs";

describe("원격 탭", () => {
  beforeEach(() => useTabs.setState({ tabs: [], activeId: null, dirty: {} }));

  it("브라우저 탭은 forceNew 면 여러 개, 아니면 기존 탭으로 이동", () => {
    const t = useTabs.getState();
    t.openBrowser("c", "srv");
    t.openBrowser("c", "srv");
    expect(useTabs.getState().tabs).toHaveLength(1);
    t.openBrowser("c", "srv", true);
    expect(useTabs.getState().tabs.map((x) => x.title)).toEqual(["srv", "srv (2)"]);
  });

  it("같은 경로의 파일 탭은 새로 열지 않고 기존 탭으로 이동", () => {
    const t = useTabs.getState();
    t.openRemoteFile("c", "/a/b.txt");
    t.openRemoteFile("c", "/a/c.txt");
    t.openRemoteFile("c", "/a/b.txt");
    const s = useTabs.getState();
    expect(s.tabs.map((x) => x.title)).toEqual(["b.txt", "c.txt"]);
    expect(s.activeId).toBe(s.tabs[0].id);
  });

  it("원격 탭은 workspace 에 저장하지 않는다", async () => {
    vi.useFakeTimers();
    useTabs.getState().openConsole("d", "db");
    useTabs.getState().openBrowser("c", "srv");
    vi.advanceTimersByTime(400);
    const saved = vi.mocked(api.saveWorkspace).mock.calls.at(-1)![0] as { tabs: { kind: string }[]; activeId: string };
    expect(saved.tabs.map((t) => t.kind)).toEqual(["console"]);
    expect(saved.activeId).toBe(useTabs.getState().tabs[0].id);
    vi.useRealTimers();
  });

  it("복원할 때 원격 탭은 건너뛴다", async () => {
    vi.mocked(api.loadWorkspace).mockResolvedValue({
      tabs: [{ kind: "remoteBrowser", id: "r", connId: "c", title: "srv" }, { kind: "console", id: "k", connId: "d", title: "db" }],
      activeId: "r",
    });
    await useTabs.getState().restore();
    expect(useTabs.getState().tabs.map((t) => t.id)).toEqual(["k"]);
    expect(useTabs.getState().activeId).toBe("k");
  });
});
