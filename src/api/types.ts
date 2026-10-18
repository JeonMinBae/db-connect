/** SQL 드라이버 (SQL 파서·에디터·편집 코드가 쓰는 방언) */
export type Driver = "postgres" | "mysql" | "sqlite";
/** 접속 드라이버 */
export type ConnDriver = Driver | "redis" | "mongodb";
export const isSql = (d: ConnDriver): d is Driver => d === "postgres" || d === "mysql" || d === "sqlite";
export type SslMode = "disable" | "prefer" | "require" | "verify-ca" | "verify-full";

export interface ConnectionConfig {
  id: string;
  name: string;
  driver: ConnDriver;
  host: string;
  port: number;
  database: string;
  user: string;
  ssl_mode: SslMode;
  ssl_root_cert: string | null;
  sqlite_path: string;
  read_only: boolean;
  color: string | null;
  /** Redis: 기본 DB 번호 */
  redis_db: number;
  /** Redis: 키 트리 폴더 구분자 */
  key_separator: string;
  /** MongoDB: 연결 문자열 (비밀번호 제외) */
  mongo_uri: string;
}

export type Cell =
  | { t: "Null" }
  | { t: "Text"; v: string }
  | { t: "Blob"; v: number }
  | { t: "Unsupported"; v: string };

export interface ColumnInfo {
  name: string;
  type_name: string;
}

export interface ExecResult {
  columns: ColumnInfo[];
  rows: Cell[][];
  has_more: boolean;
  rows_affected: number | null;
  elapsed_ms: number;
}

export interface TableInfo {
  name: string;
  kind: "TABLE" | "VIEW";
}

export interface ColumnMeta {
  name: string;
  data_type: string;
  full_type: string;
  nullable: boolean;
  is_pk: boolean;
  is_unique_not_null: boolean;
  enum_values: string[] | null;
  ordinal: number;
}

export interface IndexInfo {
  name: string;
  /** 키 순서대로 */
  columns: string[];
  unique: boolean;
  primary: boolean;
}

export interface SnapshotTable {
  schema: string;
  table: string;
  columns: string[];
}

export interface AppError {
  kind: "db" | "io" | "keyring" | "json" | "redis" | "mongo" | "user" | "submit";
  message: string;
  change_index?: number;
  affected?: number;
}

export const NULL: Cell = { t: "Null" };
export const text = (v: string): Cell => ({ t: "Text", v });

/** SQL 접속 설정 (SQL 콘솔·테이블 뷰·편집 코드용) */
export type SqlConfig = ConnectionConfig & { driver: Driver };
