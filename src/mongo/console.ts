import { evalValue, Parser, ShellError, type EJson, type Node } from "./shell";

/** 콘솔·미리보기에서 실행하는 작업. 문서 값은 Canonical EJSON. */
export type MongoOp =
  | { kind: "find"; coll: string; filter: EJson; projection: EJson; sort: EJson; skip: number; limit: number | null }
  | { kind: "aggregate"; coll: string; pipeline: EJson[] }
  | { kind: "countDocuments"; coll: string; filter: EJson }
  | { kind: "estimatedDocumentCount"; coll: string }
  | { kind: "distinct"; coll: string; field: string; filter: EJson }
  | { kind: "insertOne"; coll: string; doc: EJson }
  | { kind: "insertMany"; coll: string; docs: EJson[] }
  | { kind: "updateOne" | "updateMany"; coll: string; filter: EJson; update: EJson; upsert: boolean }
  | { kind: "replaceOne"; coll: string; filter: EJson; doc: EJson; upsert: boolean }
  | { kind: "deleteOne" | "deleteMany"; coll: string; filter: EJson }
  | { kind: "runCommand"; command: EJson }
  | { kind: "showDbs" }
  | { kind: "showCollections" }
  | { kind: "use"; db: string };

export const WRITE_KINDS = new Set(["insertOne", "insertMany", "updateOne", "updateMany", "replaceOne", "deleteOne", "deleteMany"]);

/** 결과 집합을 돌려주는 작업 (그리드로 보여 준다) */
export const isQueryOp = (op: MongoOp) => op.kind === "find" || op.kind === "aggregate";

export interface MongoStmt {
  text: string;
  from: number;
  to: number;
}

/**
 * 문장 나누기: 줄 첫머리의 `db.` / `show ` / `use `에서 새 문장이 시작한다 (한 문장이 여러 줄이어도 된다).
 * 같은 줄의 `;` 뒤에 오는 문장도 나눈다.
 */
export function splitMongo(src: string): MongoStmt[] {
  const starts: number[] = [];
  const re = /^[ \t]*(db\b|show\s|use\s)/gm;
  for (let m; (m = re.exec(src)); ) starts.push(m.index + m[0].length - m[0].trimStart().length);
  // ;로 이어진 같은 줄 문장: "…; db.x" 형태
  const semi = /;[ \t]*(?=db\.|show\s|use\s)/g;
  for (let m; (m = semi.exec(src)); ) starts.push(m.index + m[0].length);
  starts.sort((a, b) => a - b);
  const out: MongoStmt[] = [];
  for (let i = 0; i < starts.length; i++) {
    const from = starts[i];
    let to = i + 1 < starts.length ? starts[i + 1] : src.length;
    let text = src.slice(from, to);
    // 뒤쪽 공백·세미콜론·주석 줄 제거
    for (let prev = ""; prev !== text; ) {
      prev = text;
      text = text.replace(/\n[ \t]*\/\/[^\n]*\s*$/, "").replace(/[\s;]+$/, "");
    }
    to = from + text.length;
    if (text) out.push({ text, from, to });
  }
  return out;
}

export function statementAtPos(stmts: MongoStmt[], pos: number): MongoStmt | null {
  let best: MongoStmt | null = null;
  for (const s of stmts) if (s.from <= pos) best = s;
  return best ?? stmts[0] ?? null;
}

type Seg = { name: string; args: Node[] | null; at: number };

/** db.a.find(x).sort(y) → root "db", [a], [find(x)], [sort(y)] */
function flatten(n: Node): { root: string; segs: Seg[] } {
  if (n.t === "id") return { root: n.name, segs: [] };
  if (n.t === "member") {
    const f = flatten(n.obj);
    f.segs.push({ name: n.name, args: null, at: n.at });
    return f;
  }
  if (n.t === "call" && !n.isNew) {
    const f = flatten(n.fn);
    const last = f.segs[f.segs.length - 1];
    if (!last || last.args) throw new ShellError("호출할 수 없는 식입니다", n.at);
    last.args = n.args;
    return f;
  }
  throw new ShellError("db.<컬렉션>.<메서드>(…) 형태만 지원합니다", n.at);
}

const asObj = (n: Node | undefined, what: string, dflt: EJson = {}): EJson => {
  if (!n) return dflt;
  const v = evalValue(n);
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw new ShellError(`${what}는 객체({…})여야 합니다`, n.at);
  return v;
};

const asArr = (n: Node | undefined, what: string): EJson[] => {
  const v = n ? evalValue(n) : null;
  if (!Array.isArray(v)) throw new ShellError(`${what}는 배열([…])이어야 합니다`, n?.at ?? 0);
  return v;
};

const asInt = (n: Node | undefined, what: string): number => {
  const v = n ? evalValue(n) : null;
  const s = v && typeof v === "object" && !Array.isArray(v) ? (v.$numberInt ?? v.$numberLong ?? v.$numberDouble) : v;
  const x = Number(s);
  if (!Number.isInteger(x) || x < 0) throw new ShellError(`${what}에는 0 이상의 정수가 필요합니다`, n?.at ?? 0);
  return x;
};

const upsertOf = (n: Node | undefined) => {
  if (!n) return false;
  const o = asObj(n, "옵션") as Record<string, EJson>;
  return o.upsert === true;
};

export function parseMongoCommand(text: string): MongoOp {
  const t = text.trim().replace(/;\s*$/, "");
  const show = /^show\s+(dbs|databases|collections|tables)$/i.exec(t);
  if (show) return show[1].toLowerCase().startsWith("d") ? { kind: "showDbs" } : { kind: "showCollections" };
  const use = /^use\s+(\S+)$/i.exec(t);
  if (use) return { kind: "use", db: use[1] };

  const { root, segs } = flatten(Parser.parse(t));
  if (root !== "db") throw new ShellError("문장은 db. 로 시작해야 합니다", 0);
  if (!segs.length) throw new ShellError("db 뒤에 컬렉션과 메서드가 필요합니다", 0);

  // db.runCommand({...}) / db.adminCommand
  if (segs[0].args && (segs[0].name === "runCommand" || segs[0].name === "adminCommand")) {
    if (segs.length > 1) throw new ShellError("runCommand 뒤에는 체인을 쓸 수 없습니다", segs[1].at);
    return { kind: "runCommand", command: asObj(segs[0].args[0], "명령") };
  }

  // 컬렉션: db.name / db.getCollection("name")
  let coll: string;
  let rest: Seg[];
  if (segs[0].name === "getCollection" && segs[0].args) {
    const v = segs[0].args[0] ? evalValue(segs[0].args[0]) : null;
    if (typeof v !== "string") throw new ShellError("getCollection에는 이름 문자열이 필요합니다", segs[0].at);
    coll = v;
    rest = segs.slice(1);
  } else {
    if (segs[0].args) throw new ShellError(`지원하지 않는 db 메서드 ${segs[0].name}()`, segs[0].at);
    coll = segs[0].name;
    rest = segs.slice(1);
  }
  // 컬렉션 이름에 점이 있으면 db.a.b.find() 형태 → 메서드 전까지 이어 붙인다
  while (rest.length && !rest[0].args) {
    coll += "." + rest[0].name;
    rest = rest.slice(1);
  }
  const [m, ...chain] = rest;
  if (!m) throw new ShellError("메서드 호출이 필요합니다 (예: .find())", 0);
  const a = m.args!;
  const noChain = () => {
    if (chain.length) throw new ShellError(`${m.name}() 뒤에는 체인을 쓸 수 없습니다`, chain[0].at);
  };

  switch (m.name) {
    case "find":
    case "findOne": {
      const op: Extract<MongoOp, { kind: "find" }> = {
        kind: "find",
        coll,
        filter: asObj(a[0], "필터"),
        projection: asObj(a[1], "프로젝션"),
        sort: {},
        skip: 0,
        limit: m.name === "findOne" ? 1 : null,
      };
      for (const c of chain) {
        if (!c.args) throw new ShellError(`${c.name} 뒤에 ( )가 필요합니다`, c.at);
        if (c.name === "sort") op.sort = asObj(c.args[0], "정렬");
        else if (c.name === "projection") op.projection = asObj(c.args[0], "프로젝션");
        else if (c.name === "skip") op.skip = asInt(c.args[0], "skip");
        else if (c.name === "limit") op.limit = asInt(c.args[0], "limit");
        else if (c.name === "pretty" || c.name === "toArray") continue;
        else if (c.name === "count") throw new ShellError("find().count() 대신 countDocuments()를 쓰세요", c.at);
        else throw new ShellError(`지원하지 않는 커서 메서드 ${c.name}()`, c.at);
      }
      return op;
    }
    case "aggregate":
      noChain();
      return { kind: "aggregate", coll, pipeline: asArr(a[0], "파이프라인") };
    case "countDocuments":
    case "count":
      noChain();
      return { kind: "countDocuments", coll, filter: asObj(a[0], "필터") };
    case "estimatedDocumentCount":
      noChain();
      return { kind: "estimatedDocumentCount", coll };
    case "distinct": {
      noChain();
      const f = a[0] ? evalValue(a[0]) : null;
      if (typeof f !== "string") throw new ShellError("distinct에는 필드 이름이 필요합니다", m.at);
      return { kind: "distinct", coll, field: f, filter: asObj(a[1], "필터") };
    }
    case "insertOne":
      noChain();
      return { kind: "insertOne", coll, doc: asObj(a[0], "문서") };
    case "insertMany":
      noChain();
      return { kind: "insertMany", coll, docs: asArr(a[0], "문서 목록") };
    case "updateOne":
    case "updateMany": {
      noChain();
      const update = a[1] ? evalValue(a[1]) : null;
      if (update === null || typeof update !== "object") throw new ShellError("변경 내용({$set: …} 또는 파이프라인)이 필요합니다", m.at);
      return { kind: m.name, coll, filter: asObj(a[0], "필터"), update, upsert: upsertOf(a[2]) };
    }
    case "replaceOne":
      noChain();
      return { kind: "replaceOne", coll, filter: asObj(a[0], "필터"), doc: asObj(a[1], "새 문서"), upsert: upsertOf(a[2]) };
    case "deleteOne":
    case "deleteMany":
      noChain();
      return { kind: m.name, coll, filter: asObj(a[0], "필터") };
  }
  throw new ShellError(`지원하지 않는 메서드 ${m.name}()`, m.at);
}

/** 빈 필터로 여러 문서를 바꾸는 작업 (실행 전 확인) */
export function riskyOp(op: MongoOp): string | null {
  const empty = (f: EJson) => f !== null && typeof f === "object" && !Array.isArray(f) && Object.keys(f).length === 0;
  if ((op.kind === "updateMany" || op.kind === "deleteMany") && empty(op.filter)) return `필터가 비어 있어 컬렉션 '${op.coll}'의 모든 문서를 ${op.kind === "deleteMany" ? "삭제" : "변경"}합니다.`;
  if (op.kind === "runCommand" && op.command && typeof op.command === "object" && !Array.isArray(op.command)) {
    const name = Object.keys(op.command)[0]?.toLowerCase();
    if (name === "drop" || name === "dropdatabase") return `${Object.keys(op.command)[0]} 명령을 실행합니다.`;
  }
  return null;
}
