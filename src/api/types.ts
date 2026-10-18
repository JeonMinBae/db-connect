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

/** 구조 탭의 컬럼 정의 (src-tauri db/structure.rs) */
export interface ColumnDef {
  /** 원래 컬럼 이름. 새 컬럼이면 null */
  orig_name: string | null;
  name: string;
  full_type: string;
  nullable: boolean;
  /** 기본값 SQL 식 (문자열은 따옴표 포함) */
  default: string | null;
  auto_increment: boolean;
  /** 생성(계산) 컬럼: 구조 탭에서 바꾸지 않는다 */
  generated: boolean;
  comment: string | null;
  charset: string | null;
  collation: string | null;
  on_update: string | null;
}

export interface IndexDef {
  orig_name: string | null;
  name: string;
  columns: string[];
  unique: boolean;
  /** UNIQUE 제약으로 만든 것 */
  constraint: boolean;
  /** 식·부분 인덱스의 원래 정의: 그대로 두거나 삭제만 한다 */
  raw: string | null;
}

export type FkAction = "NO ACTION" | "RESTRICT" | "CASCADE" | "SET NULL" | "SET DEFAULT";

export interface ForeignKeyDef {
  /** 이름 없는 SQLite 외래 키는 "#순번" */
  orig_name: string | null;
  /** 비어 있으면 DB가 정한다 */
  name: string;
  columns: string[];
  /** null = 같은 스키마 */
  ref_schema: string | null;
  ref_table: string;
  /** SQLite는 비어 있으면 참조 테이블의 기본키 */
  ref_columns: string[];
  on_update: FkAction;
  on_delete: FkAction;
}

export interface CheckDef {
  orig_name: string | null;
  name: string;
  /** 바깥 괄호를 뺀 식 */
  expr: string;
}

export interface TableStructure {
  columns: ColumnDef[];
  primary_key: string[];
  primary_key_name: string | null;
  indexes: IndexDef[];
  foreign_keys: ForeignKeyDef[];
  checks: CheckDef[];
  /** CHECK 제약을 조회할 수 없는 서버 (오래된 MySQL/MariaDB) */
  checks_unsupported: boolean;
  options: TableOptions;
}

/** 테이블 옵션. 코멘트는 PG·MySQL, 나머지는 MySQL만 */
export interface TableOptions {
  comment: string | null;
  engine: string | null;
  charset: string | null;
  collation: string | null;
  row_format: string | null;
  /** 초안에서만: 문자셋을 바꿀 때 기존 데이터도 변환 (CONVERT TO) */
  convert: boolean;
}

export interface DdlChoices {
  charsets: string[];
  /** [정렬규칙, 문자셋] (PG는 문자셋이 빈 문자열) */
  collations: [string, string][];
  engines: string[];
}

export interface DdlPlan {
  statements: { sql: string; destructive: boolean }[];
  /** 데이터가 사라지거나 바뀔 수 있는 변경 (경고 상자) */
  warnings: string[];
  notes: string[];
}
