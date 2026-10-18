/** 백엔드가 주는 바이트열: UTF-8이면 Text, 아니면 redis-cli 이스케이프 표기(Bin) */
export type Bytes = { t: "Text"; v: string } | { t: "Bin"; v: string };

/** 백엔드로 보내는 인자: 텍스트 또는 16진수 바이트 */
export type Arg = string | { hex: string };

/** redis-cli 따옴표 안 표기 → 바이트 (\\ \" \n \r \t \a \b \xNN) */
export function unescapeRedis(s: string): Uint8Array {
  const out: number[] = [];
  const enc = new TextEncoder();
  for (let i = 0; i < s.length; i++) {
    const c = s[i];
    if (c !== "\\" || i + 1 >= s.length) {
      // 일반 문자는 UTF-8로
      const cp = s.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      out.push(...enc.encode(ch));
      if (cp > 0xffff) i++;
      continue;
    }
    const n = s[++i];
    const simple: Record<string, number> = { n: 10, r: 13, t: 9, a: 7, b: 8, "\\": 92, '"': 34, "'": 39 };
    if (n in simple) out.push(simple[n]);
    else if (n === "x" && /^[0-9a-fA-F]{2}$/.test(s.slice(i + 1, i + 3))) {
      out.push(parseInt(s.slice(i + 1, i + 3), 16));
      i += 2;
    } else out.push(...enc.encode(n));
  }
  return Uint8Array.from(out);
}

export const toHex = (b: Uint8Array) => Array.from(b, (x) => x.toString(16).padStart(2, "0")).join("");

/** 바이트를 인자로: 올바른 UTF-8이면 문자열, 아니면 hex */
export function argOfBytes(b: Uint8Array): Arg {
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(b);
  } catch {
    return { hex: toHex(b) };
  }
}

export const argOf = (b: Bytes): Arg => (b.t === "Text" ? b.v : { hex: toHex(unescapeRedis(b.v)) });

/** 화면 표시용 (바이너리는 redis-cli처럼 따옴표로 감싼 이스케이프 표기) */
export const showBytes = (b: Bytes) => (b.t === "Text" ? b.v : `"${b.v}"`);

/** 탭·트리에서 키를 구분하는 문자열 (바이너리는 이스케이프 표기) */
export const keyId = (b: Bytes) => b.v;
