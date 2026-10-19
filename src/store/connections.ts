import { create } from "zustand";
import { api, errorMessage } from "../api";
import { isSql, type ConnectionConfig, type SnapshotTable } from "../api/types";
import { dirtyMessage, useTabs } from "./tabs";
import { confirmDialog, toast } from "./ui";

export type MongoTopology = "standalone" | "replicaset" | "sharded";

export type ConnStatus = "idle" | "connecting" | "connected" | "error";

interface ConnState {
  configs: ConnectionConfig[];
  status: Record<string, ConnStatus>;
  defaultSchema: Record<string, string>;
  /** 자동완성용 스키마 스냅샷 */
  snapshot: Record<string, SnapshotTable[]>;
  /** MongoDB 토폴로지 (standalone이면 트랜잭션 없음) */
  topology: Record<string, MongoTopology | null>;
  load: () => Promise<void>;
  /** 저장한다. 연결 중이면 새 설정으로 다시 연결한다 (미커밋·보류 변경이 있으면 먼저 묻는다). 취소하면 false */
  save: (cfg: ConnectionConfig, password: string | null) => Promise<boolean>;
  remove: (id: string) => Promise<void>;
  /** 사이드바 순서를 바꾼다. 화면에 먼저 반영하고, 저장에 실패하면 다시 불러온다 */
  reorder: (ids: string[]) => Promise<void>;
  connect: (id: string) => Promise<boolean>;
  disconnect: (id: string) => Promise<void>;
  refreshSnapshot: (id: string) => Promise<void>;
}

export const useConnections = create<ConnState>((set, get) => ({
  configs: [],
  status: {},
  defaultSchema: {},
  snapshot: {},
  topology: {},

  load: async () => set({ configs: await api.listConnections() }),

  save: async (cfg, password) => {
    const connected = get().status[cfg.id] === "connected";
    if (connected && !(await confirmLeave(cfg.id, "새 설정으로 다시 연결합니다."))) return false;
    await api.saveConnection(cfg, password);
    await get().load();
    if (connected) {
      // 백엔드는 연결할 때의 설정(읽기 전용, 호스트, SSL 등)을 그대로 쓰므로 다시 연결해야 반영된다
      await get().disconnect(cfg.id);
      await get().connect(cfg.id);
    }
    return true;
  },

  remove: async (id) => {
    await api.deleteConnection(id);
    set((s) => {
      const status = { ...s.status };
      delete status[id];
      return { status };
    });
    await get().load();
  },

  reorder: async (ids) => {
    const byId = new Map(get().configs.map((c) => [c.id, c]));
    set({ configs: ids.flatMap((id) => byId.get(id) ?? []) });
    try {
      await api.reorderConnections(ids);
    } catch (e) {
      toast(`순서 저장 실패: ${errorMessage(e)}`, "error");
      await get().load();
    }
  },

  connect: async (id) => {
    const st = get().status[id];
    if (st === "connected") return true;
    if (st === "connecting") return false;
    set((s) => ({ status: { ...s.status, [id]: "connecting" } }));
    try {
      const info = await api.connect(id);
      set((s) => ({
        status: { ...s.status, [id]: "connected" },
        defaultSchema: { ...s.defaultSchema, [id]: info.default_schema },
        topology: { ...s.topology, [id]: info.topology ?? null },
      }));
      const cfg = get().configs.find((c) => c.id === id);
      if (cfg && isSql(cfg.driver)) void get().refreshSnapshot(id);
      return true;
    } catch (e) {
      set((s) => ({ status: { ...s.status, [id]: "error" } }));
      toast(`접속 실패: ${errorMessage(e)}`, "error");
      return false;
    }
  },

  disconnect: async (id) => {
    await api.disconnect(id);
    set((s) => ({ status: { ...s.status, [id]: "idle" } }));
  },

  refreshSnapshot: async (id) => {
    try {
      const snap = await api.schemaSnapshot(id);
      set((s) => ({ snapshot: { ...s.snapshot, [id]: snap } }));
    } catch (e) {
      toast(`스키마 정보를 불러오지 못했습니다: ${errorMessage(e)}`, "error");
    }
  },
}));


/** 이 접속의 탭에 미커밋 트랜잭션이나 제출하지 않은 변경이 있으면 한 번에 묻는다. 진행해도 되면 true */
export async function confirmLeave(connId: string, action: string): Promise<boolean> {
  const { tabs, dirty } = useTabs.getState();
  const lines = tabs
    .filter((t) => t.connId === connId)
    .map((t) => [t.title, dirtyMessage(dirty[t.id])] as const)
    .filter(([, m]) => m)
    .map(([title, m]) => `• ${title}: ${m!.replaceAll("\n", " ")}`);
  if (!lines.length) return true;
  return confirmDialog({
    title: "연결 정리",
    body: `${action}\n다음 탭의 미커밋 트랜잭션은 롤백되고 제출하지 않은 변경은 버려집니다.\n\n${lines.join("\n")}`,
    okLabel: "계속",
    danger: true,
  });
}
