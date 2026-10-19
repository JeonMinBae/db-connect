import { listen } from "@tauri-apps/api/event";
import { create } from "zustand";
import { api, errorMessage, type TransferConflict, type TransferDone, type TransferJob, type TransferProgress } from "../api";
import { useTabs } from "../store/tabs";

export type TransferStatus = "queued" | "running" | "done" | "failed" | "canceled";

export interface TransferItem {
  /** 백엔드에는 job_id 로 쓴다 */
  id: string;
  tabId: string;
  connId: string;
  label: string;
  job: TransferJob;
  status: TransferStatus;
  doneBytes: number;
  totalBytes: number;
  doneFiles: number;
  totalFiles: number;
  error?: string;
  summary?: TransferDone;
}

/** 탭당 동시에 돌리는 전송 수 */
const LIMIT = 2;

/** 등록 순서대로, 탭의 running 이 limit 미만인 만큼만 */
export function nextToStart(items: TransferItem[], tabId: string, limit = LIMIT): TransferItem[] {
  const mine = items.filter((i) => i.tabId === tabId);
  const free = limit - mine.filter((i) => i.status === "running").length;
  return free > 0 ? mine.filter((i) => i.status === "queued").slice(0, free) : [];
}

interface TransfersState {
  items: TransferItem[];
  /** 사용자 응답을 기다리는 충돌 질문 (앞에서부터 하나씩 보여준다) */
  asks: TransferConflict[];
  enqueue: (tabId: string, connId: string, label: string, job: TransferJob) => void;
  cancel: (id: string) => void;
  retry: (id: string, opts?: { start?: boolean }) => void;
  clearDone: (tabId: string) => void;
  /** 항목을 없애고 실행 중이면 중지, 선택 토큰은 해제 */
  removeItems: (ids: string[]) => void;
  answer: (ask: TransferConflict, choice: "overwrite" | "skip" | "rename", all: boolean) => void;
  pump: (tabId: string) => void;
}

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

/** 사용자가 중지한 job. 백엔드 오류와 구분해 canceled 로 표시한다 */
const canceledByUser = new Set<string>();

const doneListeners = new Map<string, Set<(it: TransferItem) => void>>();

/** 해당 탭의 전송이 끝났을 때(성공·실패·취소 모두) 호출된다. 업로드는 일부만 올라갔을 수도 있어 실패해도 알린다. */
export function subscribeDone(tabId: string, cb: (it: TransferItem) => void): () => void {
  let s = doneListeners.get(tabId);
  if (!s) doneListeners.set(tabId, (s = new Set()));
  const set = s;
  set.add(cb);
  return () => void set.delete(cb);
}

export const useTransfers = create<TransfersState>((set, get) => {
  const patch = (id: string, p: Partial<TransferItem>) => set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...p } : i)) }));

  const finish = (id: string, p: Partial<TransferItem>) => {
    const it = get().items.find((i) => i.id === id);
    if (!it) return; // 그 사이 지워진 항목
    canceledByUser.delete(id);
    set((s) => ({ items: s.items.map((i) => (i.id === id ? { ...i, ...p } : i)), asks: s.asks.filter((a) => a.job_id !== id) }));
    const after = get().items.find((i) => i.id === id)!;
    doneListeners.get(it.tabId)?.forEach((cb) => cb(after));
    get().pump(it.tabId);
  };

  return {
    items: [],
    asks: [],
    enqueue: (tabId, connId, label, job) => {
      const it: TransferItem = { id: newId(), tabId, connId, label, job, status: "queued", doneBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: 0 };
      set((s) => ({ items: [...s.items, it] }));
      get().pump(tabId);
    },
    pump: (tabId) => {
      for (const it of nextToStart(get().items, tabId)) {
        patch(it.id, { status: "running" });
        api.transferStart(it.connId, it.id, it.job).then(
          (summary) => finish(it.id, { status: "done", summary }),
          (e) => (canceledByUser.has(it.id) ? finish(it.id, { status: "canceled" }) : finish(it.id, { status: "failed", error: errorMessage(e) })),
        );
      }
    },
    cancel: (id) => {
      const it = get().items.find((i) => i.id === id);
      if (!it) return;
      if (it.status === "queued") patch(id, { status: "canceled" });
      else if (it.status === "running") {
        canceledByUser.add(id);
        set((s) => ({ asks: s.asks.filter((a) => a.job_id !== id) }));
        void api.cancelQuery(id).catch(() => {});
      }
    },
    retry: (id, opts) => {
      const it = get().items.find((i) => i.id === id);
      if (!it || (it.status !== "failed" && it.status !== "canceled")) return;
      patch(id, { status: "queued", doneBytes: 0, totalBytes: 0, doneFiles: 0, totalFiles: 0, error: undefined, summary: undefined });
      if (opts?.start !== false) get().pump(it.tabId);
    },
    clearDone: (tabId) =>
      get().removeItems(
        get()
          .items.filter((i) => i.tabId === tabId && i.status === "done")
          .map((i) => i.id),
      ),
    removeItems: (ids) => {
      const gone = get().items.filter((i) => ids.includes(i.id));
      if (!gone.length) return;
      for (const it of gone) {
        if (it.status === "running") {
          canceledByUser.add(it.id);
          void api.cancelQuery(it.id).catch(() => {});
        }
        // 끝난 항목은 retry 에 pick 이 필요하므로 지울 때만 해제한다
        void api.pickRelease(it.job.pick_id).catch(() => {});
      }
      set((s) => ({ items: s.items.filter((i) => !ids.includes(i.id)), asks: s.asks.filter((a) => !ids.includes(a.job_id)) }));
    },
    answer: (ask, choice, all) => {
      set((s) => ({ asks: s.asks.filter((a) => a.ask_id !== ask.ask_id) }));
      void api.transferAnswer(ask.ask_id, { choice, all }).catch(() => {});
    },
  };
});

/** 앱 전체에서 한 번만 설치한다. 해제 함수를 돌려준다. */
export function installTransferListeners(): () => void {
  const un = [
    listen<TransferProgress>("transfer-progress", (ev) => {
      const p = ev.payload;
      useTransfers.setState((s) => ({
        items: s.items.map((i) => (i.id === p.job_id && i.status === "running" ? { ...i, doneBytes: p.done_bytes, totalBytes: p.total_bytes, doneFiles: p.done_files, totalFiles: p.total_files } : i)),
      }));
    }),
    listen<TransferConflict>("transfer-conflict", (ev) => {
      useTransfers.setState((s) => ({ asks: [...s.asks, ev.payload] }));
    }),
  ];
  // 탭이 닫히면 그 탭의 전송을 정리한다
  let known = new Set(useTabs.getState().tabs.map((t) => t.id));
  const unTabs = useTabs.subscribe((s) => {
    const now = new Set(s.tabs.map((t) => t.id));
    const closed = [...known].filter((id) => !now.has(id));
    known = now;
    if (!closed.length) return;
    const st = useTransfers.getState();
    st.removeItems(st.items.filter((i) => closed.includes(i.tabId)).map((i) => i.id));
    for (const id of closed) doneListeners.delete(id);
  });
  return () => {
    unTabs();
    un.forEach((p) => void p.then((f) => f()));
  };
}
