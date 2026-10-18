import { memo, useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage } from "../api";
import type { Cell, ConnectionConfig } from "../api/types";
import { PendingChanges } from "../grid/pending";
import type { MongoOp } from "../mongo/console";
import { columnInfosOf, docColumns, docRows, mongoEditInfo, mongoOps, MISSING, UNSET } from "../mongo/docs";
import { formatShell, parseShellValue, ShellError, type EJson } from "../mongo/shell";
import { usePrefs } from "../store/prefs";
import { useTabs } from "../store/tabs";
import { confirmDialog, toast } from "../store/ui";
import type { Scheme } from "../theme";
import { runExport } from "./exportMenu";
import { MongoSubmitPreview } from "./MongoSubmitPreview";
import { ResultGrid, type GridApi, type ResultGridHandle } from "./ResultGrid";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";
import { Modal, showContextMenu, type MenuEntry } from "./ui";

/** 입력란 텍스트 → Canonical EJSON 문자열 (빈 칸은 빈 객체) */
function ejsonText(text: string, what: string): string {
  try {
    const v = parseShellValue(text);
    if (v !== null && (typeof v !== "object" || Array.isArray(v))) throw new Error(`${what}는 객체({…})여야 합니다`);
    return v === null ? "" : JSON.stringify(v);
  } catch (e) {
    throw new Error(`${what}: ${errorMessage(e)}${e instanceof ShellError ? ` (${e.at + 1}번째 글자)` : ""}`);
  }
}

type Sort = { field: string; dir: 1 | -1 } | null;

interface Result {
  docs: EJson[];
  hasMore: boolean;
  skip: number;
  ms: number;
}

/** 컬렉션 탭: Filter / Sort / Projection으로 조회하고, 그리드 ↔ JSON으로 보고, 편집한다 */
export const MongoCollTab = memo(function MongoCollTab(props: { tabId: string; cfg: ConnectionConfig; db: string; coll: string; scheme: Scheme; active: boolean }) {
  const { cfg, db, coll } = props;
  const filterRef = useRef<SqlEditorHandle>(null);
  const sortRef = useRef<SqlEditorHandle>(null);
  const projRef = useRef<SqlEditorHandle>(null);
  const gridRef = useRef<ResultGridHandle>(null);
  const [res, setRes] = useState<Result | null>(null);
  const [total, setTotal] = useState<number | null>(null);
  const [counting, setCounting] = useState(false);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [loaded, setLoaded] = useState(false);
  const [view, setView] = useState<"grid" | "json">("grid");
  const [sort, setSort] = useState<Sort>(null);
  const [version, setVersion] = useState(0);
  const [selRows, setSelRows] = useState(0);
  const [preview, setPreview] = useState<MongoOp[] | null>(null);
  const [docEdit, setDocEdit] = useState<{ row: number; text: string } | null>(null);
  const pageSize = usePrefs((s) => s.pageSize);

  const docs = res?.docs ?? [];
  const cols = useMemo(() => docColumns(docs), [res]);
  const columns = useMemo(() => columnInfosOf(cols, docs), [cols]);
  const rows = useMemo(() => docRows(docs, cols), [cols]);
  const editState = useMemo(() => (cfg.read_only ? { reason: "읽기 전용 접속" } : mongoEditInfo(cols, docs)), [cols]);
  const info = "colMeta" in editState ? editState : null;
  const pending = useMemo(() => new PendingChanges(rows, cols.length), [rows]);
  const dirty = !pending.isEmpty;

  useEffect(() => {
    useTabs.getState().setDirty(props.tabId, "edit", dirty ? `제출하지 않은 변경 ${pending.count}개가 있습니다.` : null);
  }, [dirty, version, pending]);
  useEffect(() => () => useTabs.getState().setDirty(props.tabId, "edit", null), []);

  const inputs = () => ({
    filter: ejsonText(filterRef.current?.getText() ?? "", "Filter"),
    sort: ejsonText(sortRef.current?.getText() ?? "", "Sort"),
    projection: ejsonText(projRef.current?.getText() ?? "", "Projection"),
  });

  const guard = async () => !dirty || (await confirmDialog({ title: "변경 버리기", body: `제출하지 않은 변경 ${pending.count}개를 버릴까요?`, okLabel: "버리기", danger: true }));

  const load = async (skip: number, opts?: { force?: boolean }) => {
    if (loading) return;
    if (!opts?.force && !(await guard())) return;
    let q;
    try {
      q = inputs();
    } catch (e) {
      return setError(errorMessage(e));
    }
    setLoading(true);
    setError(null);
    const t0 = performance.now();
    try {
      const r = await api.mongoFind({ connId: cfg.id, execId: crypto.randomUUID(), db, coll, ...q, skip, limit: pageSize });
      setRes({ docs: r.docs, hasMore: r.has_more, skip, ms: Math.round(performance.now() - t0) });
      if (skip === 0) setTotal(null);
    } catch (e) {
      setError(errorMessage(e));
    } finally {
      setLoading(false);
    }
  };

  useEffect(() => {
    if (props.active && !loaded) {
      setLoaded(true);
      void load(0, { force: true });
    }
  }, [props.active]);

  const count = async () => {
    setCounting(true);
    try {
      setTotal(await api.mongoCount(cfg.id, db, coll, inputs().filter));
    } catch (e) {
      toast(errorMessage(e), "error");
    } finally {
      setCounting(false);
    }
  };

  // 헤더 클릭: 오름차순 → 내림차순 → 해제 (한 필드)
  const onHeaderClicked = (col: number) => {
    const field = cols[col];
    const next: Sort = sort?.field !== field ? { field, dir: 1 } : sort.dir === 1 ? { field, dir: -1 } : null;
    setSort(next);
    sortRef.current?.setText(next ? `{ ${/^[A-Za-z_$][\w$]*$/.test(field) ? field : JSON.stringify(field)}: ${next.dir} }` : "");
    void load(0);
  };
  const headerSuffix = (col: number) => (sort?.field === cols[col] ? (sort.dir === 1 ? " ▲" : " ▼") : "");

  const submit = () => {
    if (!info || pending.isEmpty) return;
    try {
      setPreview(mongoOps(coll, docs, cols, pending));
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const edit = useMemo(
    () => (info ? { info, pending, changed: () => setVersion((v) => v + 1), submit, errorRow: null, canEditOriginal: (c: Cell) => c.t !== "Blob" } : undefined),
    [info, pending],
  );

  // 문서 전체 JSON 편집 → replaceOne(원본 문서 전체, 새 문서)
  const openDocEdit = (row: number) => {
    if (!info) return;
    if (pending.edits.has(row) || pending.deleted.has(row)) return toast("이 문서에 보류 중인 변경이 있습니다. 먼저 Submit하거나 되돌리세요.", "error");
    setDocEdit({ row, text: formatShell(docs[row], 2) });
  };
  const applyDocEdit = (text: string) => {
    if (!docEdit) return;
    let doc: EJson;
    try {
      doc = parseShellValue(text);
    } catch (e) {
      return toast(`문서를 해석하지 못했습니다: ${errorMessage(e)}`, "error");
    }
    const orig = docs[docEdit.row] as Record<string, EJson>;
    if (!doc || typeof doc !== "object" || Array.isArray(doc)) return toast("문서는 객체여야 합니다.", "error");
    if (JSON.stringify((doc as Record<string, EJson>)._id) !== JSON.stringify(orig._id)) return toast("_id는 바꿀 수 없습니다.", "error");
    setDocEdit(null);
    setPreview([{ kind: "replaceOne", coll, filter: orig, doc, upsert: false }]);
  };

  const menuItems = (g: GridApi): MenuEntry[] => {
    const row = g.range?.y ?? g.rows[0];
    const items: MenuEntry[] = [];
    if (info) {
      items.push(
        { label: "문서 편집…", onClick: () => openDocEdit(row), disabled: row === undefined || row >= docs.length },
        { label: "필드 삭제 ($unset)", onClick: () => gridRef.current?.fill(UNSET), disabled: !g.range },
        "sep",
      );
    }
    items.push(...copyItems(g));
    return items;
  };

  const copyItems = (g: GridApi): MenuEntry[] => {
    const selRowsIdx = g.rows.length ? g.rows : g.range ? Array.from({ length: g.range.height }, (_, i) => g.range!.y + i) : docs.map((_, i) => i);
    const scope = g.rows.length || g.range ? "선택" : "현재 페이지";
    const copy = async (text: string, what: string) => {
      try {
        await navigator.clipboard.writeText(text);
        toast(`${what}(으)로 복사했습니다.`);
      } catch (e) {
        toast(`복사 실패: ${errorMessage(e)}`, "error");
      }
    };
    const tsv = () => {
      const lines = [cols.join("\t"), ...selRowsIdx.filter((r) => r < rows.length).map((r) => rows[r].map(cellText).join("\t"))];
      return lines.join("\r\n");
    };
    return [
      { label: `복사: TSV (${scope} 문서, 헤더 포함)`, onClick: () => void copy(tsv(), "TSV") },
      { label: `복사: JSON (${scope} 문서, mongosh 표기)`, onClick: () => void copy(`[\n${selRowsIdx.filter((r) => r < docs.length).map((r) => formatShell(docs[r], 2)).join(",\n")}\n]`, "JSON") },
    ];
  };

  const exportJsonl = async () => {
    let q;
    try {
      q = inputs();
    } catch (e) {
      return toast(errorMessage(e), "error");
    }
    const op: MongoOp = {
      kind: "find",
      coll,
      filter: q.filter ? JSON.parse(q.filter) : {},
      sort: q.sort ? JSON.parse(q.sort) : {},
      projection: q.projection ? JSON.parse(q.projection) : {},
      skip: 0,
      limit: null,
    };
    await runExport(`${coll}.jsonl`, (execId, fileName) => api.mongoExport(cfg.id, execId, db, op, fileName), "개 문서를");
  };

  const filterKeys = [{ key: "Enter", run: () => (void load(0), true) }];
  const from = (res?.skip ?? 0) + 1;

  return (
    <>
      <div className="toolbar">
        <span className="label">
          {db}.{coll}
        </span>
        <span className="spacer" />
        {cfg.read_only && <span className="badge">READ ONLY</span>}
        <span className="label">{cfg.name}</span>
      </div>
      <div className="toolbar filter-bar">
        <span className="label">Filter</span>
        <div className="filter-input">
          <SqlEditor ref={filterRef} singleLine language={[]} scheme={props.scheme} initialText="" placeholder='{ age: { $gt: 30 } }  (Enter로 적용)' extraKeys={filterKeys} />
        </div>
        <span className="label">Sort</span>
        <div className="filter-input" style={{ flex: "0 1 20%" }}>
          <SqlEditor ref={sortRef} singleLine language={[]} scheme={props.scheme} initialText="" placeholder="{ _id: -1 }" extraKeys={filterKeys} />
        </div>
        <span className="label">Projection</span>
        <div className="filter-input" style={{ flex: "0 1 20%" }}>
          <SqlEditor ref={projRef} singleLine language={[]} scheme={props.scheme} initialText="" placeholder="{ name: 1 }" extraKeys={filterKeys} />
        </div>
      </div>
      <div className="toolbar" style={{ minHeight: 28 }}>
        <button disabled={loading} onClick={() => void load(res?.skip ?? 0)}>
          ⟳ 새로고침
        </button>
        {info && view === "grid" && (
          <>
            <button onClick={() => gridRef.current?.addRow()} title="새 문서 (Alt+Insert)">
              ＋ 추가
            </button>
            <button disabled={!selRows} onClick={() => gridRef.current?.deleteRows()} title="선택한 문서 삭제 (Ctrl+Delete)">
              － 삭제
            </button>
          </>
        )}
        <span className="toolbar-sep" />
        <button onClick={(e) => gridRef.current && showContextMenu(below(e), copyItems(gridRef.current.api()))} disabled={!docs.length}>
          ⧉ 복사 ▾
        </button>
        <button onClick={() => void exportJsonl()} title="조건에 맞는 전체 문서를 JSON Lines 파일로 (mongoimport 호환)">
          ⭳ JSON Lines 내보내기
        </button>
        <button onClick={() => setView((v) => (v === "grid" ? "json" : "grid"))} title="그리드 / 문서별 JSON 보기">
          {view === "grid" ? "{ } JSON 보기" : "▦ 그리드 보기"}
        </button>
        {!info && <span className="label">🔒 {"reason" in editState ? editState.reason : ""}</span>}
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
            <button className="primary" disabled={!dirty} onClick={submit} title="실행할 작업 미리보기 후 반영 (그리드에서 Ctrl+Enter)">
              Submit…
            </button>
          </>
        )}
      </div>
      <div className="results">
        {error && <div className="message error">{error}</div>}
        {!res && !error && <div className="empty">불러오는 중…</div>}
        {res && view === "grid" && (
          <ResultGrid
            ref={gridRef}
            key={res.skip + ":" + res.ms}
            columns={columns}
            rows={rows}
            scheme={props.scheme}
            rowOffset={res.skip}
            version={version}
            edit={edit}
            onHeaderClicked={(c) => onHeaderClicked(c)}
            headerSuffix={headerSuffix}
            pkCols={cols.map((c) => c === "_id")}
            onSelectedRows={setSelRows}
            menuItems={menuItems}
          />
        )}
        {res && view === "json" && (
          <div className="json-docs">
            {docs.map((d, i) => (
              <div key={i} className="json-doc">
                <div className="json-doc-head">
                  <span className="type">{(res.skip + i + 1).toLocaleString()}</span>
                  <span className="spacer" />
                  {info && (
                    <button className="icon" onClick={() => openDocEdit(i)}>
                      편집…
                    </button>
                  )}
                </div>
                <pre>{formatShell(d, 2)}</pre>
              </div>
            ))}
            {!docs.length && <div className="empty">문서 없음</div>}
          </div>
        )}
        {res && (
          <div className="statusbar">
            <span>{res.ms} ms</span>
            <span className="spacer" />
            <button className="icon" disabled={loading || res.skip === 0} onClick={() => void load(Math.max(0, res.skip - pageSize))} title="이전 페이지">
              ◀
            </button>
            <span>
              {docs.length ? `${from.toLocaleString()}–${(from + docs.length - 1).toLocaleString()}` : "0"} / {total?.toLocaleString() ?? (res.hasMore ? "?" : (res.skip + docs.length).toLocaleString())}
            </span>
            <button className="icon" disabled={loading || !res.hasMore} onClick={() => void load(res.skip + pageSize)} title="다음 페이지">
              ▶
            </button>
            <button className="icon" disabled={counting} onClick={() => void count()} title="조건에 맞는 문서 수 (countDocuments)">
              {counting ? "세는 중…" : "Σ 문서 수"}
            </button>
          </div>
        )}
      </div>
      {docEdit && <DocEditor initial={docEdit.text} scheme={props.scheme} onCancel={() => setDocEdit(null)} onApply={applyDocEdit} />}
      {preview && (
        <MongoSubmitPreview
          cfg={cfg}
          db={db}
          ops={preview}
          scheme={props.scheme}
          onClose={() => setPreview(null)}
          onDone={() => {
            setPreview(null);
            void load(res?.skip ?? 0, { force: true });
          }}
        />
      )}
    </>
  );
});

const cellText = (c: Cell) => (c.t === "Text" ? c.v : c.t === "Null" ? "null" : c === MISSING ? "" : String(c.v));

const below = (e: React.MouseEvent<HTMLElement>) => {
  const b = e.currentTarget.getBoundingClientRect();
  return { clientX: b.left, clientY: b.bottom + 2 };
};

function DocEditor(props: { initial: string; scheme: Scheme; onCancel: () => void; onApply: (text: string) => void }) {
  const ref = useRef<SqlEditorHandle>(null);
  return (
    <Modal
      title="문서 편집"
      onClose={props.onCancel}
      width={760}
      footer={
        <>
          <span className="hint" style={{ flex: 1 }}>
            mongosh 표기로 고친 뒤 다음을 누르면 replaceOne 미리보기가 열립니다. _id는 바꿀 수 없습니다.
          </span>
          <button onClick={props.onCancel}>취소</button>
          <button className="primary" onClick={() => props.onApply(ref.current?.getText() ?? props.initial)}>
            다음 (Ctrl+Enter)
          </button>
        </>
      }
    >
      <div className="submit-preview">
        <SqlEditor ref={ref} language={[]} scheme={props.scheme} initialText={props.initial} onRun={(v) => props.onApply(v.state.doc.toString())} />
      </div>
    </Modal>
  );
}
