import { create } from "zustand";
import { api } from "../api";
import { confirmDialog } from "./ui";

export type Tab =
  | { kind: "console"; id: string; connId: string; title: string }
  | { kind: "table"; id: string; connId: string; schema: string; table: string; title: string }
  /** key: 텍스트 키 이름, 바이너리 키는 redis-cli 이스케이프 표기 (binary: true) */
  | { kind: "redisKey"; id: string; connId: string; db: number; key: string; binary?: boolean; title: string }
  | { kind: "mongoColl"; id: string; connId: string; db: string; coll: string; title: string };

/** 닫기 전에 확인이 필요한 이유의 출처. 출처별로 따로 저장해 서로 덮어쓰지 않는다. */
export type DirtySource = "tx" | "edit";
export type DirtyReasons = Partial<Record<DirtySource, string>>;

interface TabsState {
  tabs: Tab[];
  activeId: string | null;
  dirty: Record<string, DirtyReasons>;
  restored: boolean;
  restore: () => Promise<void>;
  activate: (id: string) => void;
  openConsole: (connId: string, connName: string, forceNew?: boolean) => void;
  openTable: (connId: string, schema: string, table: string) => void;
  openRedisKey: (connId: string, db: number, key: string, binary?: boolean) => void;
  openMongoColl: (connId: string, db: string, coll: string) => void;
  renameRedisKey: (connId: string, db: number, key: string, newKey: string | null) => void;
  /** 확인 후 닫는다. 닫았으면 true */
  close: (id: string) => Promise<boolean>;
  closeMany: (ids: string[]) => Promise<void>;
  closeForConnection: (connId: string) => void;
  next: (dir: 1 | -1) => void;
  setDirty: (id: string, source: DirtySource, reason: string | null) => void;
}

const newId = () => crypto.randomUUID().replace(/-/g, "").slice(0, 16);

let saveTimer: ReturnType<typeof setTimeout> | undefined;
const persist = (s: Pick<TabsState, "tabs" | "activeId">) => {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => void api.saveWorkspace({ tabs: s.tabs, activeId: s.activeId }), 300);
};

/** 탭 하나의 확인 문구 (없으면 null) */
export const dirtyMessage = (r: DirtyReasons | undefined) => {
  const parts = [r?.tx, r?.edit].filter(Boolean);
  return parts.length ? parts.join("\n") : null;
};

export const useTabs = create<TabsState>((set, get) => {
  /** 탭을 목록과 dirty 상태에서 지운다 (확인 없음) */
  const removeTabs = (ids: string[]) => {
    set((s) => {
      const gone = new Set(ids);
      const idx = s.tabs.findIndex((t) => t.id === s.activeId);
      const tabs = s.tabs.filter((t) => !gone.has(t.id));
      const activeId = s.activeId && !gone.has(s.activeId) ? s.activeId : (tabs[Math.min(Math.max(idx, 0), tabs.length - 1)]?.id ?? null);
      const dirty = { ...s.dirty };
      for (const id of ids) delete dirty[id];
      return { tabs, activeId, dirty };
    });
    persist(get());
  };

  return {
    tabs: [],
    activeId: null,
    dirty: {},
    restored: false,

    restore: async () => {
      try {
        const ws = (await api.loadWorkspace()) as { tabs?: Tab[]; activeId?: string | null } | null;
        if (ws?.tabs?.length) set({ tabs: ws.tabs, activeId: ws.activeId ?? ws.tabs[0].id });
      } finally {
        set({ restored: true });
      }
    },

    activate: (id) => {
      if (get().activeId === id) return;
      set({ activeId: id });
      persist(get());
    },

    openConsole: (connId, connName, forceNew) => {
      const existing = !forceNew && get().tabs.find((t) => t.kind === "console" && t.connId === connId);
      if (existing) return get().activate(existing.id);
      const n = get().tabs.filter((t) => t.kind === "console" && t.connId === connId).length;
      const tab: Tab = { kind: "console", id: newId(), connId, title: n ? `${connName} (${n + 1})` : connName };
      set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
      persist(get());
    },

    openTable: (connId, schema, table) => {
      const existing = get().tabs.find((t) => t.kind === "table" && t.connId === connId && t.schema === schema && t.table === table);
      if (existing) return get().activate(existing.id);
      const tab: Tab = { kind: "table", id: newId(), connId, schema, table, title: table };
      set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
      persist(get());
    },

    openRedisKey: (connId, db, key, binary) => {
      const existing = get().tabs.find((t) => t.kind === "redisKey" && t.connId === connId && t.db === db && t.key === key);
      if (existing) return get().activate(existing.id);
      const tab: Tab = { kind: "redisKey", id: newId(), connId, db, key, binary, title: key.length > 40 ? key.slice(0, 39) + "…" : key };
      set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
      persist(get());
    },

    openMongoColl: (connId, db, coll) => {
      const existing = get().tabs.find((t) => t.kind === "mongoColl" && t.connId === connId && t.db === db && t.coll === coll);
      if (existing) return get().activate(existing.id);
      const tab: Tab = { kind: "mongoColl", id: newId(), connId, db, coll, title: coll };
      set((s) => ({ tabs: [...s.tabs, tab], activeId: tab.id }));
      persist(get());
    },

    /** 이름이 바뀌거나 지워진 Redis 키의 탭을 고친다 (newKey가 null이면 닫는다) */
    renameRedisKey: (connId, db, key, newKey) => {
      const tab = get().tabs.find((t) => t.kind === "redisKey" && t.connId === connId && t.db === db && t.key === key);
      if (!tab) return;
      if (newKey === null) return removeTabs([tab.id]);
      set((s) => ({ tabs: s.tabs.map((t) => (t.id === tab.id ? { ...t, key: newKey, title: newKey } : t)) }));
      persist(get());
    },

    close: async (id) => {
      const msg = dirtyMessage(get().dirty[id]);
      if (msg && !(await confirmDialog({ title: "탭 닫기", body: `${msg}\n그래도 닫을까요?`, okLabel: "닫기", danger: true }))) return false;
      const tab = get().tabs.find((t) => t.id === id);
      removeTabs([id]);
      if (tab?.kind === "console") void api.deleteConsole(tab.connId, tab.id);
      return true;
    },

    // 확인 대화상자는 하나씩만 띄울 수 있으므로 차례로 닫는다
    closeMany: async (ids) => {
      for (const id of ids) await get().close(id);
    },

    closeForConnection: (connId) => removeTabs(get().tabs.filter((t) => t.connId === connId).map((t) => t.id)),

    next: (dir) => {
      const { tabs, activeId } = get();
      if (!tabs.length) return;
      const idx = tabs.findIndex((t) => t.id === activeId);
      get().activate(tabs[(idx + dir + tabs.length) % tabs.length].id);
    },

    setDirty: (id, source, reason) => {
      const cur = get().dirty[id]?.[source] ?? null;
      if (cur === reason) return; // 같은 값이면 구독자를 깨우지 않는다
      set((s) => {
        const entry = { ...s.dirty[id] };
        if (reason) entry[source] = reason;
        else delete entry[source];
        const dirty = { ...s.dirty };
        if (Object.keys(entry).length) dirty[id] = entry;
        else delete dirty[id];
        return { dirty };
      });
    },
  };
});
