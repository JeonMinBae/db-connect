import { argOfBytes, type Arg } from "./bytes";

/** 인자를 redis-cli 입력 형식으로 (필요할 때만 따옴표) */
export function quoteArg(a: Arg): string {
  if (typeof a === "string") {
    if (a !== "" && /^[^\s"'\\]+$/.test(a)) return a;
    return `"${a.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r").replace(/\t/g, "\\t")}"`;
  }
  return `"${a.hex.replace(/../g, (h) => `\\x${h}`)}"`;
}

export const formatCommand = (argv: Arg[]) => argv.map(quoteArg).join(" ");

/**
 * redis-cli 규칙으로 한 줄을 인자로 나눈다.
 * - 공백으로 구분, "…" 안에서는 \n \r \t \a \b \\ \" \xNN 이스케이프
 * - '…' 안에서는 \' 만 이스케이프
 * - 따옴표가 닫히지 않거나 닫는 따옴표 뒤에 공백이 없으면 오류
 */
export function splitRedisArgs(line: string): Arg[] {
  const out: Arg[] = [];
  const enc = new TextEncoder();
  let i = 0;
  const n = line.length;
  while (i < n) {
    while (i < n && /\s/.test(line[i])) i++;
    if (i >= n) break;
    const bytes: number[] = [];
    let quoted: '"' | "'" | null = null;
    let done = false;
    while (!done) {
      if (i >= n) {
        if (quoted) throw new Error(`따옴표(${quoted})가 닫히지 않았습니다`);
        break;
      }
      const c = line[i];
      if (quoted === '"') {
        if (c === "\\" && i + 1 < n) {
          const e = line[i + 1];
          const map: Record<string, number> = { n: 10, r: 13, t: 9, a: 7, b: 8, "\\": 92, '"': 34 };
          if (e === "x" && /^[0-9a-fA-F]{2}$/.test(line.slice(i + 2, i + 4))) {
            bytes.push(parseInt(line.slice(i + 2, i + 4), 16));
            i += 4;
          } else if (e in map) {
            bytes.push(map[e]);
            i += 2;
          } else {
            bytes.push(...enc.encode(e));
            i += 2;
          }
          continue;
        }
        if (c === '"') {
          i++;
          if (i < n && !/\s/.test(line[i])) throw new Error("닫는 따옴표 뒤에는 공백이 와야 합니다");
          done = true;
          continue;
        }
      } else if (quoted === "'") {
        if (c === "\\" && line[i + 1] === "'") {
          bytes.push(39);
          i += 2;
          continue;
        }
        if (c === "'") {
          i++;
          if (i < n && !/\s/.test(line[i])) throw new Error("닫는 따옴표 뒤에는 공백이 와야 합니다");
          done = true;
          continue;
        }
      } else {
        if (/\s/.test(c)) {
          done = true;
          continue;
        }
        if ((c === '"' || c === "'") && bytes.length === 0) {
          quoted = c;
          i++;
          continue;
        }
      }
      const cp = line.codePointAt(i)!;
      const ch = String.fromCodePoint(cp);
      bytes.push(...enc.encode(ch));
      i += ch.length;
    }
    out.push(argOfBytes(Uint8Array.from(bytes)));
  }
  return out;
}

/** 위험 명령: 실행 전에 확인한다 */
export function riskyCommand(argv: Arg[]): string | null {
  const name = typeof argv[0] === "string" ? argv[0].toUpperCase() : "";
  if (name === "FLUSHALL") return "모든 DB의 키를 지웁니다.";
  if (name === "FLUSHDB") return "이 DB의 모든 키를 지웁니다.";
  if (name === "KEYS") return "KEYS는 키가 많으면 서버를 오래 멈추게 합니다. SCAN이나 트리의 패턴 필터를 권장합니다.";
  if (name === "SHUTDOWN") return "서버를 종료합니다.";
  return null;
}
