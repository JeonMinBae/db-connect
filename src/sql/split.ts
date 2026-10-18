import type { Driver } from "../api/types";
import { significant, tokenize, type Token } from "./tokenize";

export type StmtKind = "query" | "dml" | "tx" | "other";

export interface Stmt {
  text: string;
  from: number;
  to: number;
  kind: StmtKind;
  firstKeyword: string;
  /** WITH 다음의 실제 동사까지 고려한 DML 동사 (INSERT/UPDATE/DELETE/MERGE/REPLACE) */
  dmlVerb: string | null;
  /** 결과 집합을 돌려주는 문장인지 */
  isQuery: boolean;
  /** 최상위 LIMIT/OFFSET/FETCH 유무 */
  hasTopLevelLimit: boolean;
  hasTopLevelWhere: boolean;
  /** LIMIT/OFFSET을 붙여 페이지 조회할 수 있는지 (다시 실행해도 안전할 때만) */
  pageable: boolean;
  /** 괄호 안에 데이터를 바꾸는 문장이 있는지 */
  nestedDml: boolean;
  /** 의미 있는 토큰 (편집 가능성 분석 등에 재사용) */
  tokens: Token[];
}

const QUERY_START = new Set(["SELECT", "VALUES", "TABLE"]);
const ROWS_START = new Set(["SHOW", "EXPLAIN", "PRAGMA", "DESCRIBE", "DESC"]);
const DML = new Set(["INSERT", "UPDATE", "DELETE", "MERGE", "REPLACE", "UPSERT"]);
const TX = new Set(["BEGIN", "START", "COMMIT", "ROLLBACK", "END", "SAVEPOINT", "RELEASE"]);

export function analyze(text: string, from: number, toks: Token[]): Stmt {
  const sig = significant(toks);
  const up = (t: Token) => (t.type === "word" ? t.text.toUpperCase() : "");
  const first = sig.length ? up(sig[0]) : "";

  let depth = 0;
  let verb = first;
  let verbFound = first !== "WITH";
  let hasLimit = false;
  let hasWhere = false;
  let hasReturning = false;
  let hasForLock = false;
  // 괄호 안의 INSERT/UPDATE/DELETE (PG의 데이터 변경 CTE 등). 다시 실행하면 데이터가 또 바뀐다
  let nestedDml = false;
  for (let k = 0; k < sig.length; k++) {
    const t = sig[k];
    if (t.type === "punct") {
      if (t.text === "(") depth++;
      else if (t.text === ")") depth = Math.max(0, depth - 1);
      continue;
    }
    if (t.type !== "word") continue;
    const w = up(t);
    if (depth !== 0) {
      if (DML.has(w) && w !== "REPLACE") nestedDml = true;
      continue;
    }
    if (!verbFound && (QUERY_START.has(w) || DML.has(w))) {
      verb = w;
      verbFound = true;
    }
    if (w === "LIMIT" || w === "OFFSET" || w === "FETCH") hasLimit = true;
    else if (w === "WHERE") hasWhere = true;
    else if (w === "RETURNING") hasReturning = true;
    else if (w === "FOR" && k > 0) hasForLock = true;
  }

  let kind: StmtKind = "other";
  if (QUERY_START.has(verb)) kind = "query";
  else if (DML.has(verb)) kind = "dml";
  else if (TX.has(first)) kind = "tx";

  const isQuery = kind === "query" || ROWS_START.has(first) || (kind === "dml" && hasReturning);
  return {
    text,
    from,
    to: from + text.length,
    kind,
    firstKeyword: first,
    dmlVerb: kind === "dml" ? verb : null,
    isQuery,
    hasTopLevelLimit: hasLimit,
    hasTopLevelWhere: hasWhere,
    pageable: kind === "query" && !hasLimit && !hasForLock && !nestedDml,
    nestedDml,
    tokens: sig,
  };
}

/** 최상위 ';' 기준으로 문장을 나눈다. 공백·주석뿐인 조각은 버린다. */
export function splitStatements(src: string, driver: Driver, base = 0): Stmt[] {
  const toks = tokenize(src, driver);
  const out: Stmt[] = [];
  let depth = 0;
  let cur: Token[] = [];
  const flush = () => {
    const sig = cur.filter((t) => t.type !== "ws" && t.type !== "comment");
    if (sig.length) {
      // 앞뒤 공백 토큰을 제외한 범위 (주석은 포함)
      const body = cur.filter((t) => t.type !== "ws");
      const from = body[0].from;
      const to = body[body.length - 1].to;
      out.push(analyze(src.slice(from, to), base + from, cur));
    }
    cur = [];
  };
  for (const t of toks) {
    if (t.type === "punct" && t.text === "(") depth++;
    else if (t.type === "punct" && t.text === ")") depth = Math.max(0, depth - 1);
    if (t.type === "punct" && t.text === ";" && depth === 0) {
      flush();
      continue;
    }
    cur.push(t);
  }
  flush();
  return out;
}

/** 커서 위치의 문장. 문장 사이 공백이면 바로 앞 문장, 첫 문장 앞이면 첫 문장. */
export function statementAt(stmts: Stmt[], pos: number): Stmt | null {
  if (!stmts.length) return null;
  let prev: Stmt | null = null;
  for (const s of stmts) {
    if (pos < s.from) return prev ?? s;
    // ';' 바로 뒤(to + 1)까지는 그 문장으로 본다
    if (pos <= s.to + 1) return s;
    prev = s;
  }
  return prev;
}
