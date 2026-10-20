import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("../api", () => ({
  api: { pickRelease: vi.fn(() => Promise.resolve()), cancelQuery: vi.fn(() => Promise.resolve(true)), transferStart: vi.fn(), transferAnswer: vi.fn() },
  errorMessage: (e: unknown) => String(e),
}));
vi.mock("@tauri-apps/api/event", () => ({ listen: vi.fn(() => Promise.resolve(() => {})) }));

import { api } from "../api";
import { nextToStart, useTransfers, type TransferItem } from "./transfers";

const item = (id: string, tabId: string, status: TransferItem["status"]) => ({ id, tabId, status }) as TransferItem;

describe("nextToStart", () => {
  it("탭마다 running 이 2개 미만일 때만 등록 순서대로 시작한다", () => {
    const items = [item("1", "t", "running"), item("2", "t", "queued"), item("3", "t", "queued"), item("4", "u", "queued")];
    expect(nextToStart(items, "t").map((i) => i.id)).toEqual(["2"]);
    expect(nextToStart(items, "u").map((i) => i.id)).toEqual(["4"]);
    expect(nextToStart([item("1", "t", "running"), item("2", "t", "running"), item("3", "t", "queued")], "t")).toEqual([]);
  });
});

describe("retry", () => {
  it("실패 항목은 진행값을 비우고 같은 job 으로 다시 대기열에 들어간다", () => {
    useTransfers.setState({ items: [{ ...item("1", "t", "failed"), doneBytes: 50, error: "x", job: { kind: "upload", pick_id: "p", dest_dir: "/" } } as TransferItem] });
    useTransfers.getState().retry("1", { start: false });
    const it = useTransfers.getState().items[0];
    expect([it.status, it.doneBytes, it.error, it.job]).toEqual(["queued", 0, undefined, { kind: "upload", pick_id: "p", dest_dir: "/" }]);
  });
});

describe("큐", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    useTransfers.setState({ items: [], asks: [] });
  });
  const job = (p: string) => ({ kind: "upload" as const, pick_id: p, dest_dir: "/" });

  it("3개를 등록하면 2개만 시작한다", () => {
    vi.mocked(api.transferStart).mockReturnValue(new Promise(() => {}));
    for (const p of ["a", "b", "c"]) useTransfers.getState().enqueue("t", "c1", p, job(p));
    expect(useTransfers.getState().items.map((i) => i.status)).toEqual(["running", "running", "queued"]);
    expect(api.transferStart).toHaveBeenCalledTimes(2);
  });

  it("항목을 지우면 실행 중이면 중지하고 pick 을 해제한다", () => {
    useTransfers.setState({
      items: [
        { ...item("1", "t", "running"), job: job("p1") },
        { ...item("2", "t", "done"), job: job("p2") },
        { ...item("3", "u", "queued"), job: job("p3") },
      ] as TransferItem[],
    });
    useTransfers.getState().removeItems(["1", "2"]);
    expect(api.cancelQuery).toHaveBeenCalledWith("1");
    expect(vi.mocked(api.pickRelease).mock.calls.map((c) => c[0])).toEqual(["p1", "p2"]);
    expect(useTransfers.getState().items.map((i) => i.id)).toEqual(["3"]);
  });

  it("사용자가 중지하면 canceled 로 표시한다", async () => {
    let rej!: (e: unknown) => void;
    vi.mocked(api.transferStart).mockReturnValue(new Promise((_, r) => (rej = r)));
    useTransfers.getState().enqueue("t", "c1", "x", job("p"));
    useTransfers.getState().cancel(useTransfers.getState().items[0].id);
    rej("사용자가 중지했습니다.");
    await new Promise((r) => setTimeout(r, 0));
    expect(useTransfers.getState().items[0].status).toBe("canceled");
  });
});
