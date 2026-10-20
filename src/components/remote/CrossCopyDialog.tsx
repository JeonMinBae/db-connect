import { useRef, useState } from "react";
import { api, errorMessage } from "../../api";
import type { ConnectionConfig } from "../../api/types";
import { crossTargets, pathsLabel } from "../../remote/browser";
import { join, normalize } from "../../remote/path";
import { useConnections } from "../../store/connections";
import { promptDialog, toast } from "../../store/ui";
import { Modal } from "../ui";
import { FolderTree, type FolderTreeHandle } from "./FolderTree";

export interface CrossReq {
  srcConnId: string;
  paths: string[];
  /** 붙여넣기: 대상이 정해진 확인 모드. null 이면 메뉴(대상 선택) */
  fixed: { connId: string; dir: string } | null;
  /** 다른 접속에서 잘라낸 항목 → 복사로 진행함을 알린다 */
  cut: boolean;
}

// .conn-color 는 Sidebar 에서 세로 막대(3px, stretch)라 글줄 안에서는 점 크기로 덮어쓴다
function ConnBadge(props: { cfg?: ConnectionConfig }) {
  const c = props.cfg;
  if (!c) return <span className="label">(선택 안 함)</span>;
  return (
    <b style={{ display: "inline-flex", alignItems: "center", gap: 5 }}>
      {c.color && <span className="conn-color" style={{ background: c.color, width: 8, height: 8, alignSelf: "center", borderRadius: "50%" }} />}
      {c.name}
    </b>
  );
}

export function CrossCopyDialog(props: { req: CrossReq; onSubmit: (destConnId: string, destDir: string) => void; onClose: () => void }) {
  const { req } = props;
  const configs = useConnections((s) => s.configs);
  const status = useConnections((s) => s.status);
  const [destId, setDestId] = useState<string | null>(req.fixed?.connId ?? null);
  const [dir, setDir] = useState(req.fixed?.dir ?? "/");
  const [input, setInput] = useState(dir);
  const tree = useRef<FolderTreeHandle>(null);
  const src = configs.find((c) => c.id === req.srcConnId);
  const dst = configs.find((c) => c.id === destId);
  const ready = !!dst && status[dst.id] === "connected" && !dst.read_only;

  const choose = (d: string) => {
    setDir(d);
    setInput(d);
  };

  const pick = async (id: string) => {
    setDestId(id || null);
    choose("/");
    if (!id) return;
    // 실패·호스트 키 거절은 선택 취소. 그 사이 다른 접속을 골랐으면 그대로 둔다
    if (!(await useConnections.getState().connect(id))) setDestId((cur) => (cur === id ? null : cur));
  };

  const mkdir = async () => {
    const name = (await promptDialog({ title: "새 폴더", fields: [{ label: "폴더 이름", value: "" }], okLabel: "만들기" }))?.[0].trim();
    if (!name || !destId) return;
    if (name.includes("/")) return toast("이름에 '/' 를 넣을 수 없습니다.", "error");
    try {
      await api.remoteMkdir(destId, join(dir, name));
      tree.current?.invalidate([dir]);
      choose(join(dir, name));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <Modal
      title={req.fixed ? "다른 접속으로 붙여넣기" : "다른 접속으로 복사"}
      width={480}
      onClose={props.onClose}
      footer={
        <>
          <button onClick={props.onClose}>취소</button>
          <button className="primary" disabled={!ready} onClick={() => dst && props.onSubmit(dst.id, normalize(dir))}>
            복사
          </button>
        </>
      }
    >
      {!req.fixed && (
        <>
          <label className="label" style={{ display: "block", marginBottom: 4 }}>
            대상 접속
          </label>
          <select style={{ width: "100%" }} value={destId ?? ""} onChange={(e) => void pick(e.target.value)}>
            <option value="">접속을 선택하세요</option>
            {crossTargets(configs, req.srcConnId).map(({ cfg, disabled }) => (
              <option key={cfg.id} value={cfg.id} disabled={disabled}>
                {cfg.name}
                {disabled ? " (읽기 전용)" : ""}
              </option>
            ))}
          </select>
          {ready && (
            <>
              <div style={{ display: "flex", gap: 6, margin: "8px 0" }}>
                <input
                  style={{ flex: 1 }}
                  value={input}
                  spellCheck={false}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={(e) => {
                    if (e.key === "Enter") choose(normalize(input));
                  }}
                  onBlur={() => setInput(dir)}
                />
                <button onClick={() => void mkdir()}>폴더 만들기</button>
              </div>
              <div className="tree" style={{ height: 220, overflow: "auto" }}>
                <FolderTree key={destId} ref={tree} connId={destId!} current={dir} showHidden={false} onOpen={choose} />
              </div>
            </>
          )}
        </>
      )}
      <div style={{ marginTop: 10, wordBreak: "break-all", display: "flex", flexWrap: "wrap", alignItems: "center", gap: 6 }}>
        <ConnBadge cfg={src} />
        <span>
          · {pathsLabel(req.paths)}
          {req.paths.length === 1 && " (1개 항목)"}
        </span>
        <span>→</span>
        <ConnBadge cfg={dst} />
        {dst && <span>:{normalize(dir)}</span>}
      </div>
      {req.cut && (
        <div className="label" style={{ marginTop: 8 }}>
          다른 접속으로는 복사만 됩니다. 원본은 지우지 않습니다.
        </div>
      )}
    </Modal>
  );
}
