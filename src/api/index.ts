import { invoke } from "@tauri-apps/api/core";
import type { Change, Val } from "../grid/submit";
import type { Arg, Bytes } from "../redis/bytes";
import type { Reply } from "../redis/reply";
import type { EJson } from "../mongo/shell";
import type { MongoOp } from "../mongo/console";

export type MongoOut =
  | { t: "Docs"; docs: EJson[]; has_more: boolean }
  | { t: "Value"; value: EJson }
  | { t: "Write"; matched: number; modified: number; inserted: number; deleted: number; upserted: EJson | null }
  | { t: "Names"; names: string[] };
import type { ScanKey } from "../redis/keys";

export interface SubmitReq {
  conn_id: string;
  console_id: string | null;
  schema: string | null;
  table: string;
  key_mode: "pk" | "unique" | "allColumns";
  changes: Change[];
}

export interface RawStmt {
  sql: string;
  /** UPDATE/DELETE: 정확히 1행에 영향을 줘야 한다 */
  expect_one: boolean;
}
import type { AppError, ColumnMeta, ConnectionConfig, DdlChoices, DdlPlan, ExecResult, IndexInfo, SnapshotTable, TableInfo, TableStructure } from "./types";

/** 파일 경로는 넘기지 않는다. 백엔드가 대화상자로 고른다. */
export interface BlobReq {
  conn_id: string;
  console_id: string | null;
  schema: string | null;
  table: string;
  key_mode: "pk" | "unique" | "allColumns";
  key: Val[];
  column: string;
}

/** 대화상자를 취소하면 null */
export type FileResult = { path: string; bytes: number } | null;

export function errorMessage(e: unknown): string {
  if (typeof e === "string") return e;
  if (e && typeof e === "object" && "message" in e) return String((e as AppError).message);
  return String(e);
}

export const api = {
  // 접속
  listConnections: () => invoke<ConnectionConfig[]>("list_connections"),
  saveConnection: (config: ConnectionConfig, password: string | null) => invoke<void>("save_connection", { config, password }),
  deleteConnection: (id: string) => invoke<void>("delete_connection", { id }),
  reorderConnections: (ids: string[]) => invoke<void>("reorder_connections", { ids }),
  testConnection: (config: ConnectionConfig, password: string | null) => invoke<string>("test_connection", { config, password }),
  connect: (id: string) => invoke<{ default_schema: string; topology: "standalone" | "replicaset" | "sharded" | null }>("connect", { id }),
  disconnect: (id: string) => invoke<void>("disconnect", { id }),

  // 메타데이터
  listSchemas: (connId: string) => invoke<string[]>("list_schemas", { connId }),
  listTables: (connId: string, schema: string) => invoke<TableInfo[]>("list_tables", { connId, schema }),
  listColumns: (connId: string, schema: string, table: string) => invoke<ColumnMeta[]>("list_columns", { connId, schema, table }),
  listIndexes: (connId: string, schema: string, table: string) => invoke<IndexInfo[]>("list_indexes", { connId, schema, table }),
  schemaSnapshot: (connId: string) => invoke<SnapshotTable[]>("schema_snapshot", { connId }),

  // 실행
  execute: (req: {
    conn_id: string;
    console_id: string | null;
    exec_id: string;
    sql: string;
    is_query: boolean;
    paged: boolean;
    offset: number;
    page_size: number;
  }) => invoke<ExecResult>("execute", { req }),
  exportCsv: (req: { conn_id: string; console_id: string | null; exec_id: string; sql: string; file_name: string; bom: boolean }) =>
    invoke<{ path: string; rows: number } | null>("export_csv", { req }),
  countRows: (connId: string, consoleId: string | null, sql: string) => invoke<number>("count_rows", { connId, consoleId, sql }),
  cancelQuery: (execId: string) => invoke<boolean>("cancel_query", { execId }),
  setTxMode: (connId: string, consoleId: string, manual: boolean, finish?: "commit" | "rollback") =>
    invoke<void>("set_tx_mode", { connId, consoleId, manual, finish: finish ?? null }),
  txAction: (consoleId: string, action: "commit" | "rollback" | "begin") => invoke<void>("tx_action", { consoleId, action }),

  // 편집
  readBlob: (req: BlobReq, fileName: string) => invoke<FileResult>("read_blob", { req, fileName }),
  writeBlob: (req: BlobReq) => invoke<FileResult>("write_blob", { req }),
  submitChanges: (req: SubmitReq) => invoke<void>("submit_changes", { req }),
  /** 실제로 나갈 SQL (값을 리터럴로 넣은 형태) */
  previewChanges: (req: SubmitReq) => invoke<RawStmt[]>("preview_changes", { req }),
  /** 미리보기에서 고친 SQL을 한 트랜잭션으로 실행 */
  submitSql: (connId: string, consoleId: string | null, statements: RawStmt[]) => invoke<void>("submit_sql", { connId, consoleId, statements }),

  // 구조 편집
  tableStructure: (connId: string, schema: string, table: string) => invoke<TableStructure>("table_structure", { connId, schema, table }),
  /** original이 null이면 새 테이블(table이 새 이름). 그사이 다른 곳에서 구조가 바뀌었으면 오류 */
  previewDdl: (connId: string, schema: string, table: string, original: TableStructure | null, draft: TableStructure, newName: string | null) =>
    invoke<DdlPlan>("preview_ddl", { connId, schema, table, original, draft, newName }),
  /** SQLite는 이 테이블을 참조하는 외래 키의 ON DELETE 동작을 경고로 알린다 */
  previewDrop: (connId: string, schema: string, table: string) => invoke<DdlPlan>("preview_drop", { connId, schema, table }),
  ddlChoices: (connId: string) => invoke<DdlChoices>("ddl_choices", { connId }),
  /** 콘솔 트랜잭션과 무관한 자동 커밋 연결에서 실행 */
  applyDdl: (connId: string, statements: string[]) => invoke<void>("apply_ddl", { connId, statements }),

  // Redis
  redisDbs: (connId: string) => invoke<{ db: number; keys: number }[]>("redis_dbs", { connId }),
  redisScan: (connId: string, db: number, cursor: string, pattern: string, count: number) =>
    invoke<{ cursor: string; keys: ScanKey[] }>("redis_scan", { connId, db, cursor, pattern, count }),
  redisDeleteKey: (connId: string, db: number, key: Arg) => invoke<number>("redis_delete_key", { connId, db, key }),
  redisKeyInfo: (connId: string, db: number, key: Arg) =>
    invoke<{ type: string; ttl: number; memory: number | null; length: number | null }>("redis_key_info", { connId, db, key }),
  redisRead: (connId: string, db: number, key: Arg, kind: string, cursor: string, count: number) =>
    invoke<{ rows: Bytes[][]; cursor: string; truncated: boolean }>("redis_read", { connId, db, key, kind, cursor, count }),
  /** consoleId가 있으면 그 콘솔의 전용 연결 */
  redisExec: (connId: string, consoleId: string | null, db: number, execId: string, argv: Arg[]) =>
    invoke<Reply>("redis_exec", { connId, consoleId, db, execId, argv }),
  redisCloseConsole: (connId: string, consoleId: string) => invoke<void>("redis_close_console", { connId, consoleId }),
  redisSubmit: (connId: string, db: number, key: Arg, expect: { type: string; length: number | null }, commands: Arg[][]) =>
    invoke<number>("redis_submit", { connId, db, key, expect, commands }),

  // MongoDB (필터·정렬 등은 Canonical Extended JSON 텍스트)
  mongoDbs: (connId: string) => invoke<{ name: string; size: number }[]>("mongo_dbs", { connId }),
  mongoCollections: (connId: string, db: string) => invoke<{ name: string; kind: string; estimated: number | null }[]>("mongo_collections", { connId, db }),
  mongoIndexes: (connId: string, db: string, coll: string) =>
    invoke<{ name: string; keys: EJson; unique: boolean; ttl: number | null; partial: boolean }[]>("mongo_indexes", { connId, db, coll }),
  mongoFind: (req: { connId: string; execId: string; db: string; coll: string; filter: string; sort: string; projection: string; skip: number; limit: number }) =>
    invoke<{ docs: EJson[]; has_more: boolean }>("mongo_find", req),
  mongoCount: (connId: string, db: string, coll: string, filter: string) => invoke<number>("mongo_count", { connId, db, coll, filter }),
  mongoExec: (connId: string, execId: string, db: string, op: MongoOp, pageSize: number) => invoke<MongoOut>("mongo_exec", { connId, execId, db, op, pageSize }),
  mongoSubmit: (connId: string, db: string, ops: MongoOp[]) => invoke<number>("mongo_submit", { connId, db, ops }),
  /** 저장 위치는 백엔드 대화상자로 고른다. 취소하면 null */
  mongoExport: (connId: string, execId: string, db: string, op: MongoOp, fileName: string) =>
    invoke<{ path: string; rows: number } | null>("mongo_export", { connId, execId, db, op, fileName }),

  // 파일
  loadConsole: (connId: string, consoleId: string) => invoke<string | null>("load_console", { connId, consoleId }),
  saveConsole: (connId: string, consoleId: string, text: string) => invoke<void>("save_console", { connId, consoleId, text }),
  deleteConsole: (connId: string, consoleId: string) => invoke<void>("delete_console", { connId, consoleId }),
  loadWorkspace: () => invoke<unknown>("load_workspace"),
  saveWorkspace: (workspace: unknown) => invoke<void>("save_workspace", { workspace }),
};
