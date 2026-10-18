import { useEffect, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import type { AppError, DdlPlan, SqlConfig, TableStructure } from "../api/types";
import { splitStatements } from "../sql/split";
import type { Scheme } from "../theme";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { Modal } from "./ui";

/**
 * 구조 변경 미리보기. 데이터 편집의 SubmitPreview와 같은 방식으로, 만든 DDL을 보여 주고 고쳐서 실행할 수 있다.
 * 실행은 콘솔 트랜잭션과 무관한 자동 커밋 연결에서 한다.
 */
export function DdlPreview(props: {
  cfg: SqlConfig;
  scheme: Scheme;
  schema: string;
  table: string;
  /** null이면 새 테이블 */
  original: TableStructure | null;
  draft: TableStructure;
  /** 바꿀 테이블 이름 (같으면 무시) */
  newName: string | null;
  onDone: () => void;
  /** MySQL에서 일부 문장만 반영된 채 실패함 (구조를 다시 읽어야 한다) */
  onPartial: () => void;
  onClose: () => void;
}) {
  const { cfg } = props;
  const [plan, setPlan] = useState<DdlPlan | null>(null);
  const [original, setOriginal] = useState<string | null>(null);
  const [edited, setEdited] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editor = useRef<SqlEditorHandle>(null);

  useEffect(() => {
    api
      .previewDdl(cfg.id, props.schema, props.table, props.original, props.draft, props.newName)
      .then((p) => {
        setPlan(p);
        setOriginal(p.statements.map((s) => s.sql + ";").join("\n\n"));
      })
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const run = async () => {
    if (running || original === null) return;
    setError(null);
    editor.current?.markRunning(null);
    const list = splitStatements(editor.current?.getText() ?? "", cfg.driver);
    if (!list.length) return setError("실행할 문장이 없습니다.");
    const tx = list.findIndex((s) => s.kind === "tx");
    if (tx >= 0) return setError(`${tx + 1}번째 문장: 트랜잭션 제어문(${list[tx].firstKeyword})은 넣을 수 없습니다.`);
    setRunning(true);
    try {
      await api.applyDdl(cfg.id, list.map((s) => s.text));
      props.onDone();
    } catch (e) {
      const err = e as AppError;
      const idx = err?.kind === "submit" ? err.change_index : undefined;
      setError((idx !== undefined ? `${idx + 1}번째 문장: ` : "") + errorMessage(e));
      if (idx !== undefined) {
        editor.current?.markRunning(list[idx] ?? null);
        if (cfg.driver === "mysql" && idx > 0) props.onPartial();
      }
    } finally {
      setRunning(false);
    }
  };

  const reset = () => {
    if (original === null) return;
    editor.current?.setText(original);
    editor.current?.markRunning(null);
    setError(null);
  };

  // 사람이 읽을 경고가 없으면 위험한 문장의 첫 줄을 보여 준다
  const destructive = plan?.statements.filter((s) => s.destructive) ?? [];
  const warnings = plan?.warnings.length ? plan.warnings : destructive.map((s) => s.sql.split("\n")[0]);
  const empty = plan !== null && plan.statements.length === 0;

  return (
    <Modal
      title={`구조 변경 미리보기 · ${props.schema}.${props.table}`}
      onClose={() => !running && props.onClose()}
      width={820}
      footer={
        <>
          <span className="hint" style={{ flex: 1 }}>
            {cfg.driver === "mysql"
              ? "MySQL DDL은 실행 즉시 반영되며 되돌릴 수 없습니다. 여러 문장이면 중간에 실패할 때 앞 문장만 반영됩니다."
              : "모든 문장을 한 트랜잭션으로 실행하고, 실패하면 모두 롤백합니다."}
          </span>
          <button onClick={reset} disabled={!edited || running}>
            원래대로
          </button>
          <button onClick={props.onClose} disabled={running}>
            취소
          </button>
          <button className={destructive.length ? "danger" : "primary"} onClick={run} disabled={running || original === null || empty}>
            {running ? "적용 중…" : "적용 (Ctrl+Enter)"}
          </button>
        </>
      }
    >
      <div className="submit-preview">
        {warnings.length > 0 && (
          <div className="ddl-warn">
            ⚠ 데이터가 사라지거나 바뀔 수 있는 변경
            <ul>
              {warnings.map((w, i) => (
                <li key={i}>{w}</li>
              ))}
            </ul>
          </div>
        )}
        {plan?.notes.length ? (
          <ul className="hint ddl-notes">
            {plan.notes.map((n, i) => (
              <li key={i}>{n}</li>
            ))}
          </ul>
        ) : null}
        {empty ? (
          <div className="hint">바뀐 것이 없습니다.</div>
        ) : original === null ? (
          <div className="hint">{error ? "" : "SQL을 만드는 중…"}</div>
        ) : (
          <SqlEditor
            ref={editor}
            driver={cfg.driver}
            scheme={props.scheme}
            initialText={original}
            onChange={(get) => setEdited(get() !== original)}
            onRun={() => void run()}
          />
        )}
        {error && <div className="message error">{error}</div>}
      </div>
    </Modal>
  );
}
