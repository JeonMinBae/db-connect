import { forwardRef, useCallback, useEffect, useImperativeHandle, useState } from "react";
import { api, errorMessage } from "../../api";
import type { RemoteEntry } from "../../api/types";
import { join, normalize, parent } from "../../remote/path";
import { toast } from "../../store/ui";

export interface FolderTreeHandle {
  /** 해당 폴더의 캐시를 버리고(펼쳐져 있으면) 다시 읽는다 */
  invalidate: (paths: string[]) => void;
}

type Cache = Record<string, RemoteEntry[] | "loading">;

export const FolderTree = forwardRef<FolderTreeHandle, { connId: string; current: string; showHidden: boolean; onOpen: (path: string) => void }>(function FolderTree(props, ref) {
  const { connId, current } = props;
  const [cache, setCache] = useState<Cache>({});
  const [open, setOpen] = useState<Set<string>>(() => new Set(["/"]));

  const load = useCallback(
    async (path: string) => {
      setCache((c) => ({ ...c, [path]: "loading" }));
      try {
        const list = await api.remoteList(connId, path);
        setCache((c) => ({ ...c, [path]: list }));
      } catch (e) {
        setCache((c) => {
          const { [path]: _drop, ...rest } = c;
          return rest;
        });
        setOpen((o) => {
          const n = new Set(o);
          n.delete(path);
          return n;
        });
        toast(errorMessage(e), "error");
      }
    },
    [connId],
  );

  useImperativeHandle(ref, () => ({
    invalidate: (paths) => {
      const ps = paths.map(normalize);
      for (const p of ps) if (open.has(p)) void load(p);
      setCache((c) => {
        const n = { ...c };
        for (const p of ps) if (!open.has(p)) delete n[p];
        return n;
      });
    },
  }));

  // 현재 경로의 조상은 펼쳐서 보이게 한다
  useEffect(() => {
    const chain: string[] = [];
    for (let p = current; ; p = parent(p)) {
      chain.push(p);
      if (p === "/") break;
    }
    setOpen((o) => new Set([...o, ...chain]));
    for (const p of chain) if (!cache[p]) void load(p);
  }, [current]);

  const toggle = (path: string) => {
    const isOpen = open.has(path);
    setOpen((o) => {
      const n = new Set(o);
      if (isOpen) n.delete(path);
      else n.add(path);
      return n;
    });
    if (!isOpen && !cache[path]) void load(path);
  };

  const render = (path: string, name: string, depth: number): JSX.Element => {
    const isOpen = open.has(path);
    const c = cache[path];
    const dirs = Array.isArray(c) ? c.filter((e) => e.dir && (props.showHidden || !e.name.startsWith("."))).sort((a, b) => a.name.localeCompare(b.name, undefined, { numeric: true })) : [];
    return (
      <div key={path}>
        <div className={`tree-row${path === current ? " selected" : ""}`} style={{ paddingLeft: 6 + depth * 14 }} onClick={() => props.onOpen(path)}>
          <span
            className="twisty"
            onClick={(e) => {
              e.stopPropagation();
              toggle(path);
            }}
          >
            {isOpen ? "▾" : "▸"}
          </span>
          <span>{name}</span>
          {c === "loading" && <span className="type">…</span>}
        </div>
        {isOpen && dirs.map((d) => render(join(path, d.name), d.name, depth + 1))}
      </div>
    );
  };

  return <div className="tree remote-tree">{render("/", "/", 0)}</div>;
});
