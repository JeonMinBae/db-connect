import type { ColumnInfo, ColumnMeta, Driver } from "../api/types";
import type { Stmt } from "./split";
import type { Token } from "./tokenize";

export type EditTarget = { schema: string | null; table: string } | { reason: string };

const REJECT_WORDS: Record<string, string> = {
  JOIN: "JOIN이 있는 결과는 편집할 수 없습니다",
  UNION: "UNION 결과는 편집할 수 없습니다",
  INTERSECT: "INTERSECT 결과는 편집할 수 없습니다",
  EXCEPT: "EXCEPT 결과는 편집할 수 없습니다",
  GROUP: "GROUP BY 결과는 편집할 수 없습니다",
  HAVING: "HAVING 결과는 편집할 수 없습니다",
  DISTINCT: "DISTINCT 결과는 편집할 수 없습니다",
  WINDOW: "WINDOW 절이 있는 결과는 편집할 수 없습니다",
};
const AGGREGATES = new Set(["COUNT", "SUM", "AVG", "MIN", "MAX", "ARRAY_AGG", "STRING_AGG", "GROUP_CONCAT", "JSON_AGG", "JSONB_AGG"]);
const TAIL = new Set(["WHERE", "ORDER", "LIMIT", "OFFSET", "FETCH", "FOR"]);

/** 식별자 토큰을 실제 이름으로: 따옴표 제거, PG는 따옴표 없는 이름을 소문자로 */
export function identName(t: Token, driver: Driver): string | null {
  if (t.type === "qident") {
    const q = t.text[0];
    if (q === "[") return t.text.slice(1, -1);
    return t.text.slice(1, -1).replaceAll(q + q, q);
  }
  if (t.type === "word") return driver === "postgres" ? t.text.toLowerCase() : t.text;
  return null;
}

/** 단일 테이블 SELECT인지 판정하고 원본 테이블을 돌려준다 */
export function analyzeEditable(stmt: Stmt, driver: Driver): EditTarget {
  const toks = stmt.tokens;
  const up = (i: number) => (toks[i]?.type === "word" ? toks[i].text.toUpperCase() : "");
  if (up(0) !== "SELECT") return { reason: "SELECT 문의 결과만 편집할 수 있습니다" };

  let depth = 0;
  let fromIdx = -1;
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (t.type === "punct" && t.text === "(") {
      // 선택 목록의 집계 함수
      if (fromIdx < 0 && depth === 0 && AGGREGATES.has(up(i - 1))) return { reason: "집계 함수 결과는 편집할 수 없습니다" };
      depth++;
      continue;
    }
    if (t.type === "punct" && t.text === ")") {
      depth--;
      continue;
    }
    if (depth !== 0) continue;
    const w = up(i);
    if (REJECT_WORDS[w]) return { reason: REJECT_WORDS[w] };
    if (w === "FROM" && fromIdx < 0) fromIdx = i;
  }
  if (fromIdx < 0) return { reason: "FROM 절이 없습니다" };

  // FROM <ident>[.<ident>] [[AS] alias] [WHERE|ORDER|LIMIT ...]
  let i = fromIdx + 1;
  const first = toks[i];
  if (!first || first.type === "punct") return { reason: "서브쿼리 결과는 편집할 수 없습니다" };
  let schema: string | null = null;
  let table = identName(first, driver);
  i++;
  if (toks[i]?.type === "punct" && toks[i].text === ".") {
    schema = table;
    table = toks[i + 1] ? identName(toks[i + 1], driver) : null;
    i += 2;
  }
  if (!table) return { reason: "테이블 이름을 해석할 수 없습니다" };
  if (up(i) === "AS") i++;
  if (toks[i] && (toks[i].type === "word" || toks[i].type === "qident") && !TAIL.has(up(i))) i++; // alias
  const rest = toks[i];
  if (rest && !(rest.type === "word" && TAIL.has(up(i)))) {
    if (rest.type === "punct" && rest.text === ",") return { reason: "여러 테이블을 조회한 결과는 편집할 수 없습니다" };
    return { reason: "단일 테이블 조회만 편집할 수 있습니다" };
  }
  return { schema, table };
}

export type RowKey = { mode: "pk" | "unique" | "allColumns"; cols: number[] };

export interface EditInfo {
  /** 결과 컬럼 인덱스 → 테이블 컬럼 메타 (테이블에 없는 계산 컬럼은 null) */
  colMeta: (ColumnMeta | null)[];
  key: RowKey;
}

const isBinaryMeta = (m: ColumnMeta) => /blob|bytea|binary|varbinary/i.test(m.data_type);

/** 행 식별 키를 정한다. 키 컬럼이 결과에 하나도 없으면 null(편집 불가) */
export function resolveEdit(res: ColumnInfo[], meta: ColumnMeta[]): EditInfo | { reason: string } {
  const byName = new Map(meta.map((m) => [m.name, m]));
  const seen = new Set<string>();
  const colMeta = res.map((c) => {
    // 같은 이름이 두 번 나오면 두 번째부터는 계산 컬럼으로 본다
    if (seen.has(c.name)) return null;
    seen.add(c.name);
    return byName.get(c.name) ?? null;
  });
  const idx = (name: string) => colMeta.findIndex((m) => m?.name === name);

  const pk = meta.filter((m) => m.is_pk).map((m) => idx(m.name));
  if (pk.length && pk.every((i) => i >= 0)) return { colMeta, key: { mode: "pk", cols: pk } };

  const uniq = meta.find((m) => m.is_unique_not_null && idx(m.name) >= 0);
  if (uniq) return { colMeta, key: { mode: "unique", cols: [idx(uniq.name)] } };

  const all = colMeta.map((m, i) => (m && !isBinaryMeta(m) ? i : -1)).filter((i) => i >= 0);
  if (!all.length) return { reason: "행을 식별할 컬럼이 결과에 없습니다" };
  return { colMeta, key: { mode: "allColumns", cols: all } };
}
