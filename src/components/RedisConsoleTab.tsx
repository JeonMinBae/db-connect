import { memo, useEffect, useMemo, useRef, useState } from "react";
import type { EditorView } from "@codemirror/view";
import { api, errorMessage } from "../api";
import type { Cell, ConnectionConfig } from "../api/types";
import { formatCommand, riskyCommand, splitRedisArgs } from "../redis/cli";
import { redisLanguage } from "../redis/language";
import { renderReply, replyRows, type Reply } from "../redis/reply";
import { useRedisTree } from "../redis/store";
import { useConnections } from "../store/connections";
import { confirmDialog } from "../store/ui";
import type { Scheme } from "../theme";
import { ResultGrid } from "./ResultGrid";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { Splitter } from "./ui";

interface Out {
  id: number;
  cmd: string;
  db: number;
  reply?: Reply;
  error?: string;
  ms?: number;
  running?: boolean;
}

/** 커서 줄 또는 선택한 줄들 (빈 줄과 # 주석 제외) */
function pickLines(view: EditorView): { text: string; from: number; to: number }[] {
  const s = view.state;
  const sel = s.selection.main;
  const a = s.doc.lineAt(sel.from).number;
  const b = s.doc.lineAt(sel.to).number;
  const out = [];
  for (let n = a; n <= b; n++) {
    const l = s.doc.line(n);
    if (l.text.trim() && !l.text.trim().startsWith("#")) out.push({ text: l.text, from: l.from, to: l.to });
  }
  return out;
}

let seq = 0;

export const RedisConsoleTab = memo(function RedisConsoleTab(props: { tabId: string; cfg: ConnectionConfig; scheme: Scheme; active: boolean }) {
  const { cfg, tabId } = props;
  const editor = useRef<SqlEditorHandle>(null);
  const outRef = useRef<HTMLDivElement>(null);
  const [text, setText] = useState<string | null>(null);
  const [db, setDb] = useState(cfg.redis_db);
  const [outs, setOuts] = useState<Out[]>([]);
  const [running, setRunning] = useState<string | null>(null);
  const [editorHeight, setEditorHeight] = useState(200);
  const status = useConnections((s) => s.status[cfg.id]);
  const dbs = useRedisTree((s) => s.dbs[cfg.id]);

  useEffect(() => {
    api.loadConsole(cfg.id, tabId).then((t) => setText(t ?? "PING\n"));
  }, []);
  useEffect(() => {
    if (props.active && status !== "connected" && status !== "connecting") void useConnections.getState().connect(cfg.id);
  }, [props.active]);
  useEffect(() => {
    if (props.active) editor.current?.focus();
  }, [props.active, text !== null]);
  // 탭을 닫으면 전용 연결을 정리한다
  useEffect(() => () => void api.redisCloseConsole(cfg.id, tabId).catch(() => {}), []);
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

  const run = async (view: EditorView) => {
    if (running) return;
    if (!(await useConnections.getState().connect(cfg.id))) return;
    const lines = pickLines(view);
    for (const line of lines) {
      let argv;
      try {
        argv = splitRedisArgs(line.text);
      } catch (e) {
        setOuts((o) => [...o, { id: ++seq, cmd: line.text, db, error: errorMessage(e) }]);
        return;
      }
      if (!argv.length) continue;
      const name = typeof argv[0] === "string" ? argv[0].toUpperCase() : "";
      if (name === "SELECT" && typeof argv[1] === "string" && /^\d+$/.test(argv[1])) {
        // SELECT는 콘솔의 DB 선택으로 처리한다 (전용 연결을 새 DB로 다시 연다)
        setDb(Number(argv[1]));
        setOuts((o) => [...o, { id: ++seq, cmd: line.text, db: Number(argv[1]), reply: { t: "Status", v: "OK" } }]);
        continue;
      }
      if (["MONITOR", "SUBSCRIBE", "PSUBSCRIBE", "SSUBSCRIBE"].includes(name)) {
        setOuts((o) => [...o, { id: ++seq, cmd: line.text, db, error: `${name}은(는) 콘솔에서 지원하지 않습니다.` }]);
        continue;
      }
      const risk = riskyCommand(argv);
      if (risk && !(await confirmDialog({ title: `${name} 실행`, body: `${risk}\n\n${formatCommand(argv)}`, okLabel: "실행", danger: true }))) return;
      const id = ++seq;
      const execId = crypto.randomUUID();
      const started = performance.now();
      setOuts((o) => [...o, { id, cmd: line.text, db, running: true }]);
      setRunning(execId);
      editor.current?.markRunning({ from: line.from, to: line.to });
      try {
        const reply = await api.redisExec(cfg.id, tabId, db, execId, argv);
        setOuts((o) => o.map((x) => (x.id === id ? { ...x, reply, running: false, ms: Math.round(performance.now() - started) } : x)));
      } catch (e) {
        setOuts((o) => o.map((x) => (x.id === id ? { ...x, error: errorMessage(e), running: false } : x)));
        return;
      } finally {
        setRunning(null);
        editor.current?.markRunning(null);
      }
    }
  };

  const dbOptions = useMemo(() => {
    const set = new Set<number>([db, cfg.redis_db, ...(Array.isArray(dbs) ? dbs.map((d) => d.db) : []), ...Array.from({ length: 16 }, (_, i) => i)]);
    return [...set].sort((a, b) => a - b);
  }, [dbs, db]);

  return (
    <>
      <div className="toolbar">
        <button className="primary" disabled={!!running} onClick={() => editor.current?.view && void run(editor.current.view)} title="커서 줄 또는 선택한 줄 실행 (Ctrl+Enter)">
          ▶ 실행
        </button>
        {running && (
          <button className="danger" onClick={() => void api.cancelQuery(running)}>
            ■ 중지
          </button>
        )}
        <span className="label">DB</span>
        <select value={db} onChange={(e) => setDb(Number(e.target.value))}>
          {dbOptions.map((n) => (
            <option key={n} value={n}>
              db{n}
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
            language={redisLanguage}
            scheme={props.scheme}
            initialText={text}
            onChange={save}
            onRun={(v) => void run(v)}
            placeholder="명령을 한 줄에 하나씩 적고 Ctrl+Enter (예: HGETALL user:1)"
          />
        )}
      </div>
      <Splitter dir="h" size={editorHeight} onResize={setEditorHeight} min={60} max={800} />
      <div className="results redis-out" ref={outRef}>
        {outs.length === 0 && <div className="empty">실행 결과가 여기에 쌓입니다</div>}
        {outs.map((o) => (
          <OutEntry key={o.id} out={o} scheme={props.scheme} />
        ))}
      </div>
    </>
  );
});

function OutEntry({ out, scheme }: { out: Out; scheme: Scheme }) {
  const [grid, setGrid] = useState(false);
  const table = out.reply ? replyRows(out.reply) : null;
  const rows: Cell[][] = useMemo(() => table?.rows.map((r) => r.map((v) => ({ t: "Text", v }) as Cell)) ?? [], [table?.rows.length, out.reply]);
  return (
    <div className="redis-entry">
      <div className="redis-cmd">
        <span className="type">db{out.db}&gt;</span> {out.cmd}
        <span className="spacer" />
        {out.ms !== undefined && <span className="type">{out.ms} ms</span>}
        {table && (
          <button className="icon" onClick={() => setGrid((g) => !g)}>
            {grid ? "텍스트로" : `그리드로 (${table.rows.length})`}
          </button>
        )}
      </div>
      {out.running && <div className="type">실행 중…</div>}
      {out.error && <pre className="redis-reply error">{out.error}</pre>}
      {out.reply && !grid && <pre className={`redis-reply${out.reply.t === "Error" ? " error" : ""}`}>{renderReply(out.reply)}</pre>}
      {out.reply && grid && table && (
        <div style={{ height: Math.min(400, 30 + rows.length * 24), display: "flex", flexDirection: "column" }}>
          <ResultGrid columns={table.columns.map((name) => ({ name, type_name: "text" }))} rows={rows} scheme={scheme} rowOffset={0} />
        </div>
      )}
    </div>
  );
}
