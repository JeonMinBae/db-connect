import { useEffect, useRef, useState } from "react";
import { api, errorMessage, type SubmitReq } from "../api";
import type { AppError, SqlConfig } from "../api/types";
import { toSubmitStatements } from "../sql/statements";
import type { Scheme } from "../theme";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { Modal } from "./ui";

/**
 * Submit 전에 실제로 나갈 SQL을 보여 준다.
 * 고치지 않으면 바인딩 방식으로 그대로 반영하고, 고쳤으면 고친 SQL을 한 트랜잭션으로 실행한다.
 */
export function SubmitPreview(props: {
  cfg: SqlConfig;
  scheme: Scheme;
  req: SubmitReq;
  /** 바인딩 방식 실패 시 문제 행 표시 (change_index → 그리드 행) */
  onFailedChange: (changeIndex: number) => void;
  /** 반영 성공 (문장 수, 고쳐서 실행했는지) */
  onDone: (count: number, edited: boolean) => void;
  onClose: () => void;
}) {
  const [original, setOriginal] = useState<string | null>(null);
  const [edited, setEdited] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const editor = useRef<SqlEditorHandle>(null);
  const text = () => editor.current?.getText() ?? "";

  useEffect(() => {
    api
      .previewChanges(props.req)
      .then((stmts) => setOriginal(stmts.map((s) => s.sql + ";").join("\n\n")))
      .catch((e) => setError(errorMessage(e)));
  }, []);

  const run = async () => {
    if (running || original === null) return;
    setError(null);
    editor.current?.markRunning(null);
    const changed = text() !== original;
    let ranges: { from: number; to: number }[] = [];
    setRunning(true);
    try {
      if (!changed) {
        await api.submitChanges(props.req);
        props.onDone(props.req.changes.length, false);
      } else {
        const parsed = toSubmitStatements(text(), props.cfg.driver);
        if ("error" in parsed) {
          setError(parsed.error);
          return;
        }
        ranges = parsed.ranges;
        await api.submitSql(props.cfg.id, props.req.console_id, parsed.stmts);
        props.onDone(parsed.stmts.length, true);
      }
    } catch (e) {
      const err = e as AppError;
      const idx = err?.kind === "submit" ? err.change_index : undefined;
      setError((idx !== undefined ? `${idx + 1}번째 문장: ` : "") + errorMessage(e));
      if (idx !== undefined) {
        if (changed) editor.current?.markRunning(ranges[idx] ?? null);
        else props.onFailedChange(idx);
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

  return (
    <Modal
      title={`변경 반영 미리보기 · ${props.req.changes.length}개 변경`}
      onClose={() => !running && props.onClose()}
      width={820}
      footer={
        <>
          <span className="hint" style={{ flex: 1 }}>
            {edited ? "고친 SQL을 그대로 실행합니다." : "값은 실행할 때 바인딩 파라미터로 전달됩니다."} UPDATE/DELETE가 정확히 1행에 영향을 주지 않으면 모두 롤백합니다.
          </span>
          <button onClick={reset} disabled={!edited || running}>
            원래대로
          </button>
          <button onClick={props.onClose} disabled={running}>
            취소
          </button>
          <button className="primary" onClick={run} disabled={running || original === null}>
            {running ? "반영 중…" : "반영 (Ctrl+Enter)"}
          </button>
        </>
      }
    >
      <div className="submit-preview">
        {original === null ? (
          <div className="hint">{error ? "" : "SQL을 만드는 중…"}</div>
        ) : (
          <SqlEditor
            ref={editor}
            driver={props.cfg.driver}
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
