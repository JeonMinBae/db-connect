import { useEffect, useMemo, useRef, useState } from "react";
import { api, errorMessage, type SubmitReq } from "../api";
import type { ColumnMeta, SqlConfig } from "../api/types";
import { PendingChanges } from "../grid/pending";
import type { SelStats } from "../grid/selStats";
import { clientOrder, cycleSort, sortSuffix, type SortKey } from "../grid/sort";
import { buildSubmit, rowKey } from "../grid/submit";
import type { ResultEntry, useRunner } from "../grid/useRunner";
import { resolveEdit, type EditInfo } from "../sql/editable";
import { useConnections } from "../store/connections";
import { useTabs } from "../store/tabs";
import { useTree } from "../store/tree";
import { manualOf, useTx } from "../store/tx";
import { confirmDialog, toast } from "../store/ui";
import type { Scheme } from "../theme";
import { canExportCsv, copyMenuItems, exportCsvOf, exportMenuItems } from "./exportMenu";
import { PagingBar } from "./ResultPanel";
import { ResultGrid, type ResultGridHandle } from "./ResultGrid";
import { SubmitPreview } from "./SubmitPreview";
import { showContextMenu } from "./ui";

type Runner = ReturnType<typeof useRunner>;

export interface ResultCtx {
  cfg: SqlConfig;
  tabId: string;
  consoleId: string | null;
  /** 헤더 정렬 (테이블 뷰는 서버 정렬, 없으면 현재 페이지만 클라이언트 정렬) */
  onHeaderClicked?: (col: number, shift: boolean) => void;
  headerSuffix?: (col: number) => string;
}

export const pendingMessage = (n: number) => `제출하지 않은 변경 ${n}개가 있습니다.`;

/** 결과 그리드 + (가능하면) 편집 툴바. 페이지를 바꾸면 보류 변경을 버릴지 묻는다. */
export function EditableResult({ entry, runner, scheme, ctx }: { entry: ResultEntry; runner: Runner; scheme: Scheme; ctx: ResultCtx }) {
  const r = entry.result!;
  const target = entry.stmt.target;
  // 편집 대상 테이블 (단일 테이블 결과일 때만)
  const table = target && !("reason" in target) ? target : null;
  const defaultSchema = useConnections((s) => s.defaultSchema[ctx.cfg.id]);
  const schema = table ? (table.schema ?? defaultSchema ?? null) : null;
  const [meta, setMeta] = useState<ColumnMeta[] | null>(null);
  const [version, setVersion] = useState(0);
  const [errorRow, setErrorRow] = useState<number | null>(null);
  const [clientSort, setClientSort] = useState<SortKey[]>([]);
  const clientSorted = !ctx.onHeaderClicked && clientSort.length > 0;
  const order = useMemo(() => (clientSorted ? clientOrder(r.rows, clientSort, r.columns) : undefined), [r, clientSort, clientSorted]);

  useEffect(() => {
    setClientSort([]);
    setErrorRow(null);
  }, [r]);

  const tableKey = table ? `${schema}.${table.table}` : null;
  useEffect(() => {
    setMeta(null);
    if (!table) return;
    void useTree.getState().loadColumns(ctx.cfg.id, schema ?? "main", table.table).then(setMeta);
  }, [tableKey]);

  const editState: { info: EditInfo } | { reason: string } = useMemo(() => {
    if (ctx.cfg.read_only) return { reason: "읽기 전용 접속" };
    if (!target) return { reason: "편집할 수 없는 결과" };
    if ("reason" in target) return target;
    if (!meta) return { reason: "컬럼 정보를 불러오는 중…" };
    if (!meta.length) return { reason: `테이블 ${target.table}을(를) 찾을 수 없습니다` };
    const res = resolveEdit(r.columns, meta);
    return "reason" in res ? res : { info: res };
  }, [target, meta, r, ctx.cfg.read_only]);

  const info = "info" in editState ? editState.info : null;
  const pending = useMemo(() => new PendingChanges(r.rows, r.columns.length), [r]);
  const dirty = !pending.isEmpty;

  // 탭 닫기·재실행 전 확인용 (트랜잭션 사유와 출처를 나눠 저장한다)
  useEffect(() => {
    useTabs.getState().setDirty(ctx.tabId, "edit", dirty ? pendingMessage(pending.count) : null);
  }, [dirty, version, pending]);
  useEffect(() => () => useTabs.getState().setDirty(ctx.tabId, "edit", null), []);

  /** Submit: 실제로 나갈 SQL을 미리보기 모달로 보여 주고, 모달에서 반영한다 */
  const [preview, setPreview] = useState<{ req: SubmitReq; rows: number[] } | null>(null);
  const [selStats, setSelStats] = useState<SelStats | null>(null);
  const submitting = !!preview;
  const submit = () => {
    if (!info || !table || pending.isEmpty || preview) return;
    try {
      const built = buildSubmit(pending, info);
      setErrorRow(null);
      setPreview({
        req: { conn_id: ctx.cfg.id, console_id: ctx.consoleId, schema, table: table.table, key_mode: info.key.mode, changes: built.changes },
        rows: built.rows,
      });
    } catch (e) {
      toast(errorMessage(e), "error");
    }
  };
  const onSubmitted = async (count: number, edited: boolean) => {
    setPreview(null);
    const inTx = !!ctx.consoleId && manualOf(ctx.consoleId);
    toast(`${count}개 ${edited ? "문장을 실행" : "변경을 반영"}했습니다${inTx ? " (커밋 전)" : ""}.`);
    if (inTx) useTx.getState().set(ctx.consoleId!, { dirty: true });
    await runner.refresh(entry.key);
  };

  /** 바이너리 셀 파일 입출력 (편집기를 열 때만 계산한다). 저장되지 않은 행이면 불가, 보류 변경이 있는 행은 불러오기 불가. */
  const blobOps = (row: number, col: number) => {
    if (!info || !table || pending.isInserted(row)) return undefined;
    let key;
    try {
      key = rowKey(pending, info, row);
    } catch {
      return undefined;
    }
    const column = r.columns[col].name;
    const req = { conn_id: ctx.cfg.id, console_id: ctx.consoleId, schema, table: table.table, key_mode: info.key.mode, key, column };
    return {
      save: async () => {
        try {
          const res = await api.readBlob(req, `${table.table}_${column}.bin`);
          if (res) toast(`${res.bytes.toLocaleString()}바이트를 저장했습니다.\n${res.path}`);
        } catch (e) {
          toast(`저장 실패: ${errorMessage(e)}`, "error");
        }
      },
      load:
        pending.edits.has(row) || pending.deleted.has(row)
          ? null
          : async () => {
              if (!(await confirmDialog({ title: "바이너리 값 바꾸기", body: `${row + 1}행의 '${column}' 값을 고른 파일 내용으로 바꾸고 바로 반영합니다.`, okLabel: "파일 고르기" }))) return;
              try {
                const res = await api.writeBlob(req);
                if (!res) return;
                toast(`${res.bytes.toLocaleString()}바이트를 반영했습니다.`);
                if (ctx.consoleId && manualOf(ctx.consoleId)) useTx.getState().set(ctx.consoleId, { dirty: true });
                await runner.refresh(entry.key);
              } catch (e) {
                toast(`불러오기 실패: ${errorMessage(e)}`, "error");
              }
            },
    };
  };

  const revertAll = () => {
    pending.revertAll();
    setErrorRow(null);
    setVersion((v) => v + 1);
  };

  const guard = async () => !dirty || (await confirmDialog({ title: "변경 버리기", body: `제출하지 않은 변경 ${pending.count}개를 버릴까요?`, okLabel: "버리기", danger: true }));

  const edit = useMemo(
    () => (info ? { info, pending, changed: () => setVersion((v) => v + 1), submit, errorRow, blobOps } : undefined),
    // submit/blobOps는 렌더마다 새로 만들어지지만 내용은 아래 값들에만 의존한다
    [info, pending, errorRow, preview, ctx.consoleId],
  );

  // 헤더의 기본키 표시 (읽기 전용 결과도 단일 테이블이면 표시한다)
  const pkCols = useMemo(() => {
    if (!meta) return undefined;
    const pk = new Set(meta.filter((m) => m.is_pk).map((m) => m.name));
    const seen = new Set<string>();
    return r.columns.map((c) => !seen.has(c.name) && (seen.add(c.name), pk.has(c.name)));
  }, [meta, r]);

  const gridRef = useRef<ResultGridHandle>(null);
  const [selRows, setSelRows] = useState(0);
  const busy = !!runner.running || submitting;
  const refresh = async () => (await guard()) && runner.refresh(entry.key);
  const refreshBtn = (
    <button
      type="button"
      disabled={busy || !entry.stmt.rerunSafe}
      onClick={refresh}
      title={entry.stmt.rerunSafe ? "새로고침 (현재 페이지 다시 조회)" : "데이터를 바꾸는 문장이라 다시 실행하지 않습니다"}
    >
      ⟳ 새로고침
    </button>
  );
  const tableRef = table ? { schema, table: table.table } : null;
  // 버튼 아래에 메뉴를 연다
  const below = (e: React.MouseEvent<HTMLElement>) => {
    const b = e.currentTarget.getBoundingClientRect();
    return { clientX: b.left, clientY: b.bottom + 2 };
  };
  const dataBtns = (
    <>
      <span className="toolbar-sep" />
      <button
        title="선택 영역(없으면 현재 페이지)을 클립보드로 복사"
        onClick={(e) => gridRef.current && showContextMenu(below(e), copyMenuItems(gridRef.current.api(), r.columns, ctx.cfg, tableRef))}
      >
        ⧉ 복사 ▾
      </button>
      <button
        disabled={!canExportCsv(entry)}
        title={canExportCsv(entry) ? "쿼리 전체 결과를 CSV 파일로 내보내기" : "다시 실행하면 데이터가 바뀌는 문장이라 내보낼 수 없습니다"}
        onClick={() => exportCsvOf(entry, ctx.cfg, ctx.consoleId, tableRef)}
      >
        ⭳ CSV 내보내기
      </button>
    </>
  );

  return (
    <>
      <div className="toolbar" style={{ minHeight: 28 }}>
        {info ? (
          <>
            {refreshBtn}
            <button disabled={submitting} onClick={() => gridRef.current?.addRow()} title="행 추가 (Alt+Insert)">
              ＋ 행 추가
            </button>
            <button disabled={submitting || !selRows} onClick={() => gridRef.current?.deleteRows()} title="선택한 행 삭제 (Ctrl+Delete)">
              － 행 삭제
            </button>
            {info.key.mode === "allColumns" && (
              <span className="label" title="기본키나 NOT NULL 고유 컬럼이 없어 모든 컬럼의 기존 값으로 행을 찾습니다">
                ⚠ 키 없음
              </span>
            )}
            {dataBtns}
            <span className="spacer" />
            {dirty && <span className="label">변경 {pending.count}개</span>}
            <button disabled={!dirty || submitting} onClick={revertAll} title="모든 변경 되돌리기">
              되돌리기
            </button>
            <button className="primary" disabled={!dirty || submitting} onClick={submit} title="반영할 SQL 미리보기 후 Submit (그리드에서 Ctrl+Enter)">
              Submit…
            </button>
          </>
        ) : (
          <>
            {refreshBtn}
            {dataBtns}
            <span className="label" title={"reason" in editState ? editState.reason : ""}>
              🔒 읽기 전용 · {"reason" in editState ? editState.reason : ""}
            </span>
            <span className="spacer" />
          </>
        )}
      </div>
      {preview && (
        <SubmitPreview
          cfg={ctx.cfg}
          scheme={scheme}
          req={preview.req}
          onFailedChange={(i) => setErrorRow(preview.rows[i] ?? null)}
          onDone={onSubmitted}
          onClose={() => setPreview(null)}
        />
      )}
      <ResultGrid
        ref={gridRef}
        key={entry.key}
        pkCols={pkCols}
        onSelectedRows={setSelRows}
        onSelStats={setSelStats}
        columns={r.columns}
        rows={r.rows}
        scheme={scheme}
        rowOffset={entry.offset}
        version={version}
        edit={edit}
        onHeaderClicked={ctx.onHeaderClicked ?? ((c, shift) => setClientSort((k) => cycleSort(k, c, shift)))}
        headerSuffix={ctx.headerSuffix ?? ((c) => sortSuffix(clientSort, c))}
        order={order}
        menuItems={(a) => exportMenuItems(a, entry, r.columns, ctx.cfg, ctx.consoleId, table ? { schema, table: table.table } : null)}
      />
      <PagingBar entry={entry} runner={runner} guard={guard} stats={selStats}>
        {clientSorted && <span title="콘솔 결과의 헤더 정렬은 서버에 다시 묻지 않고 지금 받은 행만 정렬합니다">정렬: 현재 페이지만</span>}
      </PagingBar>
    </>
  );
}
