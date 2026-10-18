import { memo, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import type { AppError, Cell, ConnectionConfig } from "../api/types";
import { PendingChanges } from "../grid/pending";
import { argOfBytes, unescapeRedis, type Arg, type Bytes } from "../redis/bytes";
import { formatCommand, splitRedisArgs } from "../redis/cli";
import { redisCommands } from "../redis/edit";
import { redisLanguage } from "../redis/language";
import { useRedisTree } from "../redis/store";
import { cellOf, columnInfos, CONTAINER_TYPES, editInfoOf, sizeText, ttlText, type RedisType } from "../redis/view";
import { usePrefs } from "../store/prefs";
import { useTabs } from "../store/tabs";
import { confirmDialog, promptDialog, toast } from "../store/ui";
import type { Scheme } from "../theme";
import { ResultGrid, type ResultGridHandle } from "./ResultGrid";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { Modal } from "./ui";

type Info = { type: string; ttl: number; memory: number | null; length: number | null };
/** 페이지: 시작 커서와 다음 커서 (SCAN 계열은 커서로만 앞으로 갈 수 있어 본 페이지를 보관한다) */
type Page = { start: string; next: string; rows: Bytes[][]; truncated: boolean };

export const RedisKeyTab = memo(function RedisKeyTab(props: { tabId: string; cfg: ConnectionConfig; db: number; keyName: string; binary?: boolean; scheme: Scheme; active: boolean }) {
  const { cfg, db } = props;
  const keyArg: Arg = props.binary ? argOfBytes(unescapeRedis(props.keyName)) : props.keyName;
  const [info, setInfo] = useState<Info | null>(null);
  const [pages, setPages] = useState<Page[]>([]);
  const [pageIdx, setPageIdx] = useState(0);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const pageSize = usePrefs((s) => s.pageSize);
  const page = pages[pageIdx];
  const type = info?.type as RedisType | undefined;

  const readPage = async (kind: string, start: string): Promise<Page> => {
    const r = await api.redisRead(cfg.id, db, keyArg, kind, start, pageSize);
    return { start, next: r.cursor, rows: r.rows, truncated: r.truncated };
  };

  /** 정보와 첫 페이지(또는 지금 페이지)를 다시 읽는다 */
  const load = async (keepPage = false) => {
    setLoading(true);
    setError(null);
    try {
      const inf = await api.redisKeyInfo(cfg.id, db, keyArg);
      setInfo(inf);
      if (inf.type === "none") {
        setPages([]);
        return;
      }
      if (inf.type === "string" || CONTAINER_TYPES.includes(inf.type as RedisType)) {
        const start = keepPage && page ? page.start : "0";
        const p = await readPage(inf.type, start);
        if (keepPage && page) setPages((ps) => [...ps.slice(0, pageIdx), p]);
        else {
          setPages([p]);
          setPageIdx(0);
        }
      } else setPages([]);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (props.active && !loaded) {
      setLoaded(true);
      void load();
    }
  }, [props.active]);

  const next = async () => {
    if (!type || !page || page.next === "0") return;
    if (pages[pageIdx + 1]) return setPageIdx(pageIdx + 1);
    setLoading(true);
    try {
      const p = await readPage(type, page.next);
      setPages((ps) => [...ps, p]);
      setPageIdx(pageIdx + 1);
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setLoading(false);
    }
  };

  // ── 키 단위 동작 ──
  const exec = (argv: Arg[]) => api.redisExec(cfg.id, null, db, crypto.randomUUID(), argv);
  const changeTtl = async () => {
    const v = await promptDialog({
      title: "TTL 변경",
      fields: [{ label: "초 (비우면 만료 없음)", value: info && info.ttl > 0 ? String(info.ttl) : "" }],
      okLabel: "적용",
    });
    if (v === null) return;
    const s = v[0].trim();
    try {
      if (s === "") await exec(["PERSIST", keyArg]);
      else if (/^\d+$/.test(s) && Number(s) > 0) await exec(["EXPIRE", keyArg, s]);
      else return toast("양의 정수(초)를 입력하세요.", "error");
      await load(true);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const rename = async () => {
    if (props.binary) return toast("바이너리 키는 콘솔에서 이름을 바꾸세요.", "error");
    const v = await promptDialog({ title: "키 이름 변경", fields: [{ label: "새 이름", value: props.keyName }], okLabel: "변경", hint: "같은 이름의 키가 있으면 바꾸지 않습니다 (RENAMENX)." });
    if (!v || !v[0] || v[0] === props.keyName) return;
    try {
      const r = await exec(["RENAMENX", keyArg, v[0]]);
      if (r.t === "Int" && r.v === 0) return toast(`이미 '${v[0]}' 키가 있습니다.`, "error");
      useRedisTree.getState().patchKey(cfg.id, db, props.keyName, { name: { t: "Text", v: v[0] }, type: info?.type ?? "string" });
      useTabs.getState().renameRedisKey(cfg.id, db, props.keyName, v[0]);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const remove = async () => {
    if (!(await confirmDialog({ title: "키 삭제", body: `db${db}의 키 '${props.keyName}'을(를) 삭제할까요?`, okLabel: "삭제", danger: true }))) return;
    try {
      await api.redisDeleteKey(cfg.id, db, keyArg);
      useRedisTree.getState().patchKey(cfg.id, db, props.keyName, null);
      useTabs.getState().renameRedisKey(cfg.id, db, props.keyName, null);
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };

  return (
    <>
      <div className="toolbar">
        <button disabled={loading} onClick={() => void load(true)} title="다시 읽기">
          ⟳ 새로고침
        </button>
        {info && info.type !== "none" && (
          <>
            <span className={`key-type t-${info.type}`}>{info.type.toUpperCase()}</span>
            <button className="icon" disabled={cfg.read_only} onClick={changeTtl} title="TTL 변경 (EXPIRE / PERSIST)">
              ⏱ {ttlText(info.ttl)}
            </button>
            <span className="label">{info.length != null ? `${info.type === "string" ? "길이" : "원소"} ${info.length.toLocaleString()}` : ""}</span>
            <span className="label">메모리 {sizeText(info.memory)}</span>
          </>
        )}
        <span className="spacer" />
        <button disabled={cfg.read_only || !info || info.type === "none"} onClick={rename}>
          이름 변경…
        </button>
        <button className="danger" disabled={cfg.read_only || !info || info.type === "none"} onClick={remove}>
          삭제
        </button>
      </div>
      <div className="results">
        {error && <div className="message error">{error}</div>}
        {!error && info?.type === "none" && <div className="empty">키가 없습니다 (삭제됐거나 만료됨)</div>}
        {!error && info && type === "string" && page && <StringValue key={page.start + pages.length} cfg={cfg} db={db} keyArg={keyArg} info={info} page={page} scheme={props.scheme} reload={() => load(true)} />}
        {!error && info && type && type !== "string" && page && (
          <ContainerValue
            key={`${type}|${pageIdx}|${page.rows.length}|${page.start}|${pages.length}`}
            tabId={props.tabId}
            cfg={cfg}
            db={db}
            keyArg={keyArg}
            info={info}
            type={type}
            page={page}
            pageIdx={pageIdx}
            pageSize={pageSize}
            scheme={props.scheme}
            loading={loading}
            onPrev={() => setPageIdx((i) => Math.max(0, i - 1))}
            onNext={() => void next()}
            reload={() => load(true)}
          />
        )}
        {!error && info && type && !["string", ...CONTAINER_TYPES].includes(type) && (
          <div className="empty">{info.type} 타입은 콘솔에서 다루세요 (예: JSON.GET)</div>
        )}
        {!info && !error && <div className="empty">불러오는 중…</div>}
      </div>
    </>
  );
});

// ── string ──────────────────────────────────────────────

function StringValue(props: { cfg: ConnectionConfig; db: number; keyArg: Arg; info: Info; page: Page; scheme: Scheme; reload: () => void }) {
  const v = props.page.rows[0]?.[0];
  const original = v?.t === "Text" ? v.v : null;
  const [text, setText] = useState(original ?? "");
  const [preview, setPreview] = useState<Arg[][] | null>(null);
  const editable = original !== null && !props.page.truncated && !props.cfg.read_only;
  const dirty = editable && text !== original;
  const isJson = useMemo(() => {
    try {
      const j = JSON.parse(text);
      return typeof j === "object" && j !== null;
    } catch {
      return false;
    }
  }, [text]);
  return (
    <>
      <div className="toolbar">
        {props.page.truncated && <span className="label">⚠ 값이 커서 앞부분 4MB만 보입니다 (편집 불가)</span>}
        {v?.t === "Bin" && <span className="label">바이너리 값 (redis-cli 표기로 보기만)</span>}
        <button disabled={!isJson || !editable} onClick={() => setText(JSON.stringify(JSON.parse(text), null, 2))}>
          JSON 정렬
        </button>
        <span className="spacer" />
        <button disabled={!dirty} onClick={() => setText(original ?? "")}>
          되돌리기
        </button>
        <button className="primary" disabled={!dirty} onClick={() => setPreview([["SET", props.keyArg, text, "KEEPTTL"]])}>
          Submit…
        </button>
      </div>
      <textarea
        className="string-value"
        spellCheck={false}
        readOnly={!editable}
        value={v?.t === "Bin" ? `"${v.v}"` : text}
        onChange={(e) => setText(e.target.value)}
      />
      {preview && (
        <RedisSubmitPreview
          cfg={props.cfg}
          db={props.db}
          keyArg={props.keyArg}
          expect={{ type: "string", length: props.info.length }}
          commands={preview}
          scheme={props.scheme}
          onClose={() => setPreview(null)}
          onDone={() => {
            setPreview(null);
            props.reload();
          }}
        />
      )}
    </>
  );
}

// ── hash / list / set / zset / stream ───────────────────

function ContainerValue(props: {
  tabId: string;
  cfg: ConnectionConfig;
  db: number;
  keyArg: Arg;
  info: Info;
  type: Exclude<RedisType, "string">;
  page: Page;
  pageIdx: number;
  pageSize: number;
  scheme: Scheme;
  loading: boolean;
  onPrev: () => void;
  onNext: () => void;
  reload: () => void;
}) {
  const { type, page } = props;
  const columns = useMemo(() => columnInfos(type), [type]);
  const rows: Cell[][] = useMemo(() => page.rows.map((r) => r.map(cellOf)), [page]);
  const info = props.cfg.read_only || type === "stream" ? null : editInfoOf(type);
  const pending = useMemo(() => new PendingChanges(rows, columns.length), [rows]);
  const [version, setVersion] = useState(0);
  const [preview, setPreview] = useState<Arg[][] | null>(null);
  const [selRows, setSelRows] = useState(0);
  const gridRef = useRef<ResultGridHandle>(null);
  const dirty = !pending.isEmpty;

  useEffect(() => {
    useTabs.getState().setDirty(props.tabId, "edit", dirty ? `제출하지 않은 변경 ${pending.count}개가 있습니다.` : null);
  }, [dirty, version, pending]);
  useEffect(() => () => useTabs.getState().setDirty(props.tabId, "edit", null), []);

  const submit = () => {
    if (!info || pending.isEmpty || type === "stream") return;
    try {
      setPreview(redisCommands(type, props.keyArg, pending));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const guard = async () => !dirty || (await confirmDialog({ title: "변경 버리기", body: `제출하지 않은 변경 ${pending.count}개를 버릴까요?`, okLabel: "버리기", danger: true }));
  const edit = useMemo(
    () => (info ? { info, pending, changed: () => setVersion((v) => v + 1), submit, errorRow: null } : undefined),
    [info, pending],
  );
  const from = props.type === "list" ? Number(page.start) + 1 : props.pageIdx * props.pageSize + 1;

  return (
    <>
      <div className="toolbar" style={{ minHeight: 28 }}>
        <button disabled={props.loading} onClick={async () => (await guard()) && props.reload()}>
          ⟳ 새로고침
        </button>
        {info && (
          <>
            <button onClick={() => gridRef.current?.addRow()} title="추가 (Alt+Insert)">
              ＋ 추가
            </button>
            <button disabled={!selRows} onClick={() => gridRef.current?.deleteRows()} title="선택한 항목 삭제 (Ctrl+Delete)">
              － 삭제
            </button>
          </>
        )}
        {!info && <span className="label">🔒 {props.cfg.read_only ? "읽기 전용 접속" : "보기 전용 (추가·삭제는 콘솔에서)"}</span>}
        <span className="spacer" />
        {dirty && <span className="label">변경 {pending.count}개</span>}
        {info && (
          <>
            <button
              disabled={!dirty}
              onClick={() => {
                pending.revertAll();
                setVersion((v) => v + 1);
              }}
            >
              되돌리기
            </button>
            <button className="primary" disabled={!dirty} onClick={submit} title="실행할 명령 미리보기 후 반영 (그리드에서 Ctrl+Enter)">
              Submit…
            </button>
          </>
        )}
      </div>
      <ResultGrid
        ref={gridRef}
        columns={columns}
        rows={rows}
        scheme={props.scheme}
        rowOffset={from - 1}
        version={version}
        edit={edit}
        onSelectedRows={setSelRows}
      />
      <div className="statusbar">
        <span>{type === "hash" || type === "set" || type === "zset" ? "SCAN 순서 (정렬되지 않음)" : ""}</span>
        <span className="spacer" />
        <button className="icon" disabled={props.loading || props.pageIdx === 0} onClick={async () => (await guard()) && props.onPrev()} title="이전 페이지">
          ◀
        </button>
        <span>
          {page.rows.length ? `${from.toLocaleString()}–${(from + page.rows.length - 1).toLocaleString()}` : "0"} / {props.info.length?.toLocaleString() ?? "?"}
        </span>
        <button className="icon" disabled={props.loading || page.next === "0"} onClick={async () => (await guard()) && props.onNext()} title="다음 페이지">
          ▶
        </button>
      </div>
      {preview && (
        <RedisSubmitPreview
          cfg={props.cfg}
          db={props.db}
          keyArg={props.keyArg}
          expect={{ type, length: props.info.length }}
          commands={preview}
          scheme={props.scheme}
          onClose={() => setPreview(null)}
          onDone={() => {
            setPreview(null);
            props.reload();
          }}
        />
      )}
    </>
  );
}

// ── 명령 미리보기 ───────────────────────────────────────

/** 실행할 명령을 redis-cli 형식으로 보여 주고, 고쳐서 실행할 수 있다. WATCH + MULTI/EXEC로 한 번에 보낸다. */
export function RedisSubmitPreview(props: {
  cfg: ConnectionConfig;
  db: number;
  keyArg: Arg;
  expect: { type: string; length: number | null };
  commands: Arg[][];
  scheme: Scheme;
  onDone: () => void;
  onClose: () => void;
}) {
  const original = useMemo(() => props.commands.map(formatCommand).join("\n"), [props.commands]);
  const editor = useRef<SqlEditorHandle>(null);
  const [edited, setEdited] = useState(false);
  const [running, setRunning] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const run = async () => {
    if (running) return;
    setError(null);
    let cmds: Arg[][];
    try {
      const text = editor.current?.getText() ?? original;
      cmds = text === original ? props.commands : text.split("\n").filter((l) => l.trim() && !l.trim().startsWith("#")).map(splitRedisArgs);
    } catch (e) {
      return setError(`명령을 해석하지 못했습니다: ${errorMessage(e)}`);
    }
    if (!cmds.length) return setError("실행할 명령이 없습니다.");
    setRunning(true);
    try {
      const n = await api.redisSubmit(props.cfg.id, props.db, props.keyArg, props.expect, cmds);
      toast(`${n}개 명령을 반영했습니다.`);
      props.onDone();
    } catch (e) {
      const err = e as AppError;
      setError(errorMessage(e));
      // 일부 명령이 반영됐을 수 있으므로 다시 읽게 한다
      if (err?.kind === "submit") props.onDone();
    } finally {
      setRunning(false);
    }
  };

  return (
    <Modal
      title={`변경 반영 미리보기 · ${props.commands.length}개 명령`}
      onClose={() => !running && props.onClose()}
      width={760}
      footer={
        <>
          <span className="hint" style={{ flex: 1 }}>
            MULTI/EXEC로 한 번에 보냅니다. 다른 곳에서 키가 바뀌었으면 반영하지 않습니다. Redis는 실패한 명령이 있어도 롤백하지 않습니다.
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
        <SqlEditor
          ref={editor}
          language={redisLanguage}
          scheme={props.scheme}
          initialText={original}
          onChange={(get) => setEdited(get() !== original)}
          onRun={() => void run()}
        />
        {error && <div className="message error">{error}</div>}
      </div>
    </Modal>
  );
}
