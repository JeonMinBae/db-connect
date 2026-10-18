import type { CompletionContext, CompletionResult } from "@codemirror/autocomplete";
import { EditorState, type Extension } from "@codemirror/state";

/** 자동완성용 명령 이름과 인자 요약 (자주 쓰는 것) */
const COMMANDS: [string, string][] = [
  ["GET", "key"], ["SET", "key value [EX s|PX ms|KEEPTTL] [NX|XX]"], ["MGET", "key [key …]"], ["MSET", "key value [key value …]"],
  ["GETRANGE", "key start end"], ["STRLEN", "key"], ["APPEND", "key value"], ["INCR", "key"], ["INCRBY", "key n"], ["DECR", "key"],
  ["DEL", "key [key …]"], ["UNLINK", "key [key …]"], ["EXISTS", "key [key …]"], ["TYPE", "key"], ["RENAME", "key newkey"],
  ["EXPIRE", "key seconds"], ["PEXPIRE", "key ms"], ["PERSIST", "key"], ["TTL", "key"], ["PTTL", "key"], ["OBJECT", "ENCODING|FREQ|IDLETIME key"],
  ["MEMORY", "USAGE key"], ["DUMP", "key"], ["COPY", "src dst [DB n] [REPLACE]"], ["MOVE", "key db"],
  ["SCAN", "cursor [MATCH pattern] [COUNT n] [TYPE t]"], ["KEYS", "pattern (주의: 느림)"], ["RANDOMKEY", ""], ["DBSIZE", ""],
  ["HGET", "key field"], ["HSET", "key field value [field value …]"], ["HGETALL", "key"], ["HDEL", "key field [field …]"], ["HKEYS", "key"],
  ["HVALS", "key"], ["HLEN", "key"], ["HEXISTS", "key field"], ["HINCRBY", "key field n"], ["HSCAN", "key cursor [MATCH p] [COUNT n]"],
  ["LPUSH", "key value [value …]"], ["RPUSH", "key value [value …]"], ["LPOP", "key [count]"], ["RPOP", "key [count]"], ["LRANGE", "key start stop"],
  ["LLEN", "key"], ["LINDEX", "key index"], ["LSET", "key index value"], ["LREM", "key count value"], ["LTRIM", "key start stop"], ["BLPOP", "key [key …] timeout"],
  ["SADD", "key member [member …]"], ["SREM", "key member [member …]"], ["SMEMBERS", "key"], ["SISMEMBER", "key member"], ["SCARD", "key"],
  ["SSCAN", "key cursor [MATCH p] [COUNT n]"], ["SINTER", "key [key …]"], ["SUNION", "key [key …]"], ["SDIFF", "key [key …]"],
  ["ZADD", "key [NX|XX] score member [score member …]"], ["ZREM", "key member [member …]"], ["ZRANGE", "key start stop [BYSCORE|BYLEX] [REV] [WITHSCORES]"],
  ["ZSCORE", "key member"], ["ZCARD", "key"], ["ZRANK", "key member"], ["ZINCRBY", "key n member"], ["ZSCAN", "key cursor [MATCH p] [COUNT n]"],
  ["XADD", "key [MAXLEN n] *|id field value [field value …]"], ["XRANGE", "key start end [COUNT n]"], ["XREVRANGE", "key end start [COUNT n]"],
  ["XLEN", "key"], ["XDEL", "key id [id …]"], ["XINFO", "STREAM|GROUPS key"], ["XREAD", "[COUNT n] [BLOCK ms] STREAMS key [key …] id [id …]"],
  ["PFADD", "key element [element …]"], ["PFCOUNT", "key [key …]"], ["GEOADD", "key lon lat member"], ["GEOSEARCH", "key FROMMEMBER m BYRADIUS r unit"],
  ["PUBLISH", "channel message"], ["PUBSUB", "CHANNELS [pattern]"], ["SELECT", "db"], ["PING", "[message]"], ["ECHO", "message"],
  ["INFO", "[section]"], ["CLIENT", "LIST|INFO|KILL …"], ["CONFIG", "GET parameter"], ["SLOWLOG", "GET [n]"], ["TIME", ""], ["LASTSAVE", ""],
  ["COMMAND", "[COUNT|INFO name|DOCS name]"], ["MONITOR", "(콘솔에서는 지원하지 않음)"], ["FLUSHDB", "[ASYNC] (주의)"], ["FLUSHALL", "[ASYNC] (주의)"],
  ["JSON.GET", "key [path …]"], ["JSON.SET", "key path value"],
];

function complete(ctx: CompletionContext): CompletionResult | null {
  const line = ctx.state.doc.lineAt(ctx.pos);
  const before = line.text.slice(0, ctx.pos - line.from);
  // 줄의 첫 단어만 명령으로 자동완성한다
  const m = /^\s*([A-Za-z.]*)$/.exec(before);
  if (!m || (!m[1] && !ctx.explicit)) return null;
  return {
    from: ctx.pos - m[1].length,
    options: COMMANDS.map(([label, detail]) => ({ label, detail, type: "keyword" })),
    validFor: /^[A-Za-z.]*$/,
  };
}

/** Redis 콘솔 에디터 언어: 명령 이름 자동완성만 */
export const redisLanguage: Extension = EditorState.languageData.of(() => [{ autocomplete: complete }]);
