import type { Driver } from "../api/types";

export type TokType = "word" | "string" | "qident" | "number" | "param" | "punct" | "comment" | "ws";

export interface Token {
  type: TokType;
  text: string;
  from: number;
  to: number;
}

const isWordStart = (c: string) => /[A-Za-z_\u0080-￿]/.test(c);
const isWordChar = (c: string) => /[A-Za-z0-9_$\u0080-￿]/.test(c);
const isDigit = (c: string) => c >= "0" && c <= "9";

/** 문자열·식별자·주석·PG 달러 인용을 구분하는 경량 SQL 토크나이저 */
export function tokenize(src: string, driver: Driver): Token[] {
  const out: Token[] = [];
  const n = src.length;
  let i = 0;
  const push = (type: TokType, from: number, to: number) => out.push({ type, text: src.slice(from, to), from, to });

  // quote로 끝나는 위치(닫는 따옴표 다음)를 찾는다. doubled = '' 이스케이프, backslash = \ 이스케이프
  const scanQuoted = (start: number, q: string, backslash: boolean): number => {
    let j = start + 1;
    while (j < n) {
      const c = src[j];
      if (backslash && c === "\\") {
        j += 2;
        continue;
      }
      if (c === q) {
        if (src[j + 1] === q) {
          j += 2;
          continue;
        }
        return j + 1;
      }
      j++;
    }
    return n;
  };

  while (i < n) {
    const c = src[i];
    const c2 = src[i + 1];
    const start = i;

    if (c === " " || c === "\t" || c === "\n" || c === "\r") {
      while (i < n && /\s/.test(src[i])) i++;
      push("ws", start, i);
    } else if ((c === "-" && c2 === "-") || (c === "#" && driver === "mysql")) {
      while (i < n && src[i] !== "\n") i++;
      push("comment", start, i);
    } else if (c === "/" && c2 === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? n : end + 2;
      push("comment", start, i);
    } else if (c === "'") {
      i = scanQuoted(i, "'", driver === "mysql");
      push("string", start, i);
    } else if ((c === "E" || c === "e") && c2 === "'" && driver === "postgres") {
      i = scanQuoted(i + 1, "'", true);
      push("string", start, i);
    } else if (c === '"') {
      i = scanQuoted(i, '"', driver === "mysql");
      push(driver === "mysql" ? "string" : "qident", start, i);
    } else if (c === "`") {
      i = scanQuoted(i, "`", false);
      push("qident", start, i);
    } else if (c === "[" && driver === "sqlite") {
      const end = src.indexOf("]", i + 1);
      i = end < 0 ? n : end + 1;
      push("qident", start, i);
    } else if (c === "$" && driver === "postgres") {
      // $1 파라미터 또는 $tag$ ... $tag$ 달러 인용
      if (isDigit(c2 ?? "")) {
        i++;
        while (i < n && isDigit(src[i])) i++;
        push("param", start, i);
      } else {
        let j = i + 1;
        while (j < n && isWordChar(src[j]) && src[j] !== "$") j++;
        if (src[j] === "$") {
          const tag = src.slice(i, j + 1);
          const end = src.indexOf(tag, j + 1);
          i = end < 0 ? n : end + tag.length;
          push("string", start, i);
        } else {
          i++;
          push("punct", start, i);
        }
      }
    } else if (isDigit(c) || (c === "." && isDigit(c2 ?? ""))) {
      while (i < n && /[0-9.eE_xXa-fA-F]/.test(src[i])) {
        if ((src[i] === "e" || src[i] === "E") && (src[i + 1] === "+" || src[i + 1] === "-")) i++;
        i++;
      }
      push("number", start, i);
    } else if (isWordStart(c)) {
      while (i < n && isWordChar(src[i])) i++;
      push("word", start, i);
    } else {
      i++;
      push("punct", start, i);
    }
  }
  return out;
}

/** 의미 있는 토큰(공백·주석 제외) */
export const significant = (toks: Token[]) => toks.filter((t) => t.type !== "ws" && t.type !== "comment");
