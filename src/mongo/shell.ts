/**
 * mongosh 표기 ↔ Canonical Extended JSON.
 * JS 엔진 없이 리터럴과 생성자 호출(ObjectId, ISODate, NumberLong …), 멤버 접근·호출 체인만 해석한다.
 *
 * 숫자 규칙 (표시와 입력이 왕복되도록):
 *  - 소수점·지수가 없는 정수: int32 범위면 int32, 넘으면 int64
 *  - 소수점이 있거나 지수 표기: double (정수 값인 double은 "5.0"처럼 표시)
 */

export type EJson = null | boolean | number | string | EJson[] | { [k: string]: EJson };

// ── 토크나이저 ──────────────────────────────────────────

type Tok =
  | { k: "num"; v: string; at: number }
  | { k: "str"; v: string; at: number }
  | { k: "id"; v: string; at: number }
  | { k: "regex"; v: string; flags: string; at: number }
  | { k: "p"; v: string; at: number }
  | { k: "eof"; at: number };

export class ShellError extends Error {
  constructor(
    message: string,
    readonly at: number,
  ) {
    super(message);
  }
}

const isIdStart = (c: string) => /[A-Za-z_$]/.test(c);
const isId = (c: string) => /[A-Za-z0-9_$]/.test(c);

export function tokenize(src: string): Tok[] {
  const out: Tok[] = [];
  let i = 0;
  const prevAllowsRegex = () => {
    const t = out[out.length - 1];
    return !t || (t.k === "p" && /^[([{,:;=!&|?]$/.test(t.v));
  };
  while (i < src.length) {
    const c = src[i];
    if (/\s/.test(c)) {
      i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "/") {
      while (i < src.length && src[i] !== "\n") i++;
      continue;
    }
    if (c === "/" && src[i + 1] === "*") {
      const end = src.indexOf("*/", i + 2);
      i = end < 0 ? src.length : end + 2;
      continue;
    }
    const at = i;
    if (c === '"' || c === "'" || c === "`") {
      let s = "";
      i++;
      while (i < src.length && src[i] !== c) {
        if (src[i] === "\\") {
          const e = src[++i];
          const map: Record<string, string> = { n: "\n", r: "\r", t: "\t", b: "\b", f: "\f", v: "\v", "0": "\0" };
          if (e === "u" && /^[0-9a-fA-F]{4}$/.test(src.slice(i + 1, i + 5))) {
            s += String.fromCharCode(parseInt(src.slice(i + 1, i + 5), 16));
            i += 5;
            continue;
          }
          if (e === "x" && /^[0-9a-fA-F]{2}$/.test(src.slice(i + 1, i + 3))) {
            s += String.fromCharCode(parseInt(src.slice(i + 1, i + 3), 16));
            i += 3;
            continue;
          }
          s += map[e] ?? e;
          i++;
          continue;
        }
        s += src[i++];
      }
      if (i >= src.length) throw new ShellError("문자열이 닫히지 않았습니다", at);
      i++;
      out.push({ k: "str", v: s, at });
      continue;
    }
    if (/[0-9]/.test(c) || (c === "." && /[0-9]/.test(src[i + 1] ?? ""))) {
      const m = /^(0[xX][0-9a-fA-F]+|(\d+\.?\d*|\.\d+)([eE][+-]?\d+)?)/.exec(src.slice(i))!;
      out.push({ k: "num", v: m[0], at });
      i += m[0].length;
      continue;
    }
    if (isIdStart(c)) {
      let j = i;
      while (j < src.length && isId(src[j])) j++;
      out.push({ k: "id", v: src.slice(i, j), at });
      i = j;
      continue;
    }
    if (c === "/" && prevAllowsRegex()) {
      let j = i + 1;
      let inClass = false;
      while (j < src.length && (src[j] !== "/" || inClass)) {
        if (src[j] === "\\") j++;
        else if (src[j] === "[") inClass = true;
        else if (src[j] === "]") inClass = false;
        j++;
      }
      if (j >= src.length) throw new ShellError("정규식이 닫히지 않았습니다", at);
      const pattern = src.slice(i + 1, j);
      let k = j + 1;
      while (k < src.length && /[a-z]/.test(src[k])) k++;
      out.push({ k: "regex", v: pattern, flags: src.slice(j + 1, k), at });
      i = k;
      continue;
    }
    if ("{}[](),:.;-+=".includes(c)) {
      out.push({ k: "p", v: c, at });
      i++;
      continue;
    }
    throw new ShellError(`해석할 수 없는 문자 '${c}'`, at);
  }
  out.push({ k: "eof", at: src.length });
  return out;
}

// ── 구문 트리 ───────────────────────────────────────────

export type Node =
  | { t: "lit"; v: EJson; at: number }
  | { t: "num"; v: string; at: number }
  | { t: "obj"; entries: [string, Node][]; at: number }
  | { t: "arr"; items: Node[]; at: number }
  | { t: "id"; name: string; at: number }
  | { t: "member"; obj: Node; name: string; at: number }
  | { t: "call"; fn: Node; args: Node[]; isNew: boolean; at: number }
  | { t: "regex"; pattern: string; flags: string; at: number };

export class Parser {
  private i = 0;
  constructor(
    private toks: Tok[],
    private src: string,
  ) {}

  static parse(src: string): Node {
    const p = new Parser(tokenize(src), src);
    const n = p.expr();
    p.skip(";");
    p.expectEof();
    return n;
  }

  get peek() {
    return this.toks[this.i];
  }
  private next() {
    return this.toks[this.i++];
  }
  isP(v: string) {
    const t = this.peek;
    return t.k === "p" && t.v === v;
  }
  skip(v: string) {
    if (this.isP(v)) this.i++;
  }
  private expect(v: string) {
    if (!this.isP(v)) throw new ShellError(`'${v}'가 필요합니다`, this.peek.at);
    this.i++;
  }
  expectEof() {
    if (this.peek.k !== "eof") throw new ShellError("문장 끝에 해석할 수 없는 내용이 있습니다 (변수·함수·반복문은 지원하지 않습니다)", this.peek.at);
  }

  expr(): Node {
    let n = this.primary();
    for (;;) {
      if (this.isP(".")) {
        this.i++;
        const t = this.next();
        if (t.k !== "id") throw new ShellError("'.' 뒤에 이름이 필요합니다", t.at);
        n = { t: "member", obj: n, name: t.v, at: t.at };
      } else if (this.isP("[")) {
        const at = this.peek.at;
        this.i++;
        const t = this.next();
        if (t.k !== "str") throw new ShellError("[ ] 안에는 문자열 이름만 쓸 수 있습니다", t.at);
        this.expect("]");
        n = { t: "member", obj: n, name: t.v, at };
      } else if (this.isP("(")) {
        n = { t: "call", fn: n, args: this.args(), isNew: false, at: n.at };
      } else return n;
    }
  }

  private args(): Node[] {
    this.expect("(");
    const out: Node[] = [];
    while (!this.isP(")")) {
      out.push(this.expr());
      if (!this.isP(")")) this.expect(",");
    }
    this.expect(")");
    return out;
  }

  private primary(): Node {
    const t = this.next();
    switch (t.k) {
      case "str":
        return { t: "lit", v: t.v, at: t.at };
      case "num":
        return { t: "num", v: t.v, at: t.at };
      case "regex":
        return { t: "regex", pattern: t.v, flags: t.flags, at: t.at };
      case "id":
        if (t.v === "true" || t.v === "false") return { t: "lit", v: t.v === "true", at: t.at };
        if (t.v === "null" || t.v === "undefined") return { t: "lit", v: null, at: t.at };
        if (t.v === "new") {
          const fn = this.next();
          if (fn.k !== "id") throw new ShellError("new 뒤에 생성자 이름이 필요합니다", fn.at);
          return { t: "call", fn: { t: "id", name: fn.v, at: fn.at }, args: this.isP("(") ? this.args() : [], isNew: true, at: t.at };
        }
        return { t: "id", name: t.v, at: t.at };
      case "p":
        if (t.v === "{") return this.object(t.at);
        if (t.v === "[") return this.array(t.at);
        if (t.v === "(") {
          const n = this.expr();
          this.expect(")");
          return n;
        }
        if (t.v === "-" || t.v === "+") {
          const n = this.primary();
          if (n.t === "num") return { t: "num", v: t.v === "-" ? (n.v.startsWith("-") ? n.v.slice(1) : "-" + n.v) : n.v, at: t.at };
          if (n.t === "id" && (n.name === "Infinity" || n.name === "NaN")) return { t: "num", v: (t.v === "-" ? "-" : "") + n.name, at: t.at };
          throw new ShellError("부호 뒤에는 숫자가 와야 합니다", n.at);
        }
        throw new ShellError(`예상하지 못한 '${t.v}'`, t.at);
      case "eof":
        throw new ShellError("입력이 끝났습니다", t.at);
    }
  }

  private object(at: number): Node {
    const entries: [string, Node][] = [];
    while (!this.isP("}")) {
      const k = this.next();
      if (k.k !== "id" && k.k !== "str" && k.k !== "num") throw new ShellError("필드 이름이 필요합니다", k.at);
      this.expect(":");
      entries.push([k.v, this.expr()]);
      if (!this.isP("}")) this.expect(",");
    }
    this.expect("}");
    return { t: "obj", entries, at };
  }

  private array(at: number): Node {
    const items: Node[] = [];
    while (!this.isP("]")) {
      items.push(this.expr());
      if (!this.isP("]")) this.expect(",");
    }
    this.expect("]");
    return { t: "arr", items, at };
  }

  /** 원문 위치 → 줄:칸 */
  where(at: number) {
    const before = this.src.slice(0, at).split("\n");
    return `${before.length}:${before[before.length - 1].length + 1}`;
  }
}

// ── 값 평가: 구문 트리 → Canonical EJSON ─────────────────

const INT32_MIN = -2147483648;
const INT32_MAX = 2147483647;

export function numberEJson(v: string): EJson {
  if (v === "Infinity" || v === "-Infinity" || v === "NaN") return { $numberDouble: v };
  if (/^-?0[xX]/.test(v)) return intEJson(BigInt(v.replace("-", "")) * (v.startsWith("-") ? -1n : 1n));
  if (/^-?\d+$/.test(v)) return intEJson(BigInt(v));
  const d = Number(v);
  return { $numberDouble: Number.isInteger(d) ? d.toFixed(1) : String(d) };
}

function intEJson(n: bigint): EJson {
  if (n >= BigInt(INT32_MIN) && n <= BigInt(INT32_MAX)) return { $numberInt: n.toString() };
  return { $numberLong: n.toString() };
}

const strArg = (n: Node | undefined, what: string): string => {
  if (n?.t === "lit" && typeof n.v === "string") return n.v;
  if (n?.t === "num") return n.v;
  throw new ShellError(`${what}에는 문자열이 필요합니다`, n?.at ?? 0);
};

function dateEJson(s: string | undefined, at: number): EJson {
  const ms = s === undefined ? Date.now() : /^-?\d+$/.test(s) ? Number(s) : Date.parse(/^\d{4}-\d{2}-\d{2}$/.test(s) ? s + "T00:00:00Z" : s);
  if (Number.isNaN(ms)) throw new ShellError(`날짜를 해석할 수 없습니다: ${s}`, at);
  return { $date: { $numberLong: String(ms) } };
}

function base64OfHex(hex: string): string {
  let bin = "";
  for (let i = 0; i < hex.length; i += 2) bin += String.fromCharCode(parseInt(hex.slice(i, i + 2), 16));
  return btoa(bin);
}

export function evalValue(n: Node): EJson {
  switch (n.t) {
    case "lit":
      return n.v;
    case "num":
      return numberEJson(n.v);
    case "obj":
      return Object.fromEntries(n.entries.map(([k, v]) => [k, evalValue(v)]));
    case "arr":
      return n.items.map(evalValue);
    case "regex":
      return { $regularExpression: { pattern: n.pattern, options: n.flags.split("").sort().join("") } };
    case "id":
      if (n.name === "MinKey") return { $minKey: 1 };
      if (n.name === "MaxKey") return { $maxKey: 1 };
      if (n.name === "Infinity" || n.name === "NaN") return { $numberDouble: n.name };
      throw new ShellError(`알 수 없는 이름 '${n.name}' (변수는 지원하지 않습니다)`, n.at);
    case "member":
      throw new ShellError("값 자리에는 속성 접근을 쓸 수 없습니다", n.at);
    case "call": {
      if (n.fn.t !== "id") throw new ShellError("값 자리에는 생성자 호출만 쓸 수 있습니다", n.at);
      const a = n.args;
      switch (n.fn.name) {
        case "ObjectId": {
          const hex = a.length ? strArg(a[0], "ObjectId") : "";
          if (!/^[0-9a-fA-F]{24}$/.test(hex)) throw new ShellError("ObjectId는 24자리 16진수입니다", n.at);
          return { $oid: hex.toLowerCase() };
        }
        case "ISODate":
        case "Date":
          return dateEJson(a.length ? strArg(a[0], "날짜") : undefined, n.at);
        case "NumberLong":
        case "Long":
          return { $numberLong: BigInt(strArg(a[0], "NumberLong")).toString() };
        case "NumberInt":
        case "Int32": {
          const v = Number(strArg(a[0], "NumberInt"));
          if (!Number.isInteger(v) || v < INT32_MIN || v > INT32_MAX) throw new ShellError("NumberInt 범위를 벗어났습니다", n.at);
          return { $numberInt: String(v) };
        }
        case "NumberDecimal":
        case "Decimal128":
          return { $numberDecimal: strArg(a[0], "NumberDecimal") };
        case "Double": {
          const v = Number(strArg(a[0], "Double"));
          return { $numberDouble: Number.isInteger(v) ? v.toFixed(1) : String(v) };
        }
        case "BinData": {
          const sub = Number(strArg(a[0], "BinData 하위 타입"));
          return { $binary: { base64: strArg(a[1], "BinData"), subType: sub.toString(16).padStart(2, "0") } };
        }
        case "UUID": {
          const hex = strArg(a[0], "UUID").replace(/-/g, "");
          if (!/^[0-9a-fA-F]{32}$/.test(hex)) throw new ShellError("UUID 형식이 아닙니다", n.at);
          return { $binary: { base64: base64OfHex(hex), subType: "04" } };
        }
        case "Timestamp": {
          if (a[0]?.t === "obj") {
            const o = evalValue(a[0]) as Record<string, EJson>;
            return { $timestamp: { t: Number(unwrapNum(o.t)), i: Number(unwrapNum(o.i)) } };
          }
          return { $timestamp: { t: Number(strArg(a[0], "Timestamp")), i: Number(strArg(a[1], "Timestamp")) } };
        }
        case "MinKey":
          return { $minKey: 1 };
        case "MaxKey":
          return { $maxKey: 1 };
        case "RegExp":
          return { $regularExpression: { pattern: strArg(a[0], "RegExp"), options: a[1] ? strArg(a[1], "RegExp 옵션") : "" } };
      }
      throw new ShellError(`지원하지 않는 함수 ${n.fn.name}()`, n.at);
    }
  }
}

const unwrapNum = (v: EJson): string => {
  if (v && typeof v === "object" && !Array.isArray(v)) {
    const x = v.$numberInt ?? v.$numberLong ?? v.$numberDouble;
    if (typeof x === "string") return x;
  }
  return String(v);
};

/** mongosh 표기 텍스트 → Canonical EJSON. 빈 문자열은 null */
export function parseShellValue(text: string): EJson {
  if (!text.trim()) return null;
  return evalValue(Parser.parse(text));
}

// ── 표시: Canonical EJSON → mongosh 표기 ─────────────────

const isPlainKey = (k: string) => /^[A-Za-z_$][A-Za-z0-9_$]*$/.test(k);
const quote = (s: string) => JSON.stringify(s);

/** 특수 타입 래퍼면 mongosh 표기 문자열 */
function special(v: { [k: string]: EJson }): string | null {
  const keys = Object.keys(v);
  if (keys.length === 1) {
    const k = keys[0];
    const x = v[k];
    switch (k) {
      case "$oid":
        return `ObjectId(${quote(String(x))})`;
      case "$numberInt":
        return String(x);
      case "$numberLong":
        return `NumberLong(${quote(String(x))})`;
      case "$numberDouble": {
        const s = String(x);
        if (s === "Infinity" || s === "-Infinity" || s === "NaN") return s;
        return /[.eE]/.test(s) ? s : s + ".0";
      }
      case "$numberDecimal":
        return `NumberDecimal(${quote(String(x))})`;
      case "$date": {
        const ms = typeof x === "object" && x && !Array.isArray(x) ? Number(x.$numberLong) : Date.parse(String(x));
        const d = new Date(ms);
        return Number.isNaN(d.getTime()) || ms < -62135596800000 || ms > 253402300799999 ? `Date(${ms})` : `ISODate(${quote(d.toISOString())})`;
      }
      case "$binary": {
        const b = x as { base64: string; subType: string };
        if (b.subType === "04") {
          const hex = Array.from(atob(b.base64), (c) => c.charCodeAt(0).toString(16).padStart(2, "0")).join("");
          if (hex.length === 32) return `UUID(${quote(`${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`)})`;
        }
        return `BinData(${parseInt(b.subType, 16)}, ${quote(b.base64)})`;
      }
      case "$regularExpression": {
        const r = x as { pattern: string; options: string };
        return `/${r.pattern}/${r.options}`;
      }
      case "$timestamp": {
        const t = x as { t: number; i: number };
        return `Timestamp({ t: ${t.t}, i: ${t.i} })`;
      }
      case "$minKey":
        return "MinKey()";
      case "$maxKey":
        return "MaxKey()";
      case "$symbol":
        return quote(String(x));
      case "$undefined":
        return "undefined";
    }
  }
  if (keys.length === 2 && "$code" in v && "$scope" in v) return `Code(${quote(String(v.$code))})`;
  if (keys.length === 1 && keys[0] === "$code") return `Code(${quote(String(v.$code))})`;
  return null;
}

/** indent가 있으면 여러 줄로 들여쓴다 (JSON 보기). 없으면 한 줄 (그리드 셀) */
export function formatShell(v: EJson, indent = 0, depth = 0): string {
  if (v === null) return "null";
  if (typeof v === "boolean" || typeof v === "number") return String(v);
  if (typeof v === "string") return quote(v);
  const pad = indent ? "\n" + " ".repeat(indent * (depth + 1)) : " ";
  const end = indent ? "\n" + " ".repeat(indent * depth) : " ";
  if (Array.isArray(v)) {
    if (!v.length) return "[]";
    const items = v.map((x) => formatShell(x, indent, depth + 1));
    return indent ? `[${pad}${items.join("," + pad)}${end}]` : `[ ${items.join(", ")} ]`;
  }
  const s = special(v);
  if (s !== null) return s;
  const entries = Object.entries(v);
  if (!entries.length) return "{}";
  const items = entries.map(([k, x]) => `${isPlainKey(k) ? k : quote(k)}: ${formatShell(x, indent, depth + 1)}`);
  return indent ? `{${pad}${items.join("," + pad)}${end}}` : `{ ${items.join(", ")} }`;
}

/** 특수 타입 이름 (편집 시 원래 타입 유지 판단용) */
export function bsonType(v: EJson): string {
  if (v === null) return "null";
  if (typeof v === "boolean") return "bool";
  if (typeof v === "number") return "number";
  if (typeof v === "string") return "string";
  if (Array.isArray(v)) return "array";
  const k = Object.keys(v);
  if (k.length === 1 && k[0].startsWith("$")) return k[0].slice(1);
  return "object";
}
