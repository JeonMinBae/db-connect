import { memo, useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, type Pick } from "../../api";
import type { ConnectionConfig, RemoteEntry } from "../../api/types";
import { History } from "../../remote/browser";
import { normalize } from "../../remote/path";
import { toast } from "../../store/ui";
import { Splitter } from "../ui";
import { FileList } from "./FileList";
import { FolderTree, type FolderTreeHandle } from "./FolderTree";

export const BrowserTab = memo(function BrowserTab(props: { tabId: string; cfg: ConnectionConfig; active: boolean }) {
  const { cfg } = props;
  const hist = useRef(new History("/"));
  const [path, setPath] = useState("/");
  const [input, setInput] = useState("/");
  const [entries, setEntries] = useState<RemoteEntry[] | null>(null);
  const [loading, setLoading] = useState(false);
  const [showHidden, setShowHidden] = useState(false);
  const [filter, setFilter] = useState("");
  const [treeWidth, setTreeWidth] = useState(220);
  const tree = useRef<FolderTreeHandle>(null);
  const started = useRef(false);
  // 늦게 도착한 응답이 최신 이동을 덮지 않도록 요청 순번을 둔다
  const seq = useRef(0);
  const pathRef = useRef("/");

  /** 성공하면 true. 실패하면 토스트를 띄우고 입력창을 표시 중인 경로로 되돌린다 */
  const load = useCallback(
    async (p: string): Promise<boolean> => {
      const my = ++seq.current;
      setLoading(true);
      try {
        const list = await api.remoteList(cfg.id, p);
        if (my !== seq.current) return true;
        setEntries(list);
        setPath(p);
        setInput(p);
        pathRef.current = p;
        return true;
      } catch (e) {
        if (my === seq.current) {
          toast(errorMessage(e), "error");
          setInput(pathRef.current);
        }
        return false;
      } finally {
        if (my === seq.current) setLoading(false);
      }
    },
    [cfg.id],
  );

  // 처음 보일 때 한 번만 읽는다
  useEffect(() => {
    if (props.active && !started.current) {
      started.current = true;
      void load("/");
    }
  }, [props.active]);

  // 이동 실패 시 History 를 원래 상태로 되돌리려고 복사본을 만들어 시도한다
  const move = async (next: (h: History) => string | null) => {
    const h = hist.current;
    const snapshot = h.clone();
    const p = next(h);
    if (p === null) return;
    if (!(await load(p))) hist.current = snapshot;
  };
  const go = (target: string) => move((h) => (normalize(target) === h.current ? null : (h.push(normalize(target)), normalize(target))));
  const back = () => move((h) => h.back());
  const up = () => move((h) => h.up());
  const refresh = () => void load(hist.current.current);

  const changed = (dirs: string[]) => {
    tree.current?.invalidate(dirs);
    refresh();
  };

  // 전송 큐가 생기기 전까지의 임시 처리 (Task 8 에서 업로드 등록으로 교체)
  const dropPick = (pick: Pick) => {
    toast(`${pick.names.length}개 항목 업로드는 전송 기능에서 처리됩니다`);
    void api.pickRelease(pick.pick_id).catch(() => {});
  };

  return (
    <>
      <div className="toolbar">
        <button className="icon" onClick={() => void back()} title="뒤로">
          ◀
        </button>
        <button className="icon" onClick={() => void up()} title="위로">
          ▲
        </button>
        <button className="icon" onClick={refresh} title="새로고침">
          ⟳
        </button>
        <input
          className="remote-path"
          value={input}
          spellCheck={false}
          onChange={(e) => setInput(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === "Enter") void go(input);
            else if (e.key === "Escape") setInput(path);
          }}
        />
        <label className="label">
          <input type="checkbox" checked={showHidden} onChange={(e) => setShowHidden(e.target.checked)} /> 숨김 파일
        </label>
        <input className="remote-filter" placeholder="이름 필터" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="remote-body">
        <div style={{ width: treeWidth, display: "flex", flexDirection: "column", flex: "none", minWidth: 0 }}>
          <FolderTree ref={tree} connId={cfg.id} current={path} showHidden={showHidden} onOpen={(p) => void go(p)} />
        </div>
        <Splitter dir="v" size={treeWidth} onResize={setTreeWidth} min={120} max={600} />
        <FileList cfg={cfg} active={props.active} onDropPick={dropPick} path={path} entries={entries} loading={loading} showHidden={showHidden} filter={filter} onOpenDir={(p) => void go(p)} onChanged={changed} onRefresh={refresh} />
      </div>
      {/* 전송 큐 자리 (Task 8) */}
      <div className="remote-footer" />
    </>
  );
});
