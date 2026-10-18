import { useEffect, useState, type ReactNode } from "react";
import { errorMessage } from "../api";
import type { ResultEntry, useRunner } from "../grid/useRunner";
import { MAX_PAGE_SIZE, PAGE_SIZE_OPTIONS } from "../grid/constants";
import { usePrefs } from "../store/prefs";
import { showContextMenu } from "./ui";
import { useTabs } from "../store/tabs";
import { confirmDialog, toast } from "../store/ui";
import type { Scheme } from "../theme";
import { EditableResult, type ResultCtx } from "./EditableResult";

type Runner = ReturnType<typeof useRunner>;

function Elapsed({ since }: { since: number }) {
  const [now, setNow] = useState(Date.now());
  useEffect(() => {
    const t = setInterval(() => setNow(Date.now()), 100);
    return () => clearInterval(t);
  }, []);
  return <span>{((now - since) / 1000).toFixed(1)}s</span>;
}

export function StopButton({ runner }: { runner: Runner }) {
  return (
    <button className="danger" onClick={() => runner.cancel().catch((e) => toast(`중지 실패: ${errorMessage(e)}`, "error"))}>
      ■ 중지
    </button>
  );
}

/** 행 범위 표시. 누르면 페이지 크기를 고르는 메뉴를 열고, 바꾸면 첫 페이지부터 다시 읽는다. */
function PageSizePicker({ entry, runner, guard, children }: { entry: ResultEntry; runner: Runner; guard?: () => Promise<boolean>; children: ReactNode }) {
  const [custom, setCustom] = useState(false);
  const busy = !!runner.running;
  const apply = async (n: number) => {
    setCustom(false);
    if (n === entry.pageSize) return;
    if (guard && !(await guard())) return;
    usePrefs.getState().setPageSize(n);
    // 다시 실행하면 데이터가 바뀌는 문장은 설정만 바꾸고 다음 실행부터 적용한다
    if (entry.stmt.rerunSafe) await runner.page(entry.key, 0);
  };
  if (custom)
    return (
      <input
        type="number"
        className="page-size-input"
        min={1}
        max={MAX_PAGE_SIZE}
        defaultValue={entry.pageSize}
        autoFocus
        title={`한 번에 가져올 행 수 (1~${MAX_PAGE_SIZE.toLocaleString()}), Enter로 적용`}
        onBlur={() => setCustom(false)}
        onKeyDown={(e) => {
          if (e.key === "Escape") {
            e.stopPropagation();
            setCustom(false);
          } else if (e.key === "Enter") {
            const n = Math.floor(Number(e.currentTarget.value));
            if (n >= 1 && n <= MAX_PAGE_SIZE) void apply(n);
            else toast(`1부터 ${MAX_PAGE_SIZE.toLocaleString()} 사이로 입력하세요.`, "error");
          }
        }}
      />
    );
  return (
    <button
      className="icon page-size"
      disabled={busy}
      title={`페이지 크기: ${entry.pageSize.toLocaleString()}행 (눌러서 변경)`}
      onClick={(e) => {
        const r = e.currentTarget.getBoundingClientRect();
        showContextMenu({ clientX: r.left, clientY: r.top - 4 - (PAGE_SIZE_OPTIONS.length + 2) * 26 }, [
          ...PAGE_SIZE_OPTIONS.map((n) => ({ label: `${n === entry.pageSize ? "✓ " : " "}${n.toLocaleString()}행`, onClick: () => void apply(n) })),
          "sep" as const,
          {
            label: `${PAGE_SIZE_OPTIONS.includes(entry.pageSize) ? " " : "✓ "}직접 입력…${PAGE_SIZE_OPTIONS.includes(entry.pageSize) ? "" : ` (${entry.pageSize.toLocaleString()})`}`,
            onClick: () => setCustom(true),
          },
        ]);
      }}
    >
      {children}
    </button>
  );
}

/** 페이지 이동과 행 수 조회 바. guard가 false를 돌려주면 이동하지 않는다. */
export function PagingBar({ entry, runner, guard, children }: { entry: ResultEntry; runner: Runner; guard?: () => Promise<boolean>; children?: ReactNode }) {
  const r = entry.result;
  if (!r) return null;
  const from = r.rows.length ? entry.offset + 1 : 0;
  const to = entry.offset + r.rows.length;
  const busy = !!runner.running;
  const total = entry.total;
  const size = entry.pageSize;
  const go = async (offset: number) => {
    if (guard && !(await guard())) return;
    await runner.page(entry.key, offset);
  };
  return (
    <div className="statusbar">
      {children}
      <span className="spacer" />
      {entry.stmt.pageable ? (
        <>
          <button className="icon" title="이전 페이지" disabled={busy || entry.offset === 0} onClick={() => go(entry.offset - size)}>
            ◀
          </button>
          <PageSizePicker entry={entry} runner={runner} guard={guard}>
            {from}–{to} / {total ?? (r.has_more ? "?" : to)}
          </PageSizePicker>
          <button className="icon" title="다음 페이지" disabled={busy || !r.has_more} onClick={() => go(entry.offset + size)}>
            ▶
          </button>
          <button className="icon" title="전체 행 수 조회" disabled={busy || entry.counting} onClick={() => runner.count(entry.key)}>
            {entry.counting ? "세는 중…" : "Σ 행 수"}
          </button>
        </>
      ) : (
        <PageSizePicker entry={entry} runner={runner} guard={guard}>
          {r.rows.length}행{r.has_more ? ` (처음 ${size}행만 표시)` : ""}
        </PageSizePicker>
      )}
      <span>{r.elapsed_ms} ms</span>
    </div>
  );
}

export function ResultBody({ entry, runner, scheme, ctx }: { entry: ResultEntry; runner: Runner; scheme: Scheme; ctx: ResultCtx }) {
  if (entry.status === "running")
    return (
      <div className="running">
        <span>실행 중…</span>
        <Elapsed since={entry.startedAt} />
        <StopButton runner={runner} />
      </div>
    );
  if (entry.status === "error" || entry.status === "cancelled") return <div className={`message ${entry.status === "error" ? "error" : ""}`}>{entry.error}</div>;
  const r = entry.result!;
  if (r.rows_affected !== null && r.columns.length === 0)
    return (
      <div className="message">
        {r.rows_affected}행이 변경되었습니다 ({r.elapsed_ms} ms)
      </div>
    );
  return <EditableResult entry={entry} runner={runner} scheme={scheme} ctx={ctx} />;
}

/** 콘솔 아래쪽: 문장별 결과 탭 */
export function ResultPanel({ runner, scheme, ctx }: { runner: Runner; scheme: Scheme; ctx: ResultCtx }) {
  const { entries, activeKey, setActiveKey } = runner;
  if (!entries.length) return <div className="empty">Ctrl+Enter로 커서 위치의 문장을 실행합니다</div>;
  const active = entries.find((e) => e.key === activeKey) ?? entries[0];
  return (
    <div className="results">
      <div className="result-tabs">
        {entries.map((e) => (
          <div key={e.key} className={`result-tab${e.key === active.key ? " active" : ""}${e.status === "error" ? " error" : ""}`} onClick={async () => {
              if (e.key === active.key) return;
              // 결과 탭을 바꾸면 편집 중인 그리드가 사라지므로 보류 변경이 있으면 묻는다
              const pending = useTabs.getState().dirty[ctx.tabId]?.edit;
              if (pending && !(await confirmDialog({ title: "변경 버리기", body: `${pending}
다른 결과로 바꾸면 버려집니다.`, okLabel: "버리기", danger: true }))) return;
              setActiveKey(e.key);
            }}>
            {e.title}
          </div>
        ))}
      </div>
      <ResultBody entry={active} runner={runner} scheme={scheme} ctx={ctx} />
    </div>
  );
}
