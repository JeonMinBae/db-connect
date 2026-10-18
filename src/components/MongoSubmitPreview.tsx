import { useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import type { AppError, ConnectionConfig } from "../api/types";
import { parseMongoCommand, splitMongo, type MongoOp } from "../mongo/console";
import { formatOp } from "../mongo/docs";
import { useConnections } from "../store/connections";
import { toast } from "../store/ui";
import type { Scheme } from "../theme";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { Modal } from "./ui";

const SUBMIT_KINDS = new Set(["insertOne", "updateOne", "replaceOne", "deleteOne"]);

/**
 * 반영할 작업을 mongosh 표기로 보여 주고, 고쳐서 실행할 수 있다.
 * 레플리카셋이면 트랜잭션으로 묶고, standalone이면 차례로 실행한다(롤백 불가).
 */
export function MongoSubmitPreview(props: { cfg: ConnectionConfig; db: string; ops: MongoOp[]; scheme: Scheme; onDone: () => void; onClose: () => void }) {
  const original = useMemo(() => props.ops.map(formatOp).join("\n"), [props.ops]);
  const topology = useConnections((s) => s.topology[props.cfg.id]);
  const standalone = topology === "standalone";
  const editor = useRef<SqlEditorHandle>(null);
  const [edited, setEdited] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (running) return;
    setError(null);
    editor.current?.markRunning(null);
    const text = editor.current?.getText() ?? original;
    let ops: MongoOp[];
    let ranges: { from: number; to: number }[] = [];
    try {
      if (text === original) ops = props.ops;
      else {
        const stmts = splitMongo(text);
        ranges = stmts;
        ops = stmts.map((s) => parseMongoCommand(s.text));
        const bad = ops.findIndex((o) => !SUBMIT_KINDS.has(o.kind));
        if (bad >= 0) throw new Error(`${bad + 1}번째 문장: Submit에는 insertOne / updateOne / replaceOne / deleteOne만 쓸 수 있습니다`);
      }
    } catch (e) {
      return setError(errorMessage(e));
    }
    if (!ops.length) return setError("실행할 작업이 없습니다.");
    setRunning(true);
    try {
      const n = await api.mongoSubmit(props.cfg.id, props.db, ops);
      toast(`${n}개 작업을 반영했습니다.`);
      props.onDone();
    } catch (e) {
      const err = e as AppError;
      setError(errorMessage(e));
      if (err?.kind === "submit" && err.change_index !== undefined) {
        const lines = text === original ? null : ranges[err.change_index];
        if (lines) editor.current?.markRunning(lines);
        else {
          const at = original.split("\n").slice(0, err.change_index).join("\n").length + (err.change_index ? 1 : 0);
          editor.current?.markRunning({ from: at, to: at + (original.split("\n")[err.change_index]?.length ?? 0) });
        }
      }
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title={`변경 반영 미리보기 · ${props.ops.length}개 작업`}
      onClose={() => !running && props.onClose()}
      width={860}
      footer={
        <>
          <span className="hint" style={{ flex: 1, color: standalone ? "var(--danger)" : undefined }}>
            {standalone
              ? "standalone 서버라 트랜잭션이 없습니다. 중간에 실패하면 앞의 작업은 되돌릴 수 없습니다."
              : "한 트랜잭션으로 반영하고, 하나라도 실패하면 모두 롤백합니다."}{" "}
            update·replace·delete는 정확히 1개 문서와 맞아야 합니다.
          </span>
          <button disabled={!edited || running} onClick={() => editor.current?.setText(original)}>
            원래대로
          </button>
          <button onClick={props.onClose} disabled={running}>
            취소
          </button>
          <button className="primary" onClick={run} disabled={running}>
            {running ? "반영 중…" : "반영 (Ctrl+Enter)"}
          </button>
        </>
      }
    >
      <div className="submit-preview">
        <SqlEditor ref={editor} language={[]} scheme={props.scheme} initialText={original} onChange={(get) => setEdited(get() !== original)} onRun={() => void run()} />
        {error && <div className="message error">{error}</div>}
      </div>
    </Modal>
  );
}
