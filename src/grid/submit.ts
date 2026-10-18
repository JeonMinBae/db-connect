import type { Cell, ColumnMeta } from "../api/types";
import type { EditInfo } from "../sql/editable";
import type { PendingChanges } from "./pending";

export interface Val {
  col: { name: string; full_type: string };
  value: string | null;
}

export type Change = { op: "update"; key: Val[]; set: Val[] } | { op: "delete"; key: Val[] } | { op: "insert"; values: Val[] };

export interface BuiltSubmit {
  changes: Change[];
  /** changes[i]가 가리키는 그리드 행 (오류 강조용) */
  rows: number[];
}

const colRef = (m: ColumnMeta) => ({ name: m.name, full_type: m.full_type });

function cellValue(c: Cell): string | null {
  if (c.t === "Null") return null;
  if (c.t === "Text") return c.v;
  throw new Error("바이너리/지원하지 않는 값은 키나 값으로 쓸 수 없습니다");
}

/** 원본 행의 키 값 (Blob 등 비교할 수 없는 값이면 예외) */
export function rowKey(p: PendingChanges, info: EditInfo, row: number): Val[] {
  return info.key.cols.map((ci) => {
    const m = info.colMeta[ci]!;
    try {
      return { col: colRef(m), value: cellValue(p.original[row][ci]) };
    } catch {
      throw new Error(`${row + 1}행의 키 컬럼 '${m.name}' 값을 비교할 수 없습니다`);
    }
  });
}

/** 보류 변경을 백엔드 요청으로 바꾼다. 실행 순서는 DELETE → UPDATE → INSERT. */
export function buildSubmit(p: PendingChanges, info: EditInfo): BuiltSubmit {
  const changes: Change[] = [];
  const rows: number[] = [];
  const keyOf = (row: number) => rowKey(p, info, row);

  for (const row of [...p.deleted].sort((a, b) => a - b)) {
    changes.push({ op: "delete", key: keyOf(row) });
    rows.push(row);
  }
  for (const [row, cols] of [...p.edits.entries()].sort((a, b) => a[0] - b[0])) {
    if (p.deleted.has(row)) continue;
    const set = [...cols.entries()].map(([ci, v]) => ({ col: colRef(info.colMeta[ci]!), value: cellValue(v) }));
    changes.push({ op: "update", key: keyOf(row), set });
    rows.push(row);
  }
  p.inserted.forEach((cells, i) => {
    const values = [...p.insertedTouched[i]].sort((a, b) => a - b).map((ci) => ({ col: colRef(info.colMeta[ci]!), value: cellValue(cells[ci]) }));
    changes.push({ op: "insert", values });
    rows.push(p.original.length + i);
  });
  return { changes, rows };
}
