import { useEffect, useRef, useState } from "react";
import { create } from "zustand";
import { api, errorMessage } from "../api";
import type { DdlPlan, SqlConfig } from "../api/types";
import { useConnections } from "../store/connections";
import { useTabs } from "../store/tabs";
import { useTree } from "../store/tree";
import { toast } from "../store/ui";
import { Modal } from "./ui";

type Req = { cfg: SqlConfig; schema: string; table: string };
const useDrop = create<{ req: Req | null }>(() => ({ req: null }));

/** 테이블 삭제 확인. 같은 테이블 탭에 제출하지 않은 편집이 있으면 먼저 막는다. */
export async function openDropTable(cfg: SqlConfig, schema: string, table: string) {
  const pending = useTabs.getState().pendingFor(cfg.id, schema, table);
  if (pending) {
    toast("이 테이블 탭에 제출하지 않은 변경이 있습니다. 먼저 제출하거나 취소하세요.", "error");
    useTabs.getState().activate(pending.id);
    return;
  }
  if (!(await useConnections.getState().connect(cfg.id))) return;
  useDrop.setState({ req: { cfg, schema, table } });
}

/** 테이블 이름을 그대로 입력해야 실행 버튼이 켜진다 */
export function DropTableHost() {
  const req = useDrop((s) => s.req);
  const [plan, setPlan] = useState<DdlPlan | null>(null);
  const [typed, setTyped] = useState("");
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const busy = useRef(false);

  useEffect(() => {
    setPlan(null);
    setTyped("");
    setError(null);
    if (req) api.previewDrop(req.cfg.id, req.schema, req.table).then(setPlan, (e) => setError(errorMessage(e)));
  }, [req]);

  if (!req) return null;
  const sql = plan?.statements[0]?.sql;
  const close = () => !busy.current && useDrop.setState({ req: null });
  const run = async () => {
    // Enter 연타로 DROP이 두 번 나가지 않게 ref로 동기 검사한다
    if (busy.current || !sql || typed !== req.table) return;
    busy.current = true;
    setRunning(true);
    setError(null);
    try {
      await api.applyDdl(req.cfg.id, [sql]);
      useTabs.getState().closeTable(req.cfg.id, req.schema, req.table);
      await Promise.all([useTree.getState().loadTables(req.cfg.id, req.schema, true), useConnections.getState().refreshSnapshot(req.cfg.id)]);
      toast(`테이블 ${req.table}을(를) 삭제했습니다.`);
      useDrop.setState({ req: null });
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      busy.current = false;
      setRunning(false);
    }
  };

  return (
    <Modal
      title="테이블 삭제"
      onClose={close}
      footer={
        <>
          <button onClick={close} disabled={running}>
            취소
          </button>
          <button className="danger" onClick={() => void run()} disabled={running || !sql || typed !== req.table}>
            {running ? "삭제 중…" : "삭제"}
          </button>
        </>
      }
    >
      <div className="form" style={{ gridTemplateColumns: "1fr" }}>
        <div className="ddl-warn">
          ⚠ 테이블 {req.schema}.{req.table}과(와) 모든 데이터가 삭제됩니다.
          {plan?.warnings.length ? (
            <ul>
              {plan.warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          ) : null}
        </div>
        {plan?.notes.map((n, i) => (
          <div key={i} className="hint">
            {n}
          </div>
        ))}
        {sql && <pre className="raw-sql">{sql};</pre>}
        <label>
          확인을 위해 테이블 이름 <b>{req.table}</b>을(를) 입력하세요.
          <input
            autoFocus
            style={{ width: "100%", marginTop: 4 }}
            value={typed}
            onChange={(e) => setTyped(e.target.value)}
            onKeyDown={(e) => e.key === "Enter" && void run()}
          />
        </label>
        {error && <div className="message error">{error}</div>}
      </div>
    </Modal>
  );
}
