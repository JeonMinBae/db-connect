import type { Driver } from "../api/types";
import { identName } from "./editable";
import { splitStatements, statementAt, type Stmt } from "./split";

/** 실행할 문장을 고른다: 선택 영역이 있으면 그 안의 문장들, 없으면 커서 위치 문장 */
export function pickStatements(doc: string, sel: { from: number; to: number; head: number }, driver: Driver): Stmt[] {
  if (sel.from !== sel.to) return splitStatements(doc.slice(sel.from, sel.to), driver, sel.from);
  const s = statementAt(splitStatements(doc, driver), sel.head);
  return s ? [s] : [];
}

/** WHERE 없는 UPDATE/DELETE */
export const isRisky = (s: Stmt) => s.kind === "dml" && (s.dmlVerb === "UPDATE" || s.dmlVerb === "DELETE") && !s.hasTopLevelWhere;

/** WHERE 없는 UPDATE/DELETE의 대상 테이블 이름 (경고 문구용) */
export function riskyTable(s: Stmt, driver: Driver): string {
  const toks = s.tokens;
  const verbIdx = toks.findIndex((t) => t.type === "word" && t.text.toUpperCase() === s.dmlVerb);
  let i = verbIdx + 1;
  if (s.dmlVerb === "DELETE" && toks[i]?.text.toUpperCase() === "FROM") i++;
  const parts: string[] = [];
  while (toks[i] && (toks[i].type === "word" || toks[i].type === "qident")) {
    parts.push(identName(toks[i], driver) ?? toks[i].text);
    if (toks[i + 1]?.text !== ".") break;
    i += 2;
  }
  return parts.join(".") || "?";
}

/** Submit 미리보기에서 고친 SQL → 실행할 문장들. UPDATE/DELETE는 정확히 1행에 영향을 줘야 한다.
 *  트랜잭션 제어문은 Submit 트랜잭션을 깨므로 거부한다. */
export function toSubmitStatements(text: string, driver: Driver): { stmts: { sql: string; expect_one: boolean }[]; ranges: { from: number; to: number }[] } | { error: string } {
  const list = splitStatements(text, driver);
  if (!list.length) return { error: "실행할 문장이 없습니다." };
  const tx = list.findIndex((s) => s.kind === "tx");
  if (tx >= 0) return { error: `${tx + 1}번째 문장: 트랜잭션 제어문(${list[tx].firstKeyword})은 넣을 수 없습니다. 모든 문장이 하나의 트랜잭션으로 실행됩니다.` };
  return {
    stmts: list.map((s) => ({ sql: s.text, expect_one: s.dmlVerb === "UPDATE" || s.dmlVerb === "DELETE" })),
    ranges: list.map((s) => ({ from: s.from, to: s.to })),
  };
}
