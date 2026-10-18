import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { api, errorMessage } from "../api";
import type { SqlConfig } from "../api/types";
import { useRunner, type RunOutcome, type RunStmt } from "../grid/useRunner";
import { analyzeEditable } from "../sql/editable";
import type { Stmt } from "../sql/split";
import { isRisky, pickStatements, riskyTable } from "../sql/statements";
import { useConnections } from "../store/connections";
import { useTabs } from "../store/tabs";
import { useTx } from "../store/tx";
import { confirmDialog, toast } from "../store/ui";
import type { Scheme } from "../theme";
import { ResultPanel, StopButton } from "./ResultPanel";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { Splitter } from "./ui";

const toRunStmt = (s: Stmt, cfg: SqlConfig): RunStmt => ({
  text: s.text,
  isQuery: s.isQuery,
  pageable: s.pageable,
  rerunSafe: s.kind === "query" && !s.nestedDml,
  from: s.from,
  to: s.to,
  target: s.kind === "query" ? analyzeEditable(s, cfg.driver) : undefined,
});

const TX_END = new Set(["COMMIT", "ROLLBACK", "END"]);
const NO_TX = { manual: false, dirty: false, aborted: false };

export const ConsoleTab = memo(function ConsoleTab(props: { tabId: string; cfg: SqlConfig; scheme: Scheme; active: boolean }) {
  const { tabId, cfg } = props;
  const editor = useRef<SqlEditorHandle>(null);
  const [text, setText] = useState<string | null>(null);
  const [editorHeight, setEditorHeight] = useState(240);
  const snapshot = useConnections((s) => s.snapshot[cfg.id]);
  const defaultSchema = useConnections((s) => s.defaultSchema[cfg.id]);
  const status = useConnections((s) => s.status[cfg.id]);
  const tx = useTx((s) => s.modes[tabId]) ?? NO_TX;
  const [txBusy, setTxBusy] = useState(false);
  const runner = useRunner(cfg.id, tabId);

  useEffect(() => {
    api.loadConsole(cfg.id, tabId).then((t) => setText(t ?? ""));
  }, []);

  // 복원된 탭이면 접속부터 한다
  useEffect(() => {
    if (props.active && status !== "connected" && status !== "connecting") void useConnections.getState().connect(cfg.id);
  }, [props.active]);

  useEffect(() => {
    if (props.active) editor.current?.focus();
  }, [props.active, text !== null]);

  // 미커밋 트랜잭션은 탭 닫기 전에 확인 (그리드 보류 변경과는 출처를 나눠 저장한다)
  useEffect(() => {
    useTabs.getState().setDirty(tabId, "tx", tx.manual && tx.dirty ? "커밋하지 않은 트랜잭션이 있습니다. 닫으면 롤백됩니다." : null);
  }, [tx.manual, tx.dirty]);

  // 탭이 닫히면 전용 연결을 롤백하고 닫는다
  useEffect(
    () => () => {
      if (useTx.getState().modes[tabId]?.manual) void api.setTxMode(cfg.id, tabId, false, "rollback").catch(() => {});
      useTx.getState().clear(tabId);
    },
    [],
  );

  // 접속이 끊기면 Manual 모드도 해제된 것으로 표시
  useEffect(() => {
    if (status !== "connected" && tx.manual) useTx.getState().set(tabId, NO_TX);
  }, [status]);

  // 문서 전체를 문자열로 바꾸는 일은 디바운스가 끝났을 때 한 번만 한다
  const save = useMemo(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    return (getText: () => string) => {
      clearTimeout(t);
      t = setTimeout(() => void api.saveConsole(cfg.id, tabId, getText()), 1000);
    };
  }, []);

  const run = async (view: EditorView) => {
    if (runner.running) return;
    if (!(await useConnections.getState().connect(cfg.id))) return;
    const sel = view.state.selection.main;
    const stmts = pickStatements(view.state.doc.toString(), sel, cfg.driver);
    if (!stmts.length) return;
    const manual = !!useTx.getState().modes[tabId]?.manual;
    if (!manual && stmts.some((s) => s.kind === "tx")) {
      toast("트랜잭션 제어문(BEGIN/COMMIT/ROLLBACK)은 툴바에서 Manual 트랜잭션 모드로 바꾼 뒤 사용하세요.", "error");
      return;
    }
    const risky = stmts.filter(isRisky);
    if (risky.length) {
      const lines = risky.map((s) => `• ${s.dmlVerb} ${riskyTable(s, cfg.driver)}${s.hasTopLevelLimit ? " (LIMIT 있음)" : ""}`).join("\n");
      const ok = await confirmDialog({
        title: "WHERE 조건이 없습니다",
        body: `다음 문장은 WHERE 조건이 없어 테이블의 ${risky.some((s) => !s.hasTopLevelLimit) ? "모든" : "여러"} 행이 변경될 수 있습니다.\n\n${lines}\n\n실행할까요?`,
        okLabel: "실행",
        danger: true,
      });
      if (!ok) return;
    }
    const pending = useTabs.getState().dirty[tabId]?.edit;
    if (pending && !(await confirmDialog({ title: "변경 버리기", body: `${pending}\n다시 실행하면 버려집니다.`, okLabel: "실행", danger: true }))) return;

    const outcome = await runner.runAll(
      stmts.map((s) => toRunStmt(s, cfg)),
      (s) => editor.current?.markRunning(s.from !== undefined ? { from: s.from, to: s.to! } : null),
    );
    editor.current?.markRunning(null);
    if (manual) void afterManualRun(stmts, outcome);
  };

  /** Manual 모드에서 실행 후 트랜잭션 상태를 갱신한다. 실제로 성공한 문장까지만 본다. */
  const afterManualRun = async (stmts: Stmt[], outcome: RunOutcome) => {
    const done = stmts.slice(0, outcome.ran);
    if (done.some((s) => s.kind !== "query" && s.kind !== "tx")) useTx.getState().set(tabId, { dirty: true });
    // PG는 트랜잭션 안에서 오류(취소 포함)가 나면 Rollback 전까지 모든 문장이 실패한다
    if (!outcome.ok && cfg.driver === "postgres") useTx.getState().set(tabId, { aborted: true, dirty: true });
    // 사용자가 직접 COMMIT/ROLLBACK을 성공시켰을 때만 새 트랜잭션을 연다
    const last = done[done.length - 1];
    if (outcome.ok && last?.kind === "tx" && TX_END.has(last.firstKeyword)) {
      try {
        await api.txAction(tabId, "begin");
        useTx.getState().set(tabId, { dirty: false, aborted: false });
      } catch (e) {
        toast(errorMessage(e), "error");
      }
    }
  };

  const setManual = async (manual: boolean) => {
    if (txBusy) return;
    setTxBusy(true);
    try {
      if (manual) {
        if (!(await useConnections.getState().connect(cfg.id))) return;
        await api.setTxMode(cfg.id, tabId, true);
        useTx.getState().set(tabId, { manual: true, dirty: false, aborted: false });
      } else {
        let finish: "commit" | "rollback" = "rollback";
        // PG의 중단된 트랜잭션은 COMMIT해도 롤백되므로 묻지 않는다
        if (tx.dirty && !tx.aborted) {
          const commit = await confirmDialog({ title: "Auto-commit으로 전환", body: "커밋하지 않은 변경이 있을 수 있습니다. 커밋할까요?\n(취소하면 롤백합니다)", okLabel: "커밋" });
          finish = commit ? "commit" : "rollback";
        }
        await api.setTxMode(cfg.id, tabId, false, finish);
        useTx.getState().set(tabId, NO_TX);
        toast(finish === "commit" ? "커밋했습니다." : "롤백했습니다.");
      }
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setTxBusy(false);
    }
  };

  const txAction = async (action: "commit" | "rollback") => {
    setTxBusy(true);
    try {
      await api.txAction(tabId, action);
      useTx.getState().set(tabId, { dirty: false, aborted: false });
      toast(action === "commit" ? "커밋했습니다." : "롤백했습니다.");
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setTxBusy(false);
    }
  };

  const busy = !!runner.running || txBusy;
  return (
    <>
      <div className="toolbar">
        <button className="primary" disabled={!!runner.running} title="실행 (Ctrl+Enter)" onClick={() => editor.current?.view && run(editor.current.view)}>
          ▶ 실행
        </button>
        {runner.running && <StopButton runner={runner} />}
        <span style={{ width: 8 }} />
        <select value={tx.manual ? "manual" : "auto"} disabled={busy} onChange={(e) => setManual(e.target.value === "manual")} title="트랜잭션 모드">
          <option value="auto">Auto-commit</option>
          <option value="manual">Manual 트랜잭션</option>
        </select>
        {tx.manual && (
          <>
            <button disabled={busy || tx.aborted} onClick={() => txAction("commit")} title={tx.aborted ? "중단된 트랜잭션은 커밋할 수 없습니다" : "Commit"}>
              ✓ Commit
            </button>
            <button disabled={busy} onClick={() => txAction("rollback")} title="Rollback">
              ↶ Rollback
            </button>
            {tx.aborted && <span style={{ color: "var(--danger)" }}>트랜잭션 중단됨 — Rollback 필요</span>}
            {!tx.aborted && tx.dirty && <span className="label">미커밋 변경 있음</span>}
          </>
        )}
        <span className="spacer" />
        {cfg.read_only && <span className="badge">READ ONLY</span>}
        <span className="label">{cfg.name}</span>
      </div>
      <div style={{ height: editorHeight, flex: "none" }}>
        {text !== null && (
          <SqlEditor
            ref={editor}
            driver={cfg.driver}
            scheme={props.scheme}
            initialText={text}
            snapshot={snapshot}
            defaultSchema={defaultSchema}
            onChange={save}
            onRun={run}
          />
        )}
      </div>
      <Splitter dir="h" size={editorHeight} onResize={setEditorHeight} min={60} max={window.innerHeight - 160} />
      <ResultPanel runner={runner} scheme={props.scheme} ctx={{ cfg, tabId, consoleId: tabId }} />
    </>
  );
});
