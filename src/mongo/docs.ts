import type { Cell, ColumnInfo, ColumnMeta } from "../api/types";
import type { PendingChanges } from "../grid/pending";
import type { EditInfo } from "../sql/editable";
import type { MongoOp } from "./console";
import { bsonType, formatShell, parseShellValue, ShellError, type EJson } from "./shell";

type Doc = { [k: string]: EJson };

/** 문서에 없는 필드 칸 (null과 구분) */
export const MISSING: Cell = { t: "Unsupported", v: "<없음>" };
/** 필드 삭제 표시 ($unset) */
const UNSET_TEXT = "<필드 삭제>";
export const UNSET: Cell = { t: "Unsupported", v: UNSET_TEXT };

const isDoc = (v: EJson): v is Doc => v !== null && typeof v === "object" && !Array.isArray(v);

/** 현재 페이지 문서들의 최상위 필드 합집합. _id가 먼저, 나머지는 처음 나온 순서 */
export function docColumns(docs: EJson[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const d of docs) if (isDoc(d)) for (const k of Object.keys(d)) if (!seen.has(k)) seen.add(k), out.push(k);
  const id = out.indexOf("_id");
  if (id > 0) out.unshift(...out.splice(id, 1));
  return out;
}

export const columnInfosOf = (cols: string[], docs: EJson[]): ColumnInfo[] =>
  cols.map((name) => {
    const first = docs.find((d) => isDoc(d) && name in d) as Doc | undefined;
    const t = first ? bsonType(first[name]) : "missing";
    return { name, type_name: ["numberInt", "numberLong", "numberDouble", "numberDecimal"].includes(t) ? "numeric" : t };
  });

export function cellOfValue(v: EJson | undefined): Cell {
  if (v === undefined) return MISSING;
  if (v === null) return { t: "Null" };
  return { t: "Text", v: formatShell(v) };
}

export const docRows = (docs: EJson[], cols: string[]): Cell[][] => docs.map((d) => cols.map((c) => cellOfValue(isDoc(d) ? d[c] : undefined)));

const meta = (name: string, i: number): ColumnMeta => ({
  name,
  data_type: "text",
  full_type: "text",
  nullable: true,
  is_pk: name === "_id",
  is_unique_not_null: false,
  enum_values: null,
  ordinal: i + 1,
});

/** 편집 정보: _id가 있는 결과만 편집할 수 있고, _id 칸은 고치지 않는다 */
export function mongoEditInfo(cols: string[], docs: EJson[]): EditInfo | { reason: string } {
  const id = cols.indexOf("_id");
  if (id < 0 || docs.some((d) => !isDoc(d) || d._id === undefined)) return { reason: "_id가 없는 결과는 편집할 수 없습니다" };
  return { colMeta: cols.map((c, i) => (c === "_id" ? null : meta(c, i))), key: { mode: "pk", cols: [id] } };
}

/**
 * 셀 입력 → 값.
 * - 원래 값이 문자열이면 입력을 그대로 문자열로 둔다 (따옴표를 칠 필요 없음)
 * - 그 밖에는 mongosh 표기로 해석하고, 해석할 수 없으면 문자열로 본다
 * - 원래 숫자 타입은 유지한다 (double 칸에 5를 넣어도 double)
 */
export function editedValue(c: Cell, orig: EJson | undefined): EJson | typeof UNSET_MARK {
  if (c.t === "Null") return null;
  if (c.t === "Unsupported") return c.v === UNSET_TEXT ? UNSET_MARK : (orig ?? null);
  if (c.t !== "Text") return orig ?? null;
  const text = c.v;
  if (orig !== undefined && bsonType(orig) === "string") return text;
  let v: EJson;
  try {
    v = parseShellValue(text);
  } catch (e) {
    if (e instanceof ShellError) return text;
    throw e;
  }
  return keepNumberType(v, orig);
}

export const UNSET_MARK = Symbol("unset");

function keepNumberType(v: EJson, orig: EJson | undefined): EJson {
  if (!isDoc(v) || orig === undefined || !isDoc(orig)) return v;
  const num = v.$numberInt ?? v.$numberLong ?? v.$numberDouble;
  if (typeof num !== "string") return v;
  const ot = bsonType(orig);
  if (ot === "numberDouble") return { $numberDouble: /[.eE]|Infinity|NaN/.test(num) ? num : num + ".0" };
  if (ot === "numberLong" && v.$numberInt !== undefined) return { $numberLong: num };
  if (ot === "numberDecimal") return { $numberDecimal: num };
  return v;
}

/**
 * 보류 변경 → Submit 작업. 수정은 바꾼 필드의 원래 값까지 필터에 넣어, 읽은 뒤 다른 곳에서 바뀐 문서는 맞지 않게 한다.
 * 순서: 삭제 → 수정 → 추가
 */
export function mongoOps(coll: string, docs: EJson[], cols: string[], p: PendingChanges): MongoOp[] {
  const del: MongoOp[] = [];
  const upd: MongoOp[] = [];
  const ins: MongoOp[] = [];
  const doc = (r: number) => docs[r] as Doc;
  for (const r of [...p.deleted].sort((a, b) => a - b)) del.push({ kind: "deleteOne", coll, filter: { _id: doc(r)._id } });
  for (const r of [...p.edits.keys()].sort((a, b) => a - b)) {
    if (p.deleted.has(r)) continue;
    const filter: Doc = { _id: doc(r)._id };
    const $set: Doc = {};
    const $unset: Doc = {};
    for (const [c, cell] of p.edits.get(r)!) {
      const name = cols[c];
      const orig = doc(r)[name];
      const v = editedValue(cell, orig);
      // 원래 값 조건: 없던 필드면 {$exists: false}
      filter[name] = orig === undefined ? { $exists: false } : orig;
      if (v === UNSET_MARK) $unset[name] = "";
      else $set[name] = v;
    }
    const update: Doc = {};
    if (Object.keys($set).length) update.$set = $set;
    if (Object.keys($unset).length) update.$unset = $unset;
    upd.push({ kind: "updateOne", coll, filter, update, upsert: false });
  }
  p.inserted.forEach((row, i) => {
    const d: Doc = {};
    for (const c of p.insertedTouched[i]) {
      const v = editedValue(row[c], undefined);
      if (v !== UNSET_MARK) d[cols[c]] = v;
    }
    ins.push({ kind: "insertOne", coll, doc: d });
  });
  return [...del, ...upd, ...ins];
}

/** 미리보기용 mongosh 표기 */
export function formatOp(op: MongoOp): string {
  const c = (name: string) => (/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(name) ? `db.${name}` : `db.getCollection(${JSON.stringify(name)})`);
  const f = (v: EJson) => formatShell(v);
  switch (op.kind) {
    case "updateOne":
    case "updateMany":
      return `${c(op.coll)}.${op.kind}(${f(op.filter)}, ${f(op.update)}${op.upsert ? ", { upsert: true }" : ""})`;
    case "replaceOne":
      return `${c(op.coll)}.replaceOne(${f(op.filter)}, ${f(op.doc)})`;
    case "deleteOne":
    case "deleteMany":
      return `${c(op.coll)}.${op.kind}(${f(op.filter)})`;
    case "insertOne":
      return `${c(op.coll)}.insertOne(${f(op.doc)})`;
    default:
      return JSON.stringify(op);
  }
}
