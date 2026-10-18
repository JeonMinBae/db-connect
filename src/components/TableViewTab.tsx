import { memo, useEffect, useRef, useState } from "react";
import type { SqlConfig } from "../api/types";
import { cycleSort, orderByText, sortSuffix, type SortKey } from "../grid/sort";
import { useRunner } from "../grid/useRunner";
import { qualified } from "../sql/quote";
import { useConnections } from "../store/connections";
import { useTabs } from "../store/tabs";
import { confirmDialog } from "../store/ui";
import type { Scheme } from "../theme";
import { ResultBody } from "./ResultPanel";
import { SqlEditor, type SqlEditorHandle } from "./SqlEditor";

export const TableViewTab = memo(function TableViewTab(props: { tabId: string; cfg: SqlConfig; schema: string; table: string; scheme: Scheme; active: boolean }) {
  const { cfg, schema, table } = props;
  const runner = useRunner(cfg.id, null);
  const snapshot = useConnections((s) => s.snapshot[cfg.id]);
  const whereRef = useRef<SqlEditorHandle>(null);
  const orderRef = useRef<SqlEditorHandle>(null);
  const [sort, setSort] = useState<SortKey[]>([]);
  const [loaded, setLoaded] = useState(false);
  const entry = runner.entries[0];

  const buildSql = (where: string, orderBy: string) =>
    `SELECT * FROM ${qualified(cfg.driver, schema, table)}` + (where.trim() ? `\nWHERE ${where.trim()}` : "") + (orderBy.trim() ? `\nORDER BY ${orderBy.trim()}` : "");

  /** 보류 중인 편집이 있으면 버릴지 묻는다 */
  const confirmDiscard = async () => {
    const pending = useTabs.getState().dirty[props.tabId]?.edit;
    return !pending || (await confirmDialog({ title: "변경 버리기", body: `${pending}\n다시 조회하면 버려집니다.`, okLabel: "다시 조회", danger: true }));
  };

  /** 필터/정렬을 적용해 첫 페이지부터 다시 조회한다. 실패하면 이전 결과를 유지한다. */
  const apply = async (where = whereRef.current?.getText() ?? "", orderBy = orderRef.current?.getText() ?? "") => {
    if (runner.running) return;
    if (!(await confirmDiscard())) return;
    if (!(await useConnections.getState().connect(cfg.id))) return;
    await runner.runAll([{ text: buildSql(where, orderBy), isQuery: true, pageable: true, rerunSafe: true, target: { schema, table } }], undefined, { keepOnError: true });
  };

  // 처음 활성화될 때 불러온다
  useEffect(() => {
    if (props.active && !loaded) {
      setLoaded(true);
      void apply("", "");
    }
  }, [props.active]);

  const onHeaderClicked = (col: number, shift: boolean) => {
    const r = entry?.result;
    if (!r) return;
    const next = cycleSort(sort, col, shift);
    const text = orderByText(next, r.columns, cfg.driver);
    orderRef.current?.setText(text);
    setSort(next);
    void apply(undefined, text);
  };

  const filterKeys = [{ key: "Enter", run: () => (setSort([]), void apply(), true) }];

  return (
    <>
      <div className="toolbar">
        {/* 결과가 있으면 결과 툴바의 새로고침을 쓴다 */}
        {!entry?.result && (
          <button className="icon" title="다시 조회" disabled={!!runner.running} onClick={() => apply()}>
            ⟳
          </button>
        )}
        <span className="label">
          {schema}.{table}
        </span>
        <span className="spacer" />
        {cfg.read_only && <span className="badge">READ ONLY</span>}
        <span className="label">{cfg.name}</span>
      </div>
      <div className="toolbar filter-bar">
        <span className="label">WHERE</span>
        <div className="filter-input">
          <SqlEditor
            ref={whereRef}
            singleLine
            driver={cfg.driver}
            scheme={props.scheme}
            initialText=""
            snapshot={snapshot}
            defaultSchema={schema}
            defaultTable={table}
            placeholder="조건 (Enter로 적용)"
            extraKeys={filterKeys}
          />
        </div>
        <span className="label">ORDER BY</span>
        <div className="filter-input" style={{ flex: "0 1 30%" }}>
          <SqlEditor
            ref={orderRef}
            singleLine
            driver={cfg.driver}
            scheme={props.scheme}
            initialText=""
            snapshot={snapshot}
            defaultSchema={schema}
            defaultTable={table}
            placeholder="정렬 (헤더 클릭 가능)"
            extraKeys={filterKeys}
          />
        </div>
      </div>
      <div className="results">
        {entry ? (
          <ResultBody
            entry={entry}
            runner={runner}
            scheme={props.scheme}
            ctx={{ cfg, tabId: props.tabId, consoleId: null, onHeaderClicked, headerSuffix: (c) => sortSuffix(sort, c) }}
          />
        ) : (
          <div className="empty">불러오는 중…</div>
        )}
        {runner.lastError && <div className="message error" style={{ flex: "none", maxHeight: 120 }}>{runner.lastError}</div>}
      </div>
    </>
  );
});
