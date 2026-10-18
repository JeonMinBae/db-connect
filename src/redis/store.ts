import { create } from "zustand";
import { api, errorMessage } from "../api";
import { toast } from "../store/ui";
import { keyId } from "./bytes";
import type { ScanKey } from "./keys";

/** 트리가 한 번에 받는 키 수 */
export const SCAN_BATCH = 500;

export interface DbScan {
  keys: ScanKey[];
  /** 다음 SCAN 커서 ("0"이면 끝까지 받음) */
  cursor: string;
  pattern: string;
  loading: boolean;
  done: boolean;
}

const scanKey = (connId: string, db: number) => `${connId}|${db}`;

interface RedisTreeState {
  dbs: Record<string, { db: number; keys: number }[] | "loading">;
  scans: Record<string, DbScan>;
  loadDbs: (connId: string, force?: boolean) => Promise<void>;
  /** reset이면 커서 0부터(패턴 변경·새로고침), 아니면 이어서 SCAN_BATCH개 더 */
  scan: (connId: string, db: number, opts?: { reset?: boolean; pattern?: string }) => Promise<void>;
  scanOf: (connId: string, db: number) => DbScan | undefined;
  /** 받은 목록에서 키를 지우거나 이름을 바꾼다 (탭에서 삭제·이름 변경 후) */
  patchKey: (connId: string, db: number, id: string, next: ScanKey | null) => void;
  invalidate: (connId: string) => void;
}

export const useRedisTree = create<RedisTreeState>((set, get) => ({
  dbs: {},
  scans: {},

  loadDbs: async (connId, force) => {
    if (!force && get().dbs[connId]) return;
    set((s) => ({ dbs: { ...s.dbs, [connId]: "loading" } }));
    try {
      const list = await api.redisDbs(connId);
      set((s) => ({ dbs: { ...s.dbs, [connId]: list } }));
    } catch (e) {
      set((s) => {
        const dbs = { ...s.dbs };
        delete dbs[connId];
        return { dbs };
      });
      toast(errorMessage(e), "error");
    }
  },

  scanOf: (connId, db) => get().scans[scanKey(connId, db)],

  scan: async (connId, db, opts) => {
    const k = scanKey(connId, db);
    const prev = get().scans[k];
    if (prev?.loading) return;
    const reset = opts?.reset || !prev;
    const pattern = opts?.pattern ?? prev?.pattern ?? "";
    const base: DbScan = reset ? { keys: [], cursor: "0", pattern, loading: true, done: false } : { ...prev!, loading: true };
    set((s) => ({ scans: { ...s.scans, [k]: base } }));
    try {
      const page = await api.redisScan(connId, db, base.cursor, pattern, SCAN_BATCH);
      // SCAN은 같은 키를 두 번 줄 수 있다
      const seen = new Set(base.keys.map((x) => keyId(x.name)));
      const fresh = page.keys.filter((x) => !seen.has(keyId(x.name)));
      set((s) => ({ scans: { ...s.scans, [k]: { keys: [...base.keys, ...fresh], cursor: page.cursor, pattern, loading: false, done: page.cursor === "0" } } }));
    } catch (e) {
      set((s) => ({ scans: { ...s.scans, [k]: { ...base, loading: false } } }));
      toast(errorMessage(e), "error");
    }
  },

  patchKey: (connId, db, id, next) => {
    const k = scanKey(connId, db);
    const cur = get().scans[k];
    if (!cur) return;
    const keys = cur.keys.filter((x) => keyId(x.name) !== id);
    if (next) keys.push(next);
    set((s) => ({ scans: { ...s.scans, [k]: { ...cur, keys } } }));
  },

  invalidate: (connId) =>
    set((s) => {
      const dbs = { ...s.dbs };
      delete dbs[connId];
      const scans = Object.fromEntries(Object.entries(s.scans).filter(([k]) => !k.startsWith(connId + "|")));
      return { dbs, scans };
    }),
}));
