import { forwardRef, useCallback, useEffect, useImperativeHandle, useMemo, useRef, useState } from "react";
import DataEditor, {
  CompactSelection,
  GridCellKind,
  type DataEditorRef,
  type EditableGridCell,
  type GridColumn,
  type GridSelection,
  type Item,
  type SpriteMap,
} from "@glideapps/glide-data-grid";
import type { Cell, ColumnInfo } from "../api/types";
import { columnWidths, isNumericType, toGridCell } from "../grid/cells";
import type { PendingChanges } from "../grid/pending";
import { editorKind, provideEditor, type CellWithCtx, type EditCtx } from "../grid/editors";
import { forEachSelectedCell, selectionStats, sqlNumberOf, type NumberOf, type SelStats } from "../grid/selStats";
import type { EditInfo } from "../sql/editable";
import { cellColors, gridThemes, type Scheme } from "../theme";
import { showContextMenu, type MenuEntry } from "./ui";

export interface GridEdit {
  info: EditInfo;
  pending: PendingChanges;
  /** 변경 후 다시 그리기 */
  changed: () => void;
  submit: () => void;
  errorRow: number | null;
  /** 바이너리 셀의 파일 저장/불러오기 (행을 키로 찾을 수 없으면 undefined) */
  blobOps?: (row: number, col: number) => ReturnType<NonNullable<EditCtx["blob"]>>;
  /** 원래 값이 이 셀 종류면 편집할 수 있는지 (기본: 텍스트·NULL만). MongoDB의 없는 필드 칸 등 */
  canEditOriginal?: (orig: Cell) => boolean;
}

export interface GridApi {
  /** 선택 범위 (표시 좌표, 없으면 null) */
  range: { x: number; y: number; width: number; height: number } | null;
  /** range 가 덮는 데이터 컬럼들 (원래 순서). 화면에서 컬럼 순서를 바꿔도 복사·내보내기는 이 순서를 쓴다 */
  rangeCols: number[];
  /** 행 마커로 고른 표시 행들 */
  rows: number[];
  /** 표시 행의 현재 값 (보류 변경 반영) */
  getRow: (displayRow: number) => Cell[];
  rowCount: number;
}

/** 바깥 툴바에서 부르는 편집 동작 */
export interface ResultGridHandle {
  addRow: () => void;
  deleteRows: () => void;
  /** 현재 선택 (복사 버튼용) */
  api: () => GridApi;
  /** 선택한 편집 가능 칸에 같은 값을 넣는다 (실행 취소 한 단계) */
  fill: (v: Cell) => void;
}

const emptySel: GridSelection = { columns: CompactSelection.empty(), rows: CompactSelection.empty() };

// 기본키 컬럼 헤더 아이콘
const headerIcons: SpriteMap = {
  pk: () =>
    `<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 20 20" width="20" height="20"><circle cx="7" cy="10" r="3.6" fill="none" stroke="#d9a400" stroke-width="2"/><path d="M10.4 10H17M14.5 10v3M16.8 10v2.2" stroke="#d9a400" stroke-width="2" fill="none" stroke-linecap="round"/></svg>`,
};

/** 실행 취소 단축키는 셀 편집기(입력란) 안에서는 입력란이 처리하게 둔다 */
const inTextInput = (t: EventTarget) => t instanceof HTMLElement && !!t.closest("input, textarea, select, [contenteditable='true']");

export const ResultGrid = forwardRef<ResultGridHandle, {
  columns: ColumnInfo[];
  rows: Cell[][];
  scheme: Scheme;
  rowOffset: number;
  edit?: GridEdit;
  /** 헤더 클릭 (정렬) */
  onHeaderClicked?: (col: number, shift: boolean) => void;
  headerSuffix?: (col: number) => string;
  /** 우클릭 메뉴에 추가할 항목 */
  menuItems?: (api: GridApi) => MenuEntry[];
  /** 표시 행 → 데이터 행 (클라이언트 정렬). 추가 행은 그대로 뒤에 붙는다. */
  order?: number[];
  /** 보류 변경이 바뀔 때마다 증가 (다시 그리기용) */
  version?: number;
  /** 컬럼별 기본키 여부 (헤더에 열쇠 아이콘) */
  pkCols?: boolean[];
  /** 선택된 행 수가 바뀌면 호출 (툴바의 삭제 버튼용) */
  onSelectedRows?: (n: number) => void;
  /** 선택한 칸의 개수·합계·평균이 바뀌면 호출 (상태 표시줄용) */
  onSelStats?: (s: SelStats) => void;
  /** 칸 값을 숫자로 읽는 방법 (기본: 숫자 타입 컬럼의 값만) */
  numberOf?: NumberOf;
}>(function ResultGrid(props, handle) {
  const { columns: cols, scheme, edit } = props;
  const ref = useRef<DataEditorRef>(null);
  /** 데이터 컬럼별 너비 (순서를 바꿔도 컬럼을 따라간다) */
  const [widths, setWidths] = useState<Record<number, number>>({});
  const [sel, setSel] = useState<GridSelection>(emptySel);
  // 헤더를 끌어 바꾼 표시 순서: 표시 위치 → 데이터 컬럼. 화면에서만 바뀌며, 결과를 새로 받으면(rows 가 바뀌면) 원래 순서로 돌아간다
  const [moved, setMoved] = useState<{ rows: Cell[][]; order: number[] } | null>(null);
  const colOrder = useMemo(
    () => (moved && moved.rows === props.rows ? moved.order : cols.map((_, i) => i)),
    [moved, props.rows, cols],
  );
  /** 표시 컬럼 → 데이터 컬럼. Glide 가 넘기는 컬럼 번호는 모두 표시 좌표라 이것으로 바꿔 쓴다 */
  const dc = (x: number) => colOrder[x] ?? x;
  const auto = useMemo(() => columnWidths(cols, props.rows), [cols, props.rows]);
  const columns: GridColumn[] = useMemo(
    () =>
      colOrder.map((i) => ({
        id: String(i),
        title: cols[i].name + (props.headerSuffix?.(i) ?? ""),
        width: widths[i] ?? auto[i] + (props.pkCols?.[i] ? 20 : 0),
        icon: props.pkCols?.[i] ? "pk" : undefined,
      })),
    [cols, colOrder, widths, auto, props.headerSuffix, props.pkCols],
  );
  const onColumnMoved = (from: number, to: number) => {
    const order = [...colOrder];
    const [c] = order.splice(from, 1);
    order.splice(to, 0, c);
    setMoved({ rows: props.rows, order });
    // 선택 범위는 표시 좌표라 옮긴 뒤에는 다른 칸을 가리키므로 푼다
    setSel(emptySel);
  };
  const colors = cellColors[scheme];
  const p = edit?.pending;
  const rowCount = p ? p.rowCount : props.rows.length;
  const order = props.order;
  const d = (r: number) => (order && r < order.length ? order[r] : r);
  // 셀마다 다시 계산하지 않도록 컬럼별로 한 번만 계산한다
  const numericCols = useMemo(() => cols.map((c) => isNumericType(c.type_name)), [cols]);

  const editableCell = (col: number, row: number) => {
    if (!edit || !p) return false;
    if (!edit.info.colMeta[col]) return false;
    if (p.isInserted(row)) return true;
    if (p.deleted.has(row)) return false;
    const orig = props.rows[row][col];
    return edit.canEditOriginal ? edit.canEditOriginal(orig) : orig.t === "Text" || orig.t === "Null";
  };

  const STATE_BG = { edit: colors.edit, insert: colors.insert, delete: colors.delete };

  // 함수가 바뀌면 Glide가 그리드 전체를 다시 그리므로, 내용이 바뀔 때만 새로 만든다
  const getCellContent = useCallback(
    ([x, displayRow]: Item) => {
      const col = dc(x);
      const row = d(displayRow);
      if (!p) return toGridCell(props.rows[row][col], numericCols[col], false, { muted: colors.muted });
      const state = p.stateOf(row, col);
      const value = p.value(row, col);
      const bg = edit!.errorRow === row ? colors.errorRow : state ? STATE_BG[state] : undefined;
      const editable = editableCell(col, row);
      let cell: CellWithCtx = toGridCell(value, numericCols[col], editable, { muted: colors.muted, bg, strike: state === "delete" });
      // 추가 행에서 아직 지정하지 않은 값은 DEFAULT
      if (state === "insert" && !p.insertedTouched[row - p.original.length].has(col) && cell.kind === GridCellKind.Text) {
        cell = { ...cell, displayData: "<default>", themeOverride: { ...cell.themeOverride, textDark: colors.muted } };
      }
      // 타입별 편집기용 문맥. 바이너리 셀은 읽기 전용이어도 파일 저장을 위해 연다
      const meta = edit!.info.colMeta[col];
      if (meta) {
        cell.__ctx = {
          meta,
          value,
          nullable: meta.nullable,
          readonly: !editable,
          apply: (v) => mutate(() => applyEdit(col, row, v)),
          // 키 계산은 편집기를 열 때만 한다
          blob: () => edit!.blobOps?.(row, col),
        };
        if (value.t === "Blob" || editorKind(meta, value) === "blob") cell = { ...cell, allowOverlay: true } as CellWithCtx;
      }
      return cell;
    },
    [props.rows, props.version, edit, order, numericCols, scheme, colOrder],
  );

  const applyEdit = (col: number, row: number, v: Cell) => {
    if (!editableCell(col, row)) return;
    p!.edit(row, col, v);
  };

  /** 사용자 동작 하나를 실행 취소 한 단계로 기록하고 다시 그린다 */
  const mutate = (fn: () => void) => {
    p!.transact(fn);
    edit!.changed();
  };

  /** Ctrl 클릭으로 더한 범위(rangeStack)까지 */
  const ranges = sel.current ? [sel.current.range, ...sel.current.rangeStack] : [];
  const selectedRows = (): number[] => {
    const rows = new Set<number>(sel.rows.toArray());
    for (const r of ranges) for (let y = r.y; y < r.y + r.height; y++) rows.add(y);
    return [...rows].map(d).sort((a, b) => a - b);
  };
  /** 선택한 칸들 (데이터 좌표, 겹친 칸은 한 번) */
  const visitSelected = (fn: (col: number, row: number) => void) =>
    forEachSelectedCell(ranges, sel.rows.toArray(), sel.columns.toArray(), { cols: cols.length, rows: rowCount }, (x, y) => fn(dc(x), d(y)));
  const selectedCells = (): [number, number][] => {
    const out: [number, number][] = [];
    visitSelected((x, y) => out.push([x, y]));
    return out;
  };

  const actions = {
    addRow: () => {
      let r = 0;
      mutate(() => (r = p!.addRow()));
      setTimeout(() => {
        ref.current?.scrollTo(0, r);
        setSel({ ...emptySel, current: { cell: [0, r], range: { x: 0, y: r, width: 1, height: 1 }, rangeStack: [] } });
        ref.current?.focus();
      });
    },
    deleteRows: () => {
      // 추가 행이 지워지면 행 번호가 바뀌므로 선택을 푼다
      mutate(() => p!.deleteRows(selectedRows()));
      setSel(emptySel);
    },
    setNull: () => mutate(() => selectedCells().forEach(([x, y]) => applyEdit(x, y, { t: "Null" }))),
    revert: () =>
      mutate(() => {
        if (sel.rows.length) p!.revertRows(sel.rows.toArray().map(d));
        else for (const [x, y] of selectedCells()) p!.isInserted(y) || p!.deleted.has(y) ? p!.revertRows([y]) : p!.revertCell(y, x);
      }),
    undo: () => p!.undo() && edit!.changed(),
    redo: () => p!.redo() && edit!.changed(),
  };

  useImperativeHandle(handle, () => ({
    addRow: actions.addRow,
    deleteRows: actions.deleteRows,
    api: () => gridApi,
    fill: (v: Cell) => edit && mutate(() => selectedCells().forEach(([x, y]) => applyEdit(x, y, v))),
  }));

  const onSelectedRows = props.onSelectedRows;
  const selRowCount = sel.rows.length + ranges.reduce((n, r) => n + r.height, 0);
  useEffect(() => onSelectedRows?.(selRowCount), [selRowCount]);

  const onSelStats = props.onSelStats;
  const numberOf = useMemo(() => props.numberOf ?? sqlNumberOf(numericCols), [props.numberOf, numericCols]);
  useEffect(() => {
    if (!onSelStats) return;
    const value = (x: number, y: number) => (p ? p.value(y, x) : props.rows[y][x]);
    onSelStats(selectionStats(visitSelected, value, numberOf));
  }, [sel, props.rows, props.version, order, colOrder, numberOf]);

  const onKeyDownCapture = (e: React.KeyboardEvent) => {
    if (!edit) return;
    const k = e.key;
    const handled = () => {
      e.preventDefault();
      e.stopPropagation();
    };
    if (e.ctrlKey && k === "Enter") {
      handled();
      edit.submit();
    } else if (e.altKey && k === "Insert") {
      handled();
      actions.addRow();
    } else if ((e.ctrlKey && k === "Delete") || (k === "Delete" && sel.rows.length > 0)) {
      handled();
      actions.deleteRows();
    } else if (e.ctrlKey && e.shiftKey && (k === "N" || k === "n")) {
      handled();
      actions.setNull();
    } else if (e.ctrlKey && e.altKey && (k === "z" || k === "Z")) {
      handled();
      actions.revert();
    } else if (e.ctrlKey && !e.altKey && (k === "z" || k === "Z" || k === "y" || k === "Y") && !inTextInput(e.target)) {
      handled();
      if (k === "y" || k === "Y" || e.shiftKey) actions.redo();
      else actions.undo();
    }
  };

  const range = sel.current?.range ?? null;
  const gridApi: GridApi = {
    range,
    rangeCols: range ? colOrder.slice(range.x, range.x + range.width).sort((a, b) => a - b) : [],
    rows: sel.rows.toArray(),
    getRow: (r) => cols.map((_, c) => (p ? p.value(d(r), c) : props.rows[d(r)][c])),
    rowCount,
  };

  const onContextMenu = (e: React.MouseEvent) => {
    const items: MenuEntry[] = [];
    if (edit) {
      items.push(
        { label: "행 추가\tAlt+Insert", onClick: actions.addRow },
        { label: "행 삭제\tCtrl+Delete", onClick: actions.deleteRows, disabled: !selectedRows().length },
        { label: "NULL로 설정\tCtrl+Shift+N", onClick: actions.setNull, disabled: !selectedCells().length },
        { label: "되돌리기\tCtrl+Alt+Z", onClick: actions.revert, disabled: p!.isEmpty },
        "sep",
        { label: "실행 취소\tCtrl+Z", onClick: actions.undo, disabled: !p!.canUndo },
        { label: "다시 실행\tCtrl+Shift+Z", onClick: actions.redo, disabled: !p!.canRedo },
      );
    }
    const extra = props.menuItems?.(gridApi) ?? [];
    if (items.length && extra.length) items.push("sep");
    items.push(...extra);
    if (items.length) showContextMenu(e, items);
  };

  return (
    <div className="grid-host" onKeyDownCapture={onKeyDownCapture} onContextMenu={onContextMenu}>
      <DataEditor
        ref={ref}
        theme={gridThemes[scheme]}
        columns={columns}
        rows={rowCount}
        getCellContent={getCellContent}
        getCellsForSelection={true}
        gridSelection={sel}
        onGridSelectionChange={setSel}
        rangeSelect="multi-rect"
        rowMarkers={{ kind: "clickable-number", startIndex: props.rowOffset + 1, width: 56 }}
        onColumnResize={(_c, w, x) => setWidths((s) => ({ ...s, [dc(x)]: w }))}
        onColumnMoved={onColumnMoved}
        onHeaderClicked={props.onHeaderClicked ? (x, ev) => props.onHeaderClicked!(dc(x), ev.shiftKey) : undefined}
        onCellEdited={
          edit
            ? ([x, row]: Item, v: EditableGridCell) => {
                if (v.kind !== GridCellKind.Text) return;
                mutate(() => applyEdit(dc(x), d(row), { t: "Text", v: v.data }));
              }
            : undefined
        }
        onCellsEdited={
          edit
            ? (list) => {
                // 붙여넣기 한 번 = 실행 취소 한 단계
                mutate(() => {
                  for (const { location, value } of list) if (value.kind === GridCellKind.Text) applyEdit(dc(location[0]), d(location[1]), { t: "Text", v: value.data });
                });
                return true;
              }
            : undefined
        }
        headerIcons={headerIcons}
        onPaste={!!edit}
        provideEditor={edit ? provideEditor : undefined}
        onDelete={() => false}
        smoothScrollX
        smoothScrollY
        width="100%"
        height="100%"
        rowHeight={24}
        headerHeight={28}
      />
    </div>
  );
});
