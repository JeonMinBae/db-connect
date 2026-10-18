import { create } from "zustand";
import { api, errorMessage } from "../api";
import { toast } from "../store/ui";
import type { EJson } from "./shell";

type Loaded<T> = T[] | "loading";
export type MongoColl = { name: string; kind: string; estimated: number | null };
export type MongoIndex = { name: string; keys: EJson; unique: boolean; ttl: number | null; partial: boolean };

interface MongoTreeState {
  dbs: Record<string, Loaded<{ name: string; size: number }>>;
  /** "conn|db" → 컬렉션 */
  colls: Record<string, Loaded<MongoColl>>;
  /** "conn|db|coll" → 인덱스 */
  indexes: Record<string, Loaded<MongoIndex>>;
  loadDbs: (connId: string, force?: boolean) => Promise<void>;
  loadColls: (connId: string, db: string, force?: boolean) => Promise<void>;
  loadIndexes: (connId: string, db: string, coll: string, force?: boolean) => Promise<void>;
  invalidate: (connId: string) => void;
}

/** 공통 로더: 불러오는 중 표시 → 성공 시 저장, 실패 시 지우고 알림 */
function loader<K extends "dbs" | "colls" | "indexes">(set: (f: (s: MongoTreeState) => Partial<MongoTreeState>) => void, field: K) {
  return async (key: string, fetch: () => Promise<unknown[]>) => {
    set((s) => ({ [field]: { ...s[field], [key]: "loading" } }) as Partial<MongoTreeState>);
    try {
      const list = await fetch();
      set((s) => ({ [field]: { ...s[field], [key]: list } }) as Partial<MongoTreeState>);
    } catch (e) {
      set((s) => {
        const rec = { ...s[field] };
        delete rec[key];
        return { [field]: rec } as Partial<MongoTreeState>;
      });
      toast(errorMessage(e), "error");
    }
  };
}

export const useMongoTree = create<MongoTreeState>((set, get) => {
  const loadDbs = loader(set, "dbs");
  const loadColls = loader(set, "colls");
  const loadIndexes = loader(set, "indexes");
  return {
    dbs: {},
    colls: {},
    indexes: {},
    loadDbs: async (connId, force) => {
      if (!force && get().dbs[connId]) return;
      await loadDbs(connId, () => api.mongoDbs(connId));
    },
    loadColls: async (connId, db, force) => {
      const k = `${connId}|${db}`;
      if (!force && get().colls[k]) return;
      await loadColls(k, () => api.mongoCollections(connId, db));
    },
    loadIndexes: async (connId, db, coll, force) => {
      const k = `${connId}|${db}|${coll}`;
      if (!force && get().indexes[k]) return;
      await loadIndexes(k, () => api.mongoIndexes(connId, db, coll));
    },
    invalidate: (connId) =>
      set((s) => {
        const drop = <T,>(rec: Record<string, T>) => Object.fromEntries(Object.entries(rec).filter(([k]) => k !== connId && !k.startsWith(connId + "|")));
        return { dbs: drop(s.dbs), colls: drop(s.colls), indexes: drop(s.indexes) };
      }),
  };
});
