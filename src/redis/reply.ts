import { showBytes, type Bytes } from "./bytes";

/** 백엔드 응답 (db/redis.rs Reply) */
export type Reply =
  | { t: "Nil" }
  | { t: "Int"; v: number }
  | { t: "Double"; v: number }
  | { t: "Bool"; v: boolean }
  | { t: "Status"; v: string }
  | { t: "Error"; v: string }
  | { t: "Bulk"; v: Bytes }
  | { t: "Array"; v: Reply[] }
  | { t: "Map"; v: [Reply, Reply][] };

const quoted = (b: Bytes) =>
  `"${b.t === "Text" ? b.v.replace(/\\/g, "\\\\").replace(/"/g, '\\"').replace(/\n/g, "\\n").replace(/\r/g, "\\r") : b.v}"`;

/** redis-cli 형식 텍스트 */
export function renderReply(r: Reply, indent = ""): string {
  switch (r.t) {
    case "Nil":
      return "(nil)";
    case "Int":
      return `(integer) ${r.v}`;
    case "Double":
      return `(double) ${r.v}`;
    case "Bool":
      return `(boolean) ${r.v}`;
    case "Status":
      return r.v;
    case "Error":
      return `(error) ${r.v}`;
    case "Bulk":
      return quoted(r.v);
    case "Array":
    case "Map": {
      const items: Reply[] = r.t === "Array" ? r.v : r.v.flatMap(([k, v]) => [k, v]);
      if (!items.length) return "(empty array)";
      const w = String(items.length).length;
      return items
        .map((it, i) => {
          const no = `${String(i + 1).padStart(w)}) `;
          const body = renderReply(it, indent + " ".repeat(no.length));
          return (i === 0 ? "" : indent) + no + body;
        })
        .join("\n");
    }
  }
}

/** 배열 응답을 그리드로: 평탄 배열은 1컬럼, Map은 2컬럼. 중첩 항목은 텍스트로 */
export function replyRows(r: Reply): { columns: string[]; rows: string[][] } | null {
  const cell = (x: Reply) => (x.t === "Bulk" ? showBytes(x.v) : x.t === "Nil" ? "(nil)" : renderReply(x).replace(/\n\s*/g, " "));
  if (r.t === "Map") return { columns: ["key", "value"], rows: r.v.map(([k, v]) => [cell(k), cell(v)]) };
  if (r.t === "Array" && r.v.length) return { columns: ["#", "value"], rows: r.v.map((x, i) => [String(i + 1), cell(x)]) };
  return null;
}
