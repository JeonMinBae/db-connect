import type { Cell } from "../api/types";
import type { PendingChanges } from "../grid/pending";
import type { Arg } from "./bytes";
import type { RedisType } from "./view";

const textOf = (c: Cell, what: string): string => {
  if (c.t === "Text") return c.v;
  if (c.t === "Null") throw new Error(`${what}은(는) 비워 둘 수 없습니다 (Redis에는 NULL이 없습니다)`);
  throw new Error(`${what}: 바이너리 값은 편집할 수 없습니다`);
};

const scoreOf = (c: Cell): string => {
  const s = c.t === "Text" ? c.v.trim() : "";
  if (s === "") return "0";
  if (!/^[+-]?(\d+(\.\d*)?|\.\d+)([eE][+-]?\d+)?$|^[+-]?inf$/i.test(s)) throw new Error(`score가 숫자가 아닙니다: ${s}`);
  return s;
};

/** list 삭제 표식 (LSET으로 바꾼 뒤 LREM으로 지운다) */
export const listTombstone = () => `__dbc_deleted_${crypto.randomUUID()}__`;

/**
 * 그리드 보류 변경 → Redis 명령 목록.
 * 순서: 삭제 → 이름 바뀐 항목의 원래 이름 삭제 → 값 설정 → 추가
 */
export function redisCommands(type: Exclude<RedisType, "string" | "stream">, key: Arg, p: PendingChanges, tombstone = listTombstone()): Arg[][] {
  const del: Arg[][] = [];
  const set: Arg[][] = [];
  const add: Arg[][] = [];
  const cur = (r: number, c: number) => p.value(r, c);
  const orig = (r: number, c: number) => p.original[r][c];
  const changed = (r: number, c: number) => p.edits.get(r)?.has(c) ?? false;
  const deleted = [...p.deleted].sort((a, b) => a - b);
  const edited = [...p.edits.keys()].filter((r) => !p.deleted.has(r)).sort((a, b) => a - b);
  const inserted = p.inserted.map((_, i) => p.original.length + i);

  switch (type) {
    case "hash":
      for (const r of deleted) del.push(["HDEL", key, textOf(orig(r, 0), "field")]);
      for (const r of edited) {
        if (changed(r, 0)) del.push(["HDEL", key, textOf(orig(r, 0), "field")]);
        set.push(["HSET", key, textOf(cur(r, 0), "field"), textOf(cur(r, 1), "value")]);
      }
      for (const r of inserted) add.push(["HSET", key, textOf(cur(r, 0), "field"), textOf(cur(r, 1), "value")]);
      break;
    case "set":
      for (const r of deleted) del.push(["SREM", key, textOf(orig(r, 0), "member")]);
      for (const r of edited) {
        del.push(["SREM", key, textOf(orig(r, 0), "member")]);
        set.push(["SADD", key, textOf(cur(r, 0), "member")]);
      }
      for (const r of inserted) add.push(["SADD", key, textOf(cur(r, 0), "member")]);
      break;
    case "zset":
      for (const r of deleted) del.push(["ZREM", key, textOf(orig(r, 0), "member")]);
      for (const r of edited) {
        if (changed(r, 0)) del.push(["ZREM", key, textOf(orig(r, 0), "member")]);
        set.push(["ZADD", key, scoreOf(cur(r, 1)), textOf(cur(r, 0), "member")]);
      }
      for (const r of inserted) add.push(["ZADD", key, scoreOf(cur(r, 1)), textOf(cur(r, 0), "member")]);
      break;
    case "list": {
      // 값 수정을 먼저 (삭제하면 뒤 원소의 인덱스가 바뀐다)
      for (const r of edited) set.push(["LSET", key, textOf(orig(r, 0), "index"), textOf(cur(r, 1), "value")]);
      for (const r of deleted) set.push(["LSET", key, textOf(orig(r, 0), "index"), tombstone]);
      if (deleted.length) set.push(["LREM", key, "0", tombstone]);
      for (const r of inserted) add.push(["RPUSH", key, textOf(cur(r, 1), "value")]);
      break;
    }
  }
  return [...del, ...set, ...add];
}
