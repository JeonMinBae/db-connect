import type { Bytes } from "./bytes";

export interface ScanKey {
  name: Bytes;
  type: string;
}

/** 구분자로 나눈 폴더 트리. 같은 이름의 키와 폴더(user, user:1)가 함께 있을 수 있다. */
export interface KeyFolder {
  name: string;
  /** 접두어 (트리 노드 식별용) */
  path: string;
  folders: Map<string, KeyFolder>;
  keys: { label: string; key: ScanKey }[];
  /** 하위 키 전체 수 */
  count: number;
}

const folder = (name: string, path: string): KeyFolder => ({ name, path, folders: new Map(), keys: [], count: 0 });

export function buildKeyTree(keys: ScanKey[], sep: string): KeyFolder {
  const root = folder("", "");
  for (const k of keys) {
    // 바이너리 키와 구분자가 없는 경우는 최상위 키로 둔다
    const parts = k.name.t === "Text" && sep ? k.name.v.split(sep) : [k.name.v];
    let cur = root;
    cur.count++;
    for (let i = 0; i < parts.length - 1; i++) {
      const path = cur.path + parts[i] + sep;
      let next = cur.folders.get(parts[i]);
      if (!next) cur.folders.set(parts[i], (next = folder(parts[i], path)));
      next.count++;
      cur = next;
    }
    cur.keys.push({ label: k.name.t === "Text" ? parts[parts.length - 1] : `"${k.name.v}"`, key: k });
  }
  return root;
}

/** 폴더는 이름순, 키는 이름순 */
export function sortedChildren(f: KeyFolder) {
  const folders = [...f.folders.values()].sort((a, b) => a.name.localeCompare(b.name));
  const keys = [...f.keys].sort((a, b) => a.label.localeCompare(b.label));
  return { folders, keys };
}
