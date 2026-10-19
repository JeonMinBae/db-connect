import { create } from "zustand";
import type { ConnectionConfig, TableInfo } from "../api/types";
import { buildKeyTree, type KeyFolder, type ScanKey } from "../redis/keys";
import { nodeKey } from "./tree";

interface SidebarState {
  /** 검색어 (입력 디바운스 후) */
  query: string;
  /** 선택한 줄의 nodeId */
  selected: string | null;
  setQuery: (q: string) => void;
  select: (id: string | null) => void;
}

export const useSidebar = create<SidebarState>((set) => ({
  query: "",
  selected: null,
  setQuery: (query) => set({ query }),
  select: (selected) => set({ selected }),
}));

/** 대소문자를 무시한 부분 일치 구간들 [시작, 끝) */
export function matchRanges(text: string, q: string): [number, number][] {
  const t = text.toLowerCase();
  const n = q.toLowerCase();
  // 소문자로 바꾸면 길이가 달라지는 문자(İ 등)가 있으면 위치가 어긋나므로 일치로 보지 않는다
  if (!n || t.length !== text.length) return [];
  const out: [number, number][] = [];
  for (let i = t.indexOf(n); i >= 0; i = t.indexOf(n, i + n.length)) out.push([i, i + n.length]);
  return out;
}

type Loaded<T> = T[] | "loading";

export interface SearchData {
  configs: Pick<ConnectionConfig, "id" | "key_separator">[];
  schemas: Record<string, Loaded<string>>;
  tables: Record<string, Loaded<TableInfo>>;
  redisDbs: Record<string, Loaded<{ db: number }>>;
  redisScans: Record<string, { keys: ScanKey[] }>;
  mongoDbs: Record<string, Loaded<{ name: string }>>;
  mongoColls: Record<string, Loaded<{ name: string; kind: string }>>;
}

/**
 * 이미 불러온 항목 중 검색어와 일치하는 것이 보이도록 펼쳐야 할 노드 키.
 * 테이블·키·컬렉션 단계까지만 본다 (컬럼·인덱스 일치로는 펼치지 않음).
 * 키 모양은 각 트리 컴포넌트가 useTree.expanded 에 쓰는 키와 같아야 한다.
 */
export function searchOpenKeys(q: string, d: SearchData): string[] {
  const out = new Set<string>();
  const hit = (s: string) => matchRanges(s, q).length > 0;
  const open = (path: string[]) => path.forEach((k) => out.add(k));

  for (const c of d.configs) {
    const schemas = d.schemas[c.id];
    if (Array.isArray(schemas)) {
      // 스키마가 하나면 스키마 줄 없이 tables 폴더가 접속 바로 아래에 온다
      const single = schemas.length === 1;
      for (const s of schemas) {
        const sk = nodeKey(c.id, s);
        const path = single ? [c.id] : [c.id, sk];
        if (!single && hit(s)) open([c.id]);
        const tables = d.tables[sk];
        if (!Array.isArray(tables)) continue;
        for (const t of tables) {
          const folder = t.kind === "TABLE" ? "#tables" : t.kind === "VIEW" ? "#views" : null;
          if (folder && hit(t.name)) open([...path, nodeKey(sk, folder)]);
        }
      }
    }

    const rdbs = d.redisDbs[c.id];
    if (Array.isArray(rdbs)) {
      for (const { db } of rdbs) {
        const dk = nodeKey(c.id, `db${db}`);
        if (hit(`db${db}`)) open([c.id]);
        const scan = d.redisScans[`${c.id}|${db}`];
        if (!scan) continue;
        const walk = (f: KeyFolder, path: string[]) => {
          for (const sub of f.folders.values()) {
            if (hit(sub.name === "" ? "(빈 이름)" : sub.name)) open(path);
            walk(sub, [...path, nodeKey(dk, "#k:" + sub.path)]);
          }
          if (f.keys.some((k) => hit(k.label))) open(path);
        };
        walk(buildKeyTree(scan.keys, c.key_separator), [c.id, dk]);
      }
    }

    const mdbs = d.mongoDbs[c.id];
    if (Array.isArray(mdbs)) {
      for (const m of mdbs) {
        const mk = nodeKey(c.id, m.name);
        if (hit(m.name)) open([c.id]);
        const colls = d.mongoColls[`${c.id}|${m.name}`];
        if (!Array.isArray(colls)) continue;
        for (const co of colls) if (hit(co.name)) open([c.id, mk, nodeKey(mk, co.kind === "view" ? "#views" : "#collections")]);
      }
    }
  }
  return [...out];
}
