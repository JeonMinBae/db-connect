import type { Cell } from "../api/types";

export type CellState = "edit" | "insert" | "delete" | null;

const same = (a: Cell, b: Cell) => a.t === b.t && (a as { v?: unknown }).v === (b as { v?: unknown }).v;

/** 실행 취소용 상태 사본. Cell은 바꾸지 않고 교체만 하므로 얕은 복사로 충분하다. */
interface Snapshot {
  edits: [number, [number, Cell][]][];
  inserted: Cell[][];
  touched: number[][];
  deleted: number[];
}

const HISTORY_LIMIT = 200;

/** 그리드의 보류 중인 변경 (DB에는 Submit 때 반영) */
export class PendingChanges {
  /** 원본 행 → (컬럼 → 새 값) */
  readonly edits = new Map<number, Map<number, Cell>>();
  readonly inserted: Cell[][] = [];
  readonly deleted = new Set<number>();

  constructor(
    readonly original: Cell[][],
    readonly ncols: number,
  ) {}

  get rowCount() {
    return this.original.length + this.inserted.length;
  }

  get isEmpty() {
    return this.edits.size === 0 && this.inserted.length === 0 && this.deleted.size === 0;
  }

  get count() {
    let n = this.inserted.length + this.deleted.size;
    for (const m of this.edits.values()) n += m.size;
    return n;
  }

  isInserted(row: number) {
    return row >= this.original.length;
  }

  value(row: number, col: number): Cell {
    if (this.isInserted(row)) return this.inserted[row - this.original.length][col];
    return this.edits.get(row)?.get(col) ?? this.original[row][col];
  }

  stateOf(row: number, col: number): CellState {
    if (this.isInserted(row)) return "insert";
    if (this.deleted.has(row)) return "delete";
    return this.edits.get(row)?.has(col) ? "edit" : null;
  }

  edit(row: number, col: number, v: Cell) {
    if (this.isInserted(row)) {
      const i = row - this.original.length;
      this.inserted[i][col] = v;
      this.insertedTouched[i].add(col);
      return;
    }
    if (this.deleted.has(row)) return;
    const orig = this.original[row][col];
    let m = this.edits.get(row);
    if (same(orig, v)) {
      m?.delete(col);
      if (m && m.size === 0) this.edits.delete(row);
      return;
    }
    if (!m) this.edits.set(row, (m = new Map()));
    m.set(col, v);
  }

  /** 새 행을 추가하고 그 행 번호를 돌려준다. 초기값은 DEFAULT를 쓰도록 비워 둔다. */
  addRow(): number {
    this.inserted.push(Array.from({ length: this.ncols }, () => ({ t: "Null" }) as Cell));
    this.insertedTouched.push(new Set());
    return this.rowCount - 1;
  }

  /** 추가 행에서 사용자가 값을 지정한 컬럼 (INSERT에 포함할 컬럼) */
  readonly insertedTouched: Set<number>[] = [];

  /** 삭제 표시. 추가된 행은 바로 없앤다. */
  deleteRows(rows: number[]) {
    const ins = rows.filter((r) => this.isInserted(r)).map((r) => r - this.original.length).sort((a, b) => b - a);
    for (const i of ins) {
      this.inserted.splice(i, 1);
      this.insertedTouched.splice(i, 1);
    }
    for (const r of rows) if (!this.isInserted(r) && r < this.original.length) this.deleted.add(r);
  }

  revertCell(row: number, col: number) {
    if (this.isInserted(row)) return;
    const m = this.edits.get(row);
    m?.delete(col);
    if (m && m.size === 0) this.edits.delete(row);
  }

  revertRows(rows: number[]) {
    const ins: number[] = [];
    for (const r of rows) {
      if (this.isInserted(r)) ins.push(r);
      else {
        this.edits.delete(r);
        this.deleted.delete(r);
      }
    }
    if (ins.length) this.deleteRows(ins);
  }

  revertAll() {
    this.edits.clear();
    this.deleted.clear();
    this.inserted.length = 0;
    this.insertedTouched.length = 0;
  }

  // ── 실행 취소 ─────────────────────────────────────────────
  private undoStack: Snapshot[] = [];
  private redoStack: Snapshot[] = [];

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  /** 사용자 동작 하나(붙여넣기 여러 셀 포함)를 실행 취소 한 단계로 묶는다. 바뀐 것이 없으면 기록하지 않는다. */
  transact(fn: () => void) {
    const before = this.snapshot();
    fn();
    if (JSON.stringify(before) === JSON.stringify(this.snapshot())) return;
    this.undoStack.push(before);
    if (this.undoStack.length > HISTORY_LIMIT) this.undoStack.shift();
    this.redoStack.length = 0;
  }

  undo(): boolean {
    const s = this.undoStack.pop();
    if (!s) return false;
    this.redoStack.push(this.snapshot());
    this.restore(s);
    return true;
  }

  redo(): boolean {
    const s = this.redoStack.pop();
    if (!s) return false;
    this.undoStack.push(this.snapshot());
    this.restore(s);
    return true;
  }

  private snapshot(): Snapshot {
    return {
      edits: [...this.edits].map(([r, m]) => [r, [...m]]),
      inserted: this.inserted.map((row) => [...row]),
      touched: this.insertedTouched.map((t) => [...t]),
      deleted: [...this.deleted],
    };
  }

  private restore(s: Snapshot) {
    this.edits.clear();
    for (const [r, cols] of s.edits) this.edits.set(r, new Map(cols));
    this.inserted.length = 0;
    this.inserted.push(...s.inserted.map((row) => [...row]));
    this.insertedTouched.length = 0;
    this.insertedTouched.push(...s.touched.map((t) => new Set(t)));
    this.deleted.clear();
    for (const r of s.deleted) this.deleted.add(r);
  }
}
