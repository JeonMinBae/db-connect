import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, type Pick } from "../../api";
import type { ConnectionConfig, RemoteEntry } from "../../api/types";
import { mtimeText, permText, sizeText, sortEntries, visibleEntries, type SortKey } from "../../remote/browser";
import { insideElement, registerDropHandler } from "../../remote/drops";
import { join, parent } from "../../remote/path";
import { useTabs } from "../../store/tabs";
import { confirmDialog, promptDialog, toast } from "../../store/ui";
import { showContextMenu, type MenuEntry } from "../ui";

interface Props {
  cfg: ConnectionConfig;
  path: string;
  entries: RemoteEntry[] | null;
  loading: boolean;
  showHidden: boolean;
  filter: string;
  onOpenDir: (path: string) => void;
  /** 쓰기 작업 뒤 호출: 목록 새로고침과 트리 캐시 무효화는 호출자가 한다 */
  onChanged: (affectedDirs: string[]) => void;
  onRefresh: () => void;
  /** 선택한 항목 다운로드 (저장 위치 선택과 큐 등록은 호출자가 한다) */
  onDownload: (targets: RemoteEntry[]) => void;
  /** OS 에서 이 목록으로 끌어다 놓은 항목 (소유권이 넘어오므로 받은 쪽이 해제까지 책임진다) */
  onDropPick?: (pick: Pick) => void;
  /** 이 탭이 활성일 때만 드롭을 받는다 */
  active: boolean;
}

const COLS: { key: SortKey; label: string }[] = [
  { key: "name", label: "이름" },
  { key: "size", label: "크기" },
  { key: "mtime", label: "수정일" },
];

export function FileList(props: Props) {
  const { cfg, path, entries, loading } = props;
  const [sort, setSort] = useState<{ key: SortKey; asc: boolean }>({ key: "name", asc: true });
  const [sel, setSel] = useState<Set<string>>(new Set());
  const anchor = useRef<string | null>(null);
  const host = useRef<HTMLDivElement>(null);

  const rows = useMemo(() => sortEntries(visibleEntries(entries ?? [], { showHidden: props.showHidden, filter: props.filter }), sort.key, sort.asc), [entries, props.showHidden, props.filter, sort]);
  const showPerm = rows.some((r) => r.perm !== null);

  // 폴더를 옮기면 선택을 비운다
  useEffect(() => {
    setSel(new Set());
    anchor.current = null;
  }, [path]);

  // 핸들러는 항상 최신 props 를 보도록 ref 로 들고, 등록은 마운트 동안 한 번만 한다
  const drop = useRef({ props, cfg });
  drop.current = { props, cfg };
  useEffect(
    () =>
      registerDropHandler((pick, x, y) => {
        const { props: p, cfg: c } = drop.current;
        if (!p.active || !insideElement(host.current, x, y)) return false;
        if (c.read_only) {
          toast("읽기 전용 접속입니다", "error");
          void api.pickRelease(pick.pick_id).catch(() => {});
        } else if (p.onDropPick) p.onDropPick(pick);
        else void api.pickRelease(pick.pick_id).catch(() => {});
        return true;
      }),
    [],
  );

  const selected = rows.filter((r) => sel.has(r.name));

  const click = (e: React.MouseEvent, r: RemoteEntry) => {
    if (e.shiftKey && anchor.current) {
      const a = rows.findIndex((x) => x.name === anchor.current);
      const b = rows.findIndex((x) => x.name === r.name);
      const [lo, hi] = a < b ? [a, b] : [b, a];
      setSel(new Set(rows.slice(lo, hi + 1).map((x) => x.name)));
      return;
    }
    anchor.current = r.name;
    if (e.ctrlKey || e.metaKey) {
      setSel((s) => {
        const n = new Set(s);
        if (!n.delete(r.name)) n.add(r.name);
        return n;
      });
    } else setSel(new Set([r.name]));
  };

  const open = (r: RemoteEntry) => {
    if (r.dir) props.onOpenDir(join(path, r.name));
    else useTabs.getState().openRemoteFile(cfg.id, join(path, r.name));
  };

  const mkdir = async () => {
    const v = await promptDialog({ title: "새 폴더", fields: [{ label: "폴더 이름", value: "" }], okLabel: "만들기" });
    const name = v?.[0].trim();
    if (!name) return;
    if (name.includes("/")) return toast("이름에 '/' 를 넣을 수 없습니다.", "error");
    try {
      await api.remoteMkdir(cfg.id, join(path, name));
      props.onChanged([path]);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const rename = async (r: RemoteEntry) => {
    const v = await promptDialog({ title: "이름 변경", fields: [{ label: "새 이름", value: r.name }], okLabel: "변경" });
    const name = v?.[0].trim();
    if (!name || name === r.name) return;
    if (name.includes("/")) return toast("이름에 '/' 를 넣을 수 없습니다.", "error");
    try {
      await api.remoteRename(cfg.id, join(path, r.name), join(path, name));
      props.onChanged([path, ...(r.dir ? [join(path, r.name)] : [])]);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const remove = async (targets: RemoteEntry[]) => {
    if (!targets.length) return;
    const d = targets.filter((t) => t.dir).length;
    const ok = await confirmDialog({
      title: "삭제",
      body: `${targets.length}개 항목을 삭제할까요?` + (d ? `\n폴더 ${d}개는 안의 내용까지 모두 삭제됩니다.` : ""),
      okLabel: "삭제",
      danger: true,
    });
    if (!ok) return;
    try {
      const n = await api.remoteDelete(cfg.id, targets.map((t) => join(path, t.name)));
      toast(`${n}개 파일을 삭제했습니다`);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
    // 일부만 지워졌을 수도 있으니 실패해도 갱신한다
    props.onChanged([path, ...targets.filter((t) => t.dir).map((t) => join(path, t.name))]);
  };

  const menu = (e: React.MouseEvent, r: RemoteEntry | null) => {
    let targets = selected;
    if (r && !sel.has(r.name)) {
      targets = [r];
      setSel(new Set([r.name]));
      anchor.current = r.name;
    }
    const ro = cfg.read_only;
    const items: MenuEntry[] = [];
    if (r) items.push({ label: r.dir ? "열기" : "편집기로 열기", onClick: () => open(r) }, "sep");
    items.push({ label: "새 폴더…", onClick: () => void mkdir(), disabled: ro });
    if (r) {
      items.push({ label: "다운로드…", onClick: () => props.onDownload(targets), disabled: !targets.length });
      items.push({ label: "이름 변경…", onClick: () => void rename(r), disabled: ro || targets.length !== 1 });
      items.push({ label: "삭제…", onClick: () => void remove(targets), disabled: ro });
    }
    items.push("sep", { label: "새로고침", onClick: props.onRefresh });
    showContextMenu(e, items);
  };

  const onKey = (e: React.KeyboardEvent) => {
    if ((e.target as HTMLElement).tagName === "INPUT") return;
    if (e.key === "Delete" && !cfg.read_only) void remove(selected);
    else if (e.key === "F2" && !cfg.read_only && selected.length === 1) void rename(selected[0]);
    else if (e.key === "Enter" && selected.length === 1) open(selected[0]);
    else if (e.key === "a" && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      setSel(new Set(rows.map((r) => r.name)));
    } else return;
    e.stopPropagation();
  };

  const header = (c: (typeof COLS)[number]) => (
    <th key={c.key} className={c.key === "size" ? "num" : ""} onClick={() => setSort((s) => ({ key: c.key, asc: s.key === c.key ? !s.asc : true }))}>
      {c.label}
      {sort.key === c.key ? (sort.asc ? " ▲" : " ▼") : ""}
    </th>
  );

  return (
    <div ref={host} className="file-list" tabIndex={0} onKeyDown={onKey} onContextMenu={(e) => menu(e, null)} onClick={() => host.current?.focus()}>
      {entries === null ? (
        <div className="empty">{loading ? "불러오는 중…" : ""}</div>
      ) : (
        <table>
          <thead>
            <tr>
              {header(COLS[0])}
              {header(COLS[1])}
              {header(COLS[2])}
              {showPerm && <th>권한</th>}
            </tr>
          </thead>
          <tbody>
            {path !== "/" && (
              <tr onDoubleClick={() => props.onOpenDir(parent(path))}>
                <td colSpan={showPerm ? 4 : 3}>📁 ..</td>
              </tr>
            )}
            {rows.map((r) => (
              <tr
                key={r.name}
                className={sel.has(r.name) ? "selected" : ""}
                onClick={(e) => click(e, r)}
                onDoubleClick={() => open(r)}
                onContextMenu={(e) => {
                  e.stopPropagation();
                  menu(e, r);
                }}
              >
                <td>
                  {r.dir ? "📁" : "📄"} {r.name}
                </td>
                <td className="num">{r.dir ? "" : sizeText(r.size)}</td>
                <td>{mtimeText(r.mtime)}</td>
                {showPerm && <td className="mono">{permText(r.perm)}</td>}
              </tr>
            ))}
          </tbody>
        </table>
      )}
      {loading && entries !== null && <div className="file-list-loading">불러오는 중…</div>}
    </div>
  );
}
