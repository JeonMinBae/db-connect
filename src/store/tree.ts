import { create } from "zustand";
import { api, errorMessage } from "../api";
import type { ColumnMeta, IndexInfo, TableInfo } from "../api/types";
import { toast } from "./ui";

/** 트리 노드 키: "conn" | "conn|schema" | "conn|schema|table" */
export const nodeKey = (...parts: string[]) => parts.join("\u0000");

type Loaded<T> = T[] | "loading";

interface TreeState {
  expanded: Record<string, boolean>;
  schemas: Record<string, Loaded<string>>;
  tables: Record<string, Loaded<TableInfo>>;
  columns: Record<string, Loaded<ColumnMeta>>;
  indexes: Record<string, Loaded<IndexInfo>>;
  toggle: (key: string, open?: boolean) => void;
  loadIndexes: (connId: string, schema: string, table: string, force?: boolean) => Promise<void>;
  loadSchemas: (connId: string, force?: boolean) => Promise<void>;
  loadTables: (connId: string, schema: string, force?: boolean) => Promise<void>;
  loadColumns: (connId: string, schema: string, table: string, force?: boolean) => Promise<ColumnMeta[]>;
  /** 접속 하위 캐시를 모두 비운다 */
  invalidate: (connId: string) => void;
  /** 구조가 바뀐 테이블별 번호. 열린 데이터 탭이 구독해 다시 조회한다. */
  versions: Record<string, number>;
  /** 구조 변경 후: 컬럼·인덱스 캐시를 새로 읽고 데이터 탭에 알린다 */
  structureChanged: (connId: string, schema: string, table: string) => Promise<void>;
}

const dropPrefix = <T>(rec: Record<string, T>, connId: string) =>
  Object.fromEntries(Object.entries(rec).filter(([k]) => k !== connId && !k.startsWith(connId + "\u0000")));

export const useTree = create<TreeState>((set, get) => ({
  expanded: {},
  schemas: {},
  tables: {},
  columns: {},
  indexes: {},

  toggle: (key, open) => set((s) => ({ expanded: { ...s.expanded, [key]: open ?? !s.expanded[key] } })),

  loadSchemas: async (connId, force) => {
    if (!force && get().schemas[connId]) return;
    set((s) => ({ schemas: { ...s.schemas, [connId]: "loading" } }));
    try {
      const list = await api.listSchemas(connId);
      set((s) => ({ schemas: { ...s.schemas, [connId]: list } }));
    } catch (e) {
      set((s) => ({ schemas: dropPrefix(s.schemas, connId) }));
      toast(errorMessage(e), "error");
    }
  },

  loadTables: async (connId, schema, force) => {
    const k = nodeKey(connId, schema);
    if (!force && get().tables[k]) return;
    set((s) => ({ tables: { ...s.tables, [k]: "loading" } }));
    try {
      const list = await api.listTables(connId, schema);
      set((s) => ({ tables: { ...s.tables, [k]: list } }));
    } catch (e) {
      set((s) => {
        const tables = { ...s.tables };
        delete tables[k];
        return { tables };
      });
      toast(errorMessage(e), "error");
    }
  },

  loadIndexes: async (connId, schema, table, force) => {
    const k = nodeKey(connId, schema, table);
    if (!force && get().indexes[k]) return;
    set((s) => ({ indexes: { ...s.indexes, [k]: "loading" } }));
    try {
      const list = await api.listIndexes(connId, schema, table);
      set((s) => ({ indexes: { ...s.indexes, [k]: list } }));
    } catch (e) {
      set((s) => {
        const indexes = { ...s.indexes };
        delete indexes[k];
        return { indexes };
      });
      toast(errorMessage(e), "error");
    }
  },

  loadColumns: async (connId, schema, table, force) => {
    const k = nodeKey(connId, schema, table);
    const cur = get().columns[k];
    if (!force && cur && cur !== "loading") return cur;
    set((s) => ({ columns: { ...s.columns, [k]: "loading" } }));
    try {
      const list = await api.listColumns(connId, schema, table);
      set((s) => ({ columns: { ...s.columns, [k]: list } }));
      return list;
    } catch (e) {
      set((s) => {
        const columns = { ...s.columns };
        delete columns[k];
        return { columns };
      });
      toast(errorMessage(e), "error");
      return [];
    }
  },

  invalidate: (connId) =>
    set((s) => ({
      schemas: dropPrefix(s.schemas, connId),
      tables: dropPrefix(s.tables, connId),
      columns: dropPrefix(s.columns, connId),
      indexes: dropPrefix(s.indexes, connId),
    })),

  versions: {},

  structureChanged: async (connId, schema, table) => {
    const k = nodeKey(connId, schema, table);
    set((s) => {
      const indexes = { ...s.indexes };
      delete indexes[k];
      return { indexes };
    });
    await get().loadColumns(connId, schema, table, true);
    set((s) => ({ versions: { ...s.versions, [k]: (s.versions[k] ?? 0) + 1 } }));
  },
}));
