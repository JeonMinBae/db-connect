import { memo, useCallback, useEffect, useRef, useState } from "react";
import { api, errorMessage, type Pick } from "../../api";
import type { ConnectionConfig, RemoteEntry } from "../../api/types";
import { History, pasteKind, pathsLabel } from "../../remote/browser";
import { useRemoteClip } from "../../remote/clipboard";
import { isUnder, join, normalize, parent } from "../../remote/path";
import { subscribeAnyDone, subscribeDone, useTransfers } from "../../remote/transfers";
import { useConnections } from "../../store/connections";
import { toast } from "../../store/ui";
import { Splitter, showContextMenu } from "../ui";
import { CrossCopyDialog, type CrossReq } from "./CrossCopyDialog";
import { FileList } from "./FileList";
import { FolderTree, type FolderTreeHandle } from "./FolderTree";
import { TransferPanel } from "./TransferPanel";

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

  const clip = useRemoteClip((s) => s.clip);
  const setClip = useRemoteClip((s) => s.setClip);
  const [cross, setCross] = useState<CrossReq | null>(null);

  const copyTo = (paths: string[], dest: string) => {
    useTransfers.getState().enqueue(props.tabId, cfg.id, `⧉ ${pathsLabel(paths)} → ${dest}`, { kind: "copy", paths, dest_dir: dest });
  };

  const moveTo = async (paths: string[], dest: string): Promise<boolean> => {
    try {
      const n = await api.remoteMove(cfg.id, paths, dest);
      if (n) toast(`${n}개 항목을 옮겼습니다`);
      return true;
    } catch (e) {
      toast(errorMessage(e), "error");
      return false;
    } finally {
      // 일부만 옮겨졌을 수도 있으니 실패해도 갱신한다
      changed([...new Set([dest, ...paths.map(parent), ...paths])]);
    }
  };

  const paste = async (dest: string) => {
    if (cfg.read_only) return toast("읽기 전용 접속입니다", "error");
    if (!clip) return;
    const kind = pasteKind(clip, cfg.id);
    if (kind === "cross") {
      if (useConnections.getState().status[clip.connId] !== "connected") return toast("원본 접속이 끊겨 있습니다. 다시 접속한 뒤 붙여넣으세요.", "error");
      return setCross({ srcConnId: clip.connId, paths: clip.paths, fixed: { connId: cfg.id, dir: dest }, cut: clip.mode === "cut" });
    }
    if (kind === "copy") copyTo(clip.paths, dest);
    else if (await moveTo(clip.paths, dest)) setClip(null);
  };

  // 작업은 시작한 이 탭의 큐에 넣는다. transferStart 의 connId 는 원본 접속이다
  const startCross = (req: CrossReq, destConnId: string, destDir: string) => {
    const dstName = useConnections.getState().configs.find((c) => c.id === destConnId)?.name ?? destConnId;
    useTransfers.getState().enqueue(props.tabId, req.srcConnId, `⇄ ${pathsLabel(req.paths)} → ${dstName}:${destDir}`, { kind: "crosscopy", paths: req.paths, dest_conn_id: destConnId, dest_dir: destDir });
    setCross(null);
  };

  const transfer = (paths: string[], dest: string, copy: boolean) => {
    if (cfg.read_only) return toast("읽기 전용 접속입니다", "error");
    if (copy) copyTo(paths, dest);
    else void moveTo(paths, dest);
  };

  const enqueueUpload = (pick: Pick) => {
    const dest = pathRef.current;
    const what = pick.names.length === 1 ? pick.names[0] : `${pick.names.length}개 항목`;
    useTransfers.getState().enqueue(props.tabId, cfg.id, `↑ ${what} → ${dest}`, { kind: "upload", pick_id: pick.pick_id, dest_dir: dest });
  };

  const upload = async (dirs: boolean) => {
    try {
      const pick = await api.pickUpload(dirs);
      if (pick) enqueueUpload(pick);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  const uploadMenu = (e: React.MouseEvent) => {
    const r = e.currentTarget.getBoundingClientRect();
    showContextMenu({ clientX: r.left, clientY: r.bottom }, [
      { label: "파일…", onClick: () => void upload(false) },
      { label: "폴더…", onClick: () => void upload(true) },
    ]);
  };

  // 선택 1개가 파일이면 저장 파일 대화상자, 그 외에는 폴더 대화상자
  const download = async (targets: RemoteEntry[]) => {
    if (!targets.length) return;
    const single = targets.length === 1 && !targets[0].dir ? targets[0].name : null;
    try {
      const pick = await api.pickDownloadTarget(single);
      if (!pick) return;
      const label = targets.length === 1 ? targets[0].name : `${targets.length}개 항목`;
      useTransfers.getState().enqueue(props.tabId, cfg.id, `↓ ${label}`, { kind: "download", paths: targets.map((t) => join(pathRef.current, t.name)), pick_id: pick.pick_id });
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  // 업로드·복사가 끝나면(일부만 된 경우 포함) 현재 폴더가 대상이거나 그 하위일 때 목록과 트리를 갱신한다 (폴더 병합 복사)
  const onUploaded = useRef((_dest: string) => {});
  onUploaded.current = (dest) => {
    const cur = pathRef.current;
    tree.current?.invalidate([dest, cur]);
    if (isUnder(cur, dest)) void load(cur);
  };
  useEffect(
    () =>
      subscribeDone(props.tabId, (it) => {
        if (it.job.kind === "upload" || it.job.kind === "copy") onUploaded.current(it.job.dest_dir);
      }),
    [props.tabId],
  );
  // 접속 간 복사는 다른 탭에서 시작했을 수도 있어 전역 완료 알림으로 대상 접속 탭을 갱신한다
  useEffect(
    () =>
      subscribeAnyDone((it) => {
        if (it.job.kind === "crosscopy" && it.job.dest_conn_id === cfg.id) onUploaded.current(it.job.dest_dir);
      }),
    [cfg.id],
  );

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
        <button onClick={uploadMenu} disabled={cfg.read_only} title={cfg.read_only ? "읽기 전용 접속입니다" : "업로드"}>
          업로드 ▾
        </button>
        <input className="remote-filter" placeholder="이름 필터" value={filter} onChange={(e) => setFilter(e.target.value)} />
      </div>
      <div className="remote-body">
        <div style={{ width: treeWidth, display: "flex", flexDirection: "column", flex: "none", minWidth: 0 }}>
          <FolderTree ref={tree} connId={cfg.id} current={path} showHidden={showHidden} onOpen={(p) => void go(p)} />
        </div>
        <Splitter dir="v" size={treeWidth} onResize={setTreeWidth} min={120} max={600} />
        <FileList cfg={cfg} active={props.active} clipboard={clip} onClip={(mode, paths) => setClip({ mode, connId: cfg.id, paths })} onCrossCopy={(paths) => setCross({ srcConnId: cfg.id, paths, fixed: null, cut: false })} onPaste={(d) => void paste(d)} onTransfer={transfer} onDropPick={enqueueUpload} onDownload={(t) => void download(t)} path={path} entries={entries} loading={loading} showHidden={showHidden} filter={filter} onOpenDir={(p) => void go(p)} onChanged={changed} onRefresh={refresh} />
      </div>
      <div className="remote-footer">
        <TransferPanel tabId={props.tabId} />
      </div>
      {cross && <CrossCopyDialog req={cross} onSubmit={(id, d) => startCross(cross, id, d)} onClose={() => setCross(null)} />}
    </>
  );
});
