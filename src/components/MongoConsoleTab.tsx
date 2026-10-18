import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { api, errorMessage, type MongoOut } from "../api";
import type { ConnectionConfig } from "../api/types";
import { isQueryOp, parseMongoCommand, riskyOp, splitMongo, statementAtPos, type MongoOp } from "../mongo/console";
import { columnInfosOf, docColumns, docRows } from "../mongo/docs";
import { formatShell, ShellError } from "../mongo/shell";
import { useMongoTree } from "../mongo/store";
import { useConnections } from "../store/connections";
import { usePrefs } from "../store/prefs";
import { confirmDialog } from "../store/ui";
import type { Scheme } from "../theme";
import { runExport } from "./exportMenu";
import { ResultGrid } from "./ResultGrid";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { Splitter } from "./ui";

interface Out {
  id: number;
  cmd: string;
  db: string;
  op?: MongoOp;
  out?: MongoOut;
  error?: string;
  ms?: number;
  running?: boolean;
}

let seq = 0;

export const MongoConsoleTab = memo(function MongoConsoleTab(props: { tabId: string; cfg: ConnectionConfig; scheme: Scheme; active: boolean }) {
  const { cfg, tabId } = props;
  const editor = useRef<SqlEditorHandle>(null);
  const outRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState<string | null>(null);
  const defaultDb = useConnections((s) => s.defaultSchema[cfg.id]);
  const [db, setDb] = useState<string>("");
  const [outs, setOuts] = useState<Out[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [editorHeight, setEditorHeight] = useState(220);
  const status = useConnections((s) => s.status[cfg.id]);
  const dbs = useMongoTree((s) => s.dbs[cfg.id]);
  const pageSize = usePrefs((s) => s.pageSize);

  useEffect(() => {
    api.loadConsole(cfg.id, tabId).then((t) => setText(t ?? "db.getCollection(\"\").find({})\n"));
  }, []);
  useEffect(() => {
    if (props.active && status !== "connected" && status !== "connecting") void useConnections.getState().connect(cfg.id);
  }, [props.active]);
  useEffect(() => {
    if (status === "connected") void useMongoTree.getState().loadDbs(cfg.id);
  }, [status]);
  useEffect(() => {
    if (!db && defaultDb) setDb(defaultDb);
    else if (!db && Array.isArray(dbs) && dbs.length) setDb(dbs.find((d) => !["admin", "local", "config"].includes(d.name))?.name ?? dbs[0].name);
  }, [defaultDb, dbs]);
  useEffect(() => {
    if (props.active) editor.current?.focus();
  }, [props.active, text !== null]);
  useEffect(() => {
    outRef.current?.scrollTo({ top: outRef.current.scrollHeight });
  }, [outs.length]);

  const save = useMemo(() => {
    let t: ReturnType<typeof setTimeout> | undefined;
    return (getText: () => string) => {
      clearTimeout(t);
      t = setTimeout(() => void api.saveConsole(cfg.id, tabId, getText()), 1000);
    };
  }, []);

  const pick = (view: EditorView) => {
    const doc = view.state.doc.toString();
    const sel = view.state.selection.main;
    if (sel.from !== sel.to) return splitMongo(doc.slice(sel.from, sel.to)).map((s) => ({ ...s, from: s.from + sel.from, to: s.to + sel.from }));
    const s = statementAtPos(splitMongo(doc), sel.head);
    return s ? [s] : [];
  };

  const run = async (view: EditorView) => {
    if (running) return;
    if (!(await useConnections.getState().connect(cfg.id))) return;
    let curDb = db;
    for (const stmt of pick(view)) {
      let op: MongoOp;
      try {
        op = parseMongoCommand(stmt.text);
      } catch (e) {
        const at = e instanceof ShellError ? ` (문장의 ${e.at + 1}번째 글자)` : "";
        setOuts((o) => [...o, { id: ++seq, cmd: stmt.text, db: curDb, error: errorMessage(e) + at }]);
        return;
      }
      if (op.kind === "use") {
        curDb = op.db;
        setDb(op.db);
        setOuts((o) => [...o, { id: ++seq, cmd: stmt.text, db: op.db, out: { t: "Value", value: `switched to db ${op.db}` } }]);
        continue;
      }
      if (!curDb && op.kind !== "showDbs") {
        setOuts((o) => [...o, { id: ++seq, cmd: stmt.text, db: curDb, error: "DB를 먼저 고르세요 (use <db> 또는 위의 DB 선택)" }]);
        return;
      }
      const risk = riskyOp(op);
      if (risk && !(await confirmDialog({ title: "실행 확인", body: `${risk}\n\n${stmt.text}`, okLabel: "실행", danger: true }))) return;
      const id = ++seq;
      const execId = crypto.randomUUID();
      const t0 = performance.now();
      setOuts((o) => [...o, { id, cmd: stmt.text, db: curDb, op, running: true }]);
      setRunning(execId);
      editor.current?.markRunning({ from: stmt.from, to: stmt.to });
      try {
        const out = await api.mongoExec(cfg.id, execId, curDb, op, pageSize);
        setOuts((o) => o.map((x) => (x.id === id ? { ...x, out, running: false, ms: Math.round(performance.now() - t0) } : x)));
      } catch (e) {
        setOuts((o) => o.map((x) => (x.id === id ? { ...x, error: errorMessage(e), running: false } : x)));
        return;
      } finally {
        setRunning(null);
        editor.current?.markRunning(null);
      }
    }
  };

  const dbNames = useMemo(() => {
    const names = new Set<string>(Array.isArray(dbs) ? dbs.map((d) => d.name) : []);
    if (db) names.add(db);
    return [...names].sort();
  }, [dbs, db]);

  return (
    <>
      <div className="toolbar">
        <button className="primary" disabled={!!running} onClick={() => editor.current?.view && void run(editor.current.view)} title="커서 위치 문장 또는 선택 영역 실행 (Ctrl+Enter)">
          ▶ 실행
        </button>
        {running && (
          <button className="danger" onClick={() => void api.cancelQuery(running)}>
            ■ 중지
          </button>
        )}
        <span className="label">DB</span>
        <select value={db} onChange={(e) => setDb(e.target.value)}>
          {!db && <option value="">(선택)</option>}
          {dbNames.map((n) => (
            <option key={n} value={n}>
              {n}
            </option>
          ))}
        </select>
        <span className="spacer" />
        <button disabled={!outs.length} onClick={() => setOuts([])}>
          출력 지우기
        </button>
        {cfg.read_only && <span className="badge">READ ONLY</span>}
        <span className="label">{cfg.name}</span>
      </div>
      <div style={{ height: editorHeight, flex: "none", minHeight: 60 }}>
        {text !== null && (
          <SqlEditor
            ref={editor}
            language={[]}
            scheme={props.scheme}
            initialText={text}
            onChange={save}
            onRun={(v) => void run(v)}
            placeholder='db.users.find({ age: { $gt: 30 } }).sort({ age: -1 })  — Ctrl+Enter'
          />
        )}
      </div>
      <Splitter dir="h" size={editorHeight} onResize={setEditorHeight} min={60} max={800} />
      <div className="results redis-out" ref={outRef}>
        {outs.length === 0 && <div className="empty">mongosh 문법 일부를 지원합니다: find / aggregate / countDocuments / distinct / insert·update·delete·replace / runCommand / show dbs / use</div>}
        {outs.map((o) => (
          <OutEntry key={o.id} out={o} cfg={cfg} scheme={props.scheme} />
        ))}
      </div>
    </>
  );
});

function OutEntry({ out, cfg, scheme }: { out: Out; cfg: ConnectionConfig; scheme: Scheme }) {
  const [json, setJson] = useState(false);
  const docs = out.out?.t === "Docs" ? out.out.docs : null;
  const cols = useMemo(() => (docs ? docColumns(docs) : []), [docs]);
  const columns = useMemo(() => (docs ? columnInfosOf(cols, docs) : []), [cols]);
  const rows = useMemo(() => (docs ? docRows(docs, cols) : []), [cols]);
  const op = out.op;
  return (
    <div className="redis-entry">
      <div className="redis-cmd">
        <span className="type">{out.db}&gt;</span> <span style={{ whiteSpace: "pre-wrap" }}>{out.cmd.length > 300 ? out.cmd.slice(0, 300) + "…" : out.cmd}</span>
        <span className="spacer" />
        {out.ms !== undefined && <span className="type">{out.ms} ms</span>}
        {docs && (
          <button className="icon" onClick={() => setJson((j) => !j)}>
            {json ? "그리드로" : "JSON으로"}
          </button>
        )}
        {docs && op && isQueryOp(op) && (
          <button
            className="icon"
            title="전체 결과를 JSON Lines 파일로"
            onClick={() => void runExport(`${"coll" in op ? op.coll : "result"}.jsonl`, (execId, fileName) => api.mongoExport(cfg.id, execId, out.db, op, fileName), "개 문서를")}
          >
            ⭳ 내보내기
          </button>
        )}
      </div>
      {out.running && <div className="type">실행 중…</div>}
      {out.error && <pre className="redis-reply error">{out.error}</pre>}
      {out.out?.t === "Value" && <pre className="redis-reply">{typeof out.out.value === "string" ? out.out.value : formatShell(out.out.value, 2)}</pre>}
      {out.out?.t === "Names" && <pre className="redis-reply">{out.out.names.join("\n") || "(없음)"}</pre>}
      {out.out?.t === "Write" && (
        <pre className="redis-reply">
          {[
            out.out.matched ? `일치 ${out.out.matched}` : "",
            out.out.modified ? `변경 ${out.out.modified}` : "",
            out.out.inserted ? `추가 ${out.out.inserted}` : "",
            out.out.deleted ? `삭제 ${out.out.deleted}` : "",
            out.out.upserted ? `_id ${formatShell(out.out.upserted)}` : "",
          ]
            .filter(Boolean)
            .join(" · ") || "바뀐 문서 없음"}
        </pre>
      )}
      {docs && !json && (
        <>
          <div style={{ height: Math.min(420, 32 + Math.max(1, rows.length) * 24), display: "flex", flexDirection: "column" }}>
            <ResultGrid columns={columns} rows={rows} scheme={scheme} rowOffset={0} pkCols={cols.map((c) => c === "_id")} />
          </div>
          <div className="type">
            {docs.length}개{out.out?.t === "Docs" && out.out.has_more ? ` (처음 ${docs.length}개만 표시 · 더 보려면 skip/limit 또는 컬렉션 탭)` : ""}
          </div>
        </>
      )}
      {docs && json && <pre className="redis-reply">{docs.map((d) => formatShell(d, 2)).join("\n")}</pre>}
    </div>
  );
}
