# data-connector 작업 계획서

[DESIGN.md](DESIGN.md)를 기준으로 한 구현 계획이다. 각 task는 하나씩 끝내고 검증할 수 있는 단위이며, 아래 세 부분으로 구성된다.

- **작업 내용:** 이 task에서 할 일
- **작업 예시:** 핵심 코드 스니펫과 함수 콜스택
- **완료 조건:** 이 task가 끝났다고 판단하는 기준

---

## 0. 공통 결정 사항

### 0.1 디렉터리 구조

```
data-connector/
├─ mise.toml
├─ package.json / vite.config.ts / tsconfig.json
├─ src/                          # React + TS
│  ├─ api/                       # invoke 래퍼와 공용 타입 (types.ts, conn.ts, meta.ts, exec.ts, edit.ts, export.ts)
│  ├─ store/                     # zustand 스토어 (connections, tabs, consoles)
│  ├─ sql/                       # 토크나이저, 문장 분리, 편집 가능성 분석 (+ *.test.ts)
│  ├─ grid/                      # 보류 변경 모델, 셀 변환, 타입별 에디터
│  ├─ components/                # ConnectionTree, TabBar, ConsoleTab, TableViewTab, ResultGrid, dialogs/
│  └─ theme/                     # CSS 변수, Glide/CodeMirror 테마
└─ src-tauri/src/
   ├─ lib.rs                     # Builder, 상태 등록, 커맨드 등록
   ├─ error.rs                   # AppError (Serialize)
   ├─ store/{config.rs,secrets.rs,files.rs}   # 접속 목록, 키체인, 콘솔/워크스페이스 파일
   ├─ db/{pool.rs,value.rs,meta.rs,dialect.rs,cancel.rs,exec.rs,edit.rs,export.rs}
   └─ commands/{conn.rs,meta.rs,exec.rs,edit.rs,export.rs,files.rs}
```

### 0.2 핵심 기술 판단 (모든 task 공통)

| 주제 | 결정 | 이유 |
|---|---|---|
| DB 추상화 | `enum DbPool { Pg(PgPool), My(MySqlPool), Lite(SqlitePool) }`로 드라이버별 분기. `sqlx::Any`는 쓰지 않음 | Any 드라이버는 타입 지원이 빈약함 |
| 콘솔 쿼리 실행 | `sqlx::raw_sql` (simple/text 프로토콜) | PG/MySQL은 결과가 **텍스트 포맷**으로 오므로 enum·uuid·json 등 모든 타입을 `try_get_unchecked::<String>`로 그대로 표시할 수 있다. 타입별 디코더(chrono, uuid 등 feature)가 필요 없어 가볍다 |
| 셀 값 전송 형식 | `Cell = Null \| Text(String) \| Blob{size}`. 숫자도 문자열 | i64·numeric 정밀도 손실 방지, 직렬화 단순화 |
| 페이지 조회 | 최상위에 `LIMIT`이 없는 SELECT/WITH/VALUES 문에 `LIMIT 501 OFFSET n`을 붙임. 501번째 행이 있으면 `has_more` | 서브쿼리로 감싸면 MySQL이 ORDER BY를 무시할 수 있다. `LIMIT x OFFSET y`는 세 DB 모두에서 동작한다 |
| 행 수 조회 | `SELECT COUNT(*) FROM (<sql>) AS _q` | 순서와 무관하므로 감싸도 안전하다 |
| TLS | sqlx `tls-native-tls` (Windows에서는 SChannel) | ring/rustls 크립토를 컴파일하지 않아 바이너리가 작다 |
| 프론트 상태 | zustand (약 1KB) | Redux류보다 가볍다 |
| 에러 | Rust `AppError`(thiserror) → `{ kind, message }`로 직렬화 → TS에서 토스트로 표시 | |

### 0.3 공용 타입 (Rust ↔ TS)

```rust
// db/value.rs
#[derive(Serialize)]
#[serde(tag = "t", content = "v")]
pub enum Cell { Null, Text(String), Blob(u64) }   // Blob = 바이트 크기

#[derive(Serialize)]
pub struct ColumnInfo { pub name: String, pub type_name: String }

#[derive(Serialize)]
pub struct ExecResult {
    pub columns: Vec<ColumnInfo>,
    pub rows: Vec<Vec<Cell>>,
    pub has_more: bool,
    pub rows_affected: Option<u64>,
    pub elapsed_ms: u64,
}
```

```ts
// src/api/types.ts
export type Cell = { t: "Null" } | { t: "Text"; v: string } | { t: "Blob"; v: number };
export interface ColumnInfo { name: string; type_name: string }
export interface ExecResult { columns: ColumnInfo[]; rows: Cell[][]; has_more: boolean; rows_affected: number | null; elapsed_ms: number }
export type Driver = "postgres" | "mysql" | "sqlite";
```

### 0.4 테스트 DB

- SQLite: `fixtures/sample.db` (PK 있는 테이블, PK 없는 테이블, BLOB, 날짜 컬럼 포함)를 생성 스크립트 `fixtures/seed.sql`로 만든다.
- PG / MySQL: 로컬에 이미 있는 서버를 쓰거나, Docker가 있으면 `fixtures/docker-compose.yml`(postgres:16, mysql:8)로 띄운다. 같은 시드를 방언에 맞춰 `seed.pg.sql`, `seed.mysql.sql`로 둔다.
- 각 task의 "완료 조건"에서 **3개 DB**라고 하면 위 세 환경에서 모두 확인한다는 뜻이다.

---

## M0 — 개발 환경

### T01. 툴체인 설치 ✅

**작업 내용**
- `winget install jdx.mise`로 mise를 설치하고, 셸 활성화(`mise activate pwsh`)를 PowerShell 프로필에 추가한다.
- `winget install Microsoft.VisualStudio.2022.BuildTools`를 C++ 워크로드만 지정해 설치한다(MSVC 링커와 Windows SDK).
- 프로젝트 루트에 `mise.toml`을 만들고 node(LTS)와 rust(stable)를 고정한 뒤 `mise install`을 실행한다.

**작업 예시**

```toml
# mise.toml
[tools]
node = "lts"
rust = "stable"
```

```bash
winget install --id Microsoft.VisualStudio.2022.BuildTools --override "--quiet --wait --add Microsoft.VisualStudio.Workload.VCTools --includeRecommended"
```

**완료 조건**
- 프로젝트 폴더에서 `node -v`, `npm -v`, `cargo -V`, `rustc -V`가 모두 출력된다.
- `rustup show`의 기본 툴체인이 `x86_64-pc-windows-msvc`이다.
- 빈 `cargo new` 프로젝트가 `cargo build`로 링크까지 성공한다.

---

### T02. 프로젝트 스캐폴딩 ✅

> 기준선(빈 앱, 2026-10-18): exe 3.17MB, NSIS 설치 파일 1.17MiB. Glide가 React 18까지만 지원해 React 18을 쓰고, peer 의존성 충돌 때문에 `.npmrc`에 `legacy-peer-deps=true`를 설정했다.

**작업 내용**
- `npm create tauri-app@latest`로 React + TypeScript + Vite 템플릿을 만든다(Tauri 2).
- 프론트 의존성: `@glideapps/glide-data-grid`(와 peer 의존성), `codemirror`, `@codemirror/lang-sql`, `zustand`, `@tauri-apps/plugin-dialog`. 개발 의존성: `vitest`.
- Rust 의존성: `sqlx`, `tokio`, `serde`, `serde_json`, `thiserror`, `keyring`, `uuid`, `futures-util`, `tauri-plugin-dialog`.
- 0.1의 디렉터리 골격과 `AppError`를 만든다.
- `tauri.conf.json`에서 창 제목과 기본 크기(1280×800)를 설정한다.
- `fixtures/`에 시드 SQL과 생성 스크립트를 둔다.

**작업 예시**

```toml
# src-tauri/Cargo.toml (발췌)
[dependencies]
tauri = { version = "2", features = [] }
tauri-plugin-dialog = "2"
sqlx = { version = "0.8", default-features = false, features = ["runtime-tokio", "tls-native-tls", "postgres", "mysql", "sqlite", "macros"] }
tokio = { version = "1", features = ["rt-multi-thread", "macros", "sync", "fs", "io-util"] }
keyring = { version = "3", features = ["windows-native"] }
serde = { version = "1", features = ["derive"] }
serde_json = "1"
thiserror = "2"
uuid = { version = "1", features = ["v4"] }
futures-util = "0.3"

[profile.release]
opt-level = "s"
lto = true
codegen-units = 1
strip = true
panic = "abort"
```

```rust
// error.rs
#[derive(Debug, thiserror::Error)]
pub enum AppError {
    #[error("{0}")] Db(#[from] sqlx::Error),
    #[error("{0}")] Io(#[from] std::io::Error),
    #[error("{0}")] Keyring(#[from] keyring::Error),
    #[error("{0}")] User(String),           // 연결 없음, 편집 불가 등
}
impl serde::Serialize for AppError {
    fn serialize<S: serde::Serializer>(&self, s: S) -> Result<S::Ok, S::Error> {
        use serde::ser::SerializeStruct;
        let mut st = s.serialize_struct("AppError", 2)?;
        st.serialize_field("kind", match self { Self::Db(_) => "db", Self::Io(_) => "io", Self::Keyring(_) => "keyring", Self::User(_) => "user" })?;
        st.serialize_field("message", &self.to_string())?;
        st.end()
    }
}
```

**완료 조건**
- `npm run tauri dev`로 빈 창이 뜬다.
- `npm run tauri build`가 성공하고, 릴리스 exe 크기를 기록해 둔다(이후 T24에서 기준선으로 쓴다).
- `npx vitest run`과 `cargo test`가 둘 다 (빈 상태로) 통과한다.

---

## M1 — 읽기

### T03. 접속 설정 저장소와 키체인 ✅

**작업 내용**
- `ConnectionConfig`(id, name, driver, host, port, database, user, ssl_mode, ssl_root_cert, sqlite_path, read_only, color)를 정의한다.
- 접속 목록은 `app_data_dir/connections.json`에 저장한다. 비밀번호 필드는 두지 않는다.
- 비밀번호는 `keyring::Entry::new("data-connector", &id)`로 저장, 조회, 삭제한다.
- 커맨드: `list_connections`, `save_connection(config, password: Option<String>)`, `delete_connection(id)`.
  - `password`가 `None`이면 기존 비밀번호를 유지하고, 빈 문자열이면 삭제한다.
  - 접속을 삭제하면 키체인 항목도 지운다.

**작업 예시**

```rust
// store/secrets.rs
const SERVICE: &str = "data-connector";
pub fn set_password(id: &str, pw: &str) -> Result<(), AppError> {
    keyring::Entry::new(SERVICE, id)?.set_password(pw)?; Ok(())
}
pub fn get_password(id: &str) -> Result<Option<String>, AppError> {
    match keyring::Entry::new(SERVICE, id)?.get_password() {
        Ok(p) => Ok(Some(p)),
        Err(keyring::Error::NoEntry) => Ok(None),
        Err(e) => Err(e.into()),
    }
}
```

콜스택:
```
ConnectionDialog.onSave
 → api.saveConnection(cfg, pw)               src/api/conn.ts
 → invoke("save_connection")
 → commands::conn::save_connection            src-tauri/src/commands/conn.rs
   → store::config::upsert(app_data_dir, cfg) → connections.json 원자적 쓰기(tmp 파일 → rename)
   → store::secrets::set_password(id, pw)
```

**완료 조건**
- 접속을 저장하고 앱을 재시작해도 목록이 유지된다.
- `connections.json`에 비밀번호 문자열이 없다.
- Windows 자격 증명 관리자에 `data-connector` 항목이 생기고, 접속을 삭제하면 사라진다.
- `config::upsert`/`remove`에 대한 단위 테스트(임시 디렉터리 사용)가 통과한다.

---

### T04. DB 풀 관리와 연결 테스트 ✅ (SQLite 검증 완료 · PG/MySQL 검증은 Docker 준비 후)

**작업 내용**
- `db::pool::DbPool` enum과 `AppState { pools: RwLock<HashMap<ConnId, Arc<DbPool>>> }`를 만든다.
- `ConnectionConfig`과 비밀번호로 드라이버별 ConnectOptions를 만든다.
  - SSL 모드: PG는 `PgSslMode`, MySQL은 `MySqlSslMode`로 매핑하고, root cert 경로를 지원한다.
  - 풀 크기: `max_connections(2)`, `acquire_timeout(10s)`.
- 커맨드: `test_connection(config, password)`(일회성 연결 후 `SELECT 1`), `connect(id)`, `disconnect(id)`.
- 읽기 전용 옵션은 여기서 연결 옵션에 반영할 자리만 만들어 두고, 실제 동작은 T23에서 구현한다.
- Manual 트랜잭션 콘솔용 단일 연결 생성 함수 `DbPool::connect_dedicated()`의 시그니처를 정의한다(구현은 T18).

**작업 예시**

```rust
// db/pool.rs
pub enum DbPool { Pg(PgPool), My(MySqlPool), Lite(SqlitePool) }

pub async fn open(cfg: &ConnectionConfig, pw: Option<String>) -> Result<DbPool, AppError> {
    let opts = || sqlx::pool::PoolOptions::new().max_connections(2).acquire_timeout(Duration::from_secs(10));
    Ok(match cfg.driver {
        Driver::Postgres => {
            let mut o = PgConnectOptions::new().host(&cfg.host).port(cfg.port).database(&cfg.database)
                .username(&cfg.user).ssl_mode(cfg.ssl_mode.into()).application_name("data-connector");
            if let Some(p) = &pw { o = o.password(p); }
            if let Some(ca) = &cfg.ssl_root_cert { o = o.ssl_root_cert(ca); }
            DbPool::Pg(opts().connect_with(o).await?)
        }
        Driver::Mysql => { /* MySqlConnectOptions 동일 패턴 */ todo!() }
        Driver::Sqlite => {
            let o = SqliteConnectOptions::new().filename(&cfg.sqlite_path).create_if_missing(false);
            DbPool::Lite(opts().connect_with(o).await?)
        }
    })
}
```

콜스택:
```
ConnectionTree.onDoubleClick(conn)
 → store.connections.connect(id)
 → invoke("connect", { id })
 → commands::conn::connect
   → store::config::get(id) + store::secrets::get_password(id)
   → db::pool::open(cfg, pw)
   → state.pools.write().insert(id, Arc::new(pool))
```

**완료 조건**
- 3개 DB 모두 `test_connection`이 성공한다. 틀린 비밀번호나 호스트는 `AppError{kind:"db"}` 메시지로 돌아온다.
- PG에 `ssl_mode=require`로 SSL이 필요한 서버(또는 `ssl=on`인 로컬 PG)에 접속된다.
- `disconnect` 후 해당 id로 쿼리하면 "연결되지 않음" 에러가 난다.
- 존재하지 않는 SQLite 파일 경로는 생성하지 않고 에러를 낸다.

---

### T05. 접속 관리 UI ✅ (SQLite 검증 완료 · PG/MySQL 검증은 Docker 준비 후)

**작업 내용**
- 왼쪽 패널 상단에 `+` 버튼과 접속 목록(이름, 드라이버 아이콘, 접속 색상 막대)을 둔다.
- 접속 추가/편집 다이얼로그를 만든다.
  - 드라이버를 고르면 필드가 바뀐다(SQLite는 파일 선택 버튼 → `plugin-dialog`의 `open`).
  - 입력 항목: SSL 모드, 루트 인증서 경로, 읽기 전용 체크박스, 색상.
  - "연결 테스트" 버튼.
- 우클릭 메뉴: 연결, 연결 해제, 편집, 복제, 삭제(확인 대화상자 포함).
- zustand `useConnections` 스토어: `configs`, `status: Record<id, "idle"|"connecting"|"connected"|"error">`.

**작업 예시**

```ts
// src/store/connections.ts
export const useConnections = create<ConnState>((set, get) => ({
  configs: [], status: {},
  load: async () => set({ configs: await api.listConnections() }),
  connect: async (id) => {
    set(s => ({ status: { ...s.status, [id]: "connecting" } }));
    try { await api.connect(id); set(s => ({ status: { ...s.status, [id]: "connected" } })); }
    catch (e) { set(s => ({ status: { ...s.status, [id]: "error" } })); toast(e); }
  },
}));
```

**완료 조건**
- UI만으로 3개 DB 접속을 추가, 편집, 삭제, 연결, 해제할 수 있다.
- 편집할 때 비밀번호 칸을 비워 두면 기존 비밀번호가 유지된다.
- 연결 상태가 목록 아이콘에 반영된다(연결 중 스피너, 오류는 빨간 표시).

---

### T06. 메타데이터 조회 커맨드 ✅ (SQLite 검증 완료 · PG/MySQL 검증은 Docker 준비 후)

**작업 내용**
- 커맨드: `list_schemas(id)`, `list_tables(id, schema)`(테이블/뷰 구분), `list_columns(id, schema, table)`, `schema_snapshot(id, schema)`(자동완성용으로 테이블→컬럼 이름 일괄 조회).
- `ColumnMeta { name, data_type, full_type, nullable, is_pk, is_unique_not_null, enum_values: Option<Vec<String>>, ordinal }`
  - `full_type`: PG는 `format_type(atttypid, atttypmod)`, MySQL은 `COLUMN_TYPE`. T17의 캐스팅에서 쓴다.
  - `enum_values`: PG는 `pg_enum`, MySQL은 `COLUMN_TYPE`의 `enum('a','b')`를 파싱한다. T22에서 쓴다.
- 드라이버별 쿼리:
  - PG: `information_schema.schemata`/`tables`, 컬럼은 `pg_attribute` + `pg_index`.
  - MySQL: DB를 스키마로 취급한다(`information_schema`).
  - SQLite: 스키마는 `main` 하나, `sqlite_master`, `pragma_table_info(?)`, `pragma_index_list`.
- 메타 조회는 바인딩이 필요하므로 일반 `sqlx::query`를 쓴다(raw_sql 아님).

**작업 예시**

```rust
// db/meta.rs (PG 컬럼)
const PG_COLUMNS: &str = r#"
SELECT a.attname AS name, t.typname AS data_type, format_type(a.atttypid, a.atttypmod) AS full_type,
       NOT a.attnotnull AS nullable,
       COALESCE(i.indisprimary, false) AS is_pk,
       (SELECT array_agg(e.enumlabel ORDER BY e.enumsortorder) FROM pg_enum e WHERE e.enumtypid = a.atttypid) AS enum_values
FROM pg_attribute a
JOIN pg_class c ON c.oid = a.attrelid JOIN pg_namespace n ON n.oid = c.relnamespace
JOIN pg_type t ON t.oid = a.atttypid
LEFT JOIN pg_index i ON i.indrelid = c.oid AND i.indisprimary AND a.attnum = ANY(i.indkey)
WHERE n.nspname = $1 AND c.relname = $2 AND a.attnum > 0 AND NOT a.attisdropped
ORDER BY a.attnum"#;
```

콜스택:
```
TreeNode(table).onExpand
 → api.listColumns(connId, schema, table)
 → invoke("list_columns")
 → commands::meta::list_columns → pool_of(state, id)? → db::meta::columns(&DbPool, schema, table)
   → match pool { Pg => PG_COLUMNS, My => MY_COLUMNS, Lite => pragma_table_info + pragma_index_list }
```

**완료 조건**
- 3개 DB의 시드 테이블에서 PK, nullable, enum 값(PG/MySQL), 타입 문자열이 정확히 나온다.
- 복합 PK 테이블에서 PK 컬럼이 모두 `is_pk = true`이다.
- 존재하지 않는 테이블은 빈 배열이 반환된다(에러 아님).
- SQLite에 대해 `cargo test` 통합 테스트(인메모리 DB 사용)가 통과한다.

---

### T07. 스키마 트리 UI ✅

**작업 내용**
- 트리 계층: 접속 → 스키마 → (테이블 | 뷰 폴더) → 테이블 → 컬럼. 펼칠 때 해당 수준만 불러온다(lazy).
- 컬럼 노드에 타입을 표시하고 PK에는 키 아이콘을 붙인다.
- 테이블 더블클릭은 테이블 뷰 탭 열기(T14), 접속 더블클릭은 연결 후 콘솔 열기(T08)로 이어진다.
- 우클릭 메뉴에 "새로고침"(캐시 무효화)을 둔다.
- 가상화 없이 일반 DOM으로 그리되, 테이블 폴더에 항목이 2000개를 넘으면 상단에 이름 필터 입력란을 보여 준다.

**작업 예시**

```ts
// src/store/tree.ts — 노드 키별 캐시
type NodeKey = `${string}` /* `${connId}|${schema}|${table}` */;
children: Record<NodeKey, TreeNode[] | "loading">,
expand: async (key) => { if (!get().children[key]) { set(...loading); set(...await fetchChildren(key)); } }
```

**완료 조건**
- 3개 DB에서 트리를 끝까지 펼칠 수 있다.
- 같은 노드를 다시 펼칠 때는 재조회하지 않는다(네트워크 요청 없음). "새로고침"하면 다시 조회한다.
- 테이블 1000개 이상인 스키마에서도 펼치는 데 1초 안쪽으로 끝난다.

---

### T08. 탭 레이아웃과 테마 ✅

**작업 내용**
- 레이아웃: 좌측 트리(폭 드래그 조절) | 우측 탭 바 + 탭 본문. 콘솔 탭은 위쪽 에디터와 아래쪽 결과 영역을 수직 분할(드래그 조절)한다.
- 탭 종류: `console(connId, consoleId)`, `table(connId, schema, table)`. 탭에 접속 색상 띠를 표시한다.
- 단축키: `Ctrl+W` 탭 닫기, `Ctrl+Tab` 다음 탭.
- 테마: `theme/vars.css`에 CSS 변수를 정의하고 `prefers-color-scheme`로 전환한다. Glide `Theme` 객체와 CodeMirror 테마 확장을 light/dark 각각 만들고, `matchMedia` 변경을 구독해 교체한다.
- 분할기는 자체 구현한다(라이브러리 없음, `pointermove` 사용).

**작업 예시**

```ts
// src/theme/useColorScheme.ts
export function useColorScheme() {
  const mq = window.matchMedia("(prefers-color-scheme: dark)");
  return useSyncExternalStore(cb => { mq.addEventListener("change", cb); return () => mq.removeEventListener("change", cb); },
                              () => (mq.matches ? "dark" : "light"));
}
```

**완료 조건**
- 콘솔 탭과 테이블 탭을 여러 개 열고, 전환하고, 닫을 수 있다.
- 탭을 전환해도 에디터 내용과 커서, 결과가 유지된다(언마운트하지 않고 숨김 처리).
- Windows 앱 모드를 다크/라이트로 바꾸면 재시작 없이 그리드, 에디터, 크롬이 모두 바뀐다.

---

### T09. SQL 에디터 (CodeMirror) ✅

**작업 내용**
- `EditorView` 래퍼 컴포넌트를 만든다. 확장: `basicSetup` 일부(줄 번호, 괄호 매칭, 히스토리, 검색), `sql({ dialect, schema, defaultSchema })`, 테마.
- 방언 매핑: postgres → `PostgreSQL`, mysql → `MySQL`, sqlite → `SQLite`.
- 접속이 연결되면 `schema_snapshot`으로 `{ "schema.table": [cols], table: [cols] }`를 만들어 `Compartment`로 교체 주입한다. 트리 "새로고침" 시에도 다시 주입한다.
- 키맵: `Ctrl+Enter` 실행(T11), `Ctrl+Shift+Enter`는 T19 이후 예약.
- 콘솔 자동 저장(T09에 포함):
  - 변경 후 1초 디바운스로 `save_console(connId, consoleId, text)` 호출.
  - 파일 위치: `app_data_dir/consoles/<connId>/<consoleId>.sql`.
  - 열린 탭 목록은 `workspace.json`에 저장하고, 시작할 때 복원한다.

**작업 예시**

```ts
// src/components/SqlEditor.tsx (발췌)
const schemaComp = new Compartment();
const view = new EditorView({
  parent: host,
  doc: initialText,
  extensions: [
    lineNumbers(), history(), bracketMatching(), highlightSelectionMatches(),
    keymap.of([{ key: "Mod-Enter", run: () => { onRun(view.state); return true; } }, ...defaultKeymap, ...historyKeymap]),
    schemaComp.of(sql({ dialect: DIALECTS[driver] })),
    themeComp.of(scheme === "dark" ? darkTheme : lightTheme),
    EditorView.updateListener.of(u => u.docChanged && saveDebounced(u.state.doc.toString())),
  ],
});
// 스키마가 도착하면
view.dispatch({ effects: schemaComp.reconfigure(sql({ dialect: DIALECTS[driver], schema, defaultSchema })) });
```

콜스택 (자동 저장):
```
EditorView.updateListener (docChanged)
 → saveDebounced(text)   1000ms
 → api.saveConsole(connId, consoleId, text)
 → invoke("save_console") → commands::files::save_console → store::files::write_atomic(path, text)
```

**완료 조건**
- 3개 방언에서 키워드가 하이라이트된다.
- `SELECT * FROM us`까지 입력하면 `users`가 제안되고, `users.`를 입력하면 컬럼이 제안된다.
- 입력하고 1초 뒤 앱을 강제 종료한 다음 재시작하면 콘솔 내용과 열린 탭이 복원된다.
- 에디터 관련 번들 증가분이 gzip 기준 300KB 이하이다(`vite build` 결과로 확인).

---

### T10. SQL 토크나이저와 문장 분리기 ✅

**작업 내용**
- `src/sql/tokenize.ts`: 문자열(`'..'`, `''` 이스케이프), 따옴표 식별자(`".."`, MySQL `` `..` ``), 주석(`--`, `/* */`, MySQL `#`), PG 달러 인용(`$tag$...$tag$`), 괄호 깊이를 처리하는 경량 토크나이저.
- `src/sql/split.ts`의 `splitStatements(src, driver): Stmt[]`
  - `Stmt = { text, from, to, firstKeyword, hasTopLevelLimit, hasTopLevelWhere, kind: "query" | "dml" | "other" }`
  - `kind` 판정: 첫 키워드가 SELECT/VALUES/TABLE이면 query. WITH는 괄호 밖에서 처음 나오는 SELECT/INSERT/UPDATE/DELETE로 판정한다.
- `statementAt(stmts, cursorPos)`: 커서가 있는 문장을 찾는다. 커서가 문장 사이 공백에 있으면 바로 앞 문장을 쓴다.
- 실행 대상 결정: 선택 영역이 있으면 그 영역을 다시 분리하고, 없으면 커서 문장 하나를 쓴다.

**작업 예시**

```ts
export function splitStatements(src: string, driver: Driver): Stmt[] {
  const out: Stmt[] = []; let start = 0; let depth = 0;
  for (const tok of tokenize(src, driver)) {
    if (tok.type === "punct" && tok.text === "(") depth++;
    else if (tok.type === "punct" && tok.text === ")") depth--;
    else if (tok.type === "punct" && tok.text === ";" && depth === 0) { push(out, src, start, tok.from); start = tok.to; }
  }
  push(out, src, start, src.length);
  return out.filter(s => s.text.trim().length > 0);
}
```

**완료 조건**
- vitest 단위 테스트가 통과한다. 최소한 다음 경우를 포함한다.
  - 문자열이나 주석 안의 `;`
  - PG `$$ ... ; ... $$` 함수 본문
  - MySQL 백틱과 `#` 주석
  - `WITH x AS (...) UPDATE ...` → `kind = "dml"`
  - `SELECT ... LIMIT 10` → `hasTopLevelLimit = true`, 서브쿼리 안의 `LIMIT`은 false
  - 커서가 공백이나 줄 끝에 있을 때의 `statementAt`
- 10만 자 스크립트를 50ms 안에 분리한다.

---

### T11. 쿼리 실행 커맨드 ✅ (SQLite 검증 완료 · PG/MySQL 검증은 Docker 준비 후)

**작업 내용**
- 커맨드 `execute(req: ExecRequest) -> ExecResult`
  - `ExecRequest { conn_id, console_id, exec_id, sql, kind, page: Option<{ offset: u64 }> }`
  - 실행 SQL 결정
    - `kind == "query"`이고 `LIMIT`이 없으면: `{sql} LIMIT 501 OFFSET {offset}` (끝의 `;`는 제거).
    - 그 밖의 경우: 원문 그대로 실행하되 행은 최대 500개까지만 담는다(스트림 조기 종료).
  - `sqlx::raw_sql(&sql).fetch_many(&mut *conn)`을 소비한다. `Either::Left`는 `rows_affected`에 누적하고, `Either::Right`는 행으로 변환한다.
  - 결과 행이 0개인 query는 `conn.describe(sql)`로 컬럼 이름을 채운다.
- `db::value` 셀 변환
  - PG/MySQL: `try_get_raw(i)`로 NULL 여부와 타입 이름을 확인한 뒤 `try_get_unchecked::<String, _>(i)`로 가져온다. 바이너리 계열(bytea, BLOB 등)은 `Blob(size)`로 만들고 실제 값은 보내지 않는다.
  - SQLite: 값별 저장 클래스(INTEGER/REAL/TEXT/BLOB/NULL)에 따라 변환한다.
  - 디코드에 실패하면 `Text("<타입명>")`으로 표시하고 그 셀은 편집할 수 없게 표시한다.
- 커맨드 `count_rows(conn_id, sql)`: `SELECT COUNT(*) FROM ({sql}) AS _q`
- 실행 전에 취소 레지스트리 등록 자리를 만든다(실제 구현은 T12).

**작업 예시**

```rust
// db/value.rs (PG)
pub fn pg_cell(row: &PgRow, i: usize) -> Cell {
    let raw = match row.try_get_raw(i) { Ok(r) => r, Err(_) => return Cell::Null };
    if raw.is_null() { return Cell::Null; }
    let ty = raw.type_info().name().to_owned();
    match row.try_get_unchecked::<String, _>(i) {
        Ok(s) if ty == "BYTEA" => Cell::Blob(s.len().saturating_sub(2) as u64 / 2), // 텍스트 포맷 "\x..." 
        Ok(s) => Cell::Text(s),
        Err(_) => Cell::Text(format!("<{ty}>")),
    }
}
```

```rust
// db/exec.rs (발췌)
let mut stream = sqlx::raw_sql(&sql).fetch_many(&mut *conn);
while let Some(item) = stream.try_next().await? {
    match item {
        Either::Left(r) => affected += r.rows_affected(),
        Either::Right(row) => {
            if columns.is_empty() { columns = column_infos(&row); }
            if rows.len() == LIMIT { has_more = true; break; }
            rows.push((0..row.len()).map(|i| pg_cell(&row, i)).collect());
        }
    }
}
```

콜스택:
```
SqlEditor Mod-Enter
 → ConsoleTab.run(state)
   → sql.splitStatements(doc) → statementAt(cursor) | selection 재분리
   → for stmt: useConsoles.execute(tabId, stmt)       (순차 실행, 문장마다 결과 탭)
     → api.execute({ conn_id, console_id, exec_id: crypto.randomUUID(), sql: stmt.text, kind: stmt.kind })
     → invoke("execute")
     → commands::exec::execute
       → conn_for(state, conn_id, console_id)   (Manual 트랜잭션이면 전용 연결, 아니면 pool.acquire)
       → cancel::register(exec_id, handle)        (T12)
       → db::exec::run(conn, sql, kind, page)
         → sqlx::raw_sql(..).fetch_many → value::{pg,my,lite}_cell
       → cancel::unregister(exec_id)
```

**완료 조건**
- 3개 DB에서 int, numeric, bool, 날짜, 시간대 포함 타임스탬프, uuid(PG), json, enum, text, NULL이 DB 클라이언트(psql/mysql CLI)와 같은 문자열로 표시된다.
- 100만 행 테이블에 `SELECT *`를 실행하면 500행과 `has_more=true`가 1초 안에 돌아온다.
- `UPDATE ...`는 `rows_affected`가 정확하다.
- `count_rows`가 정확하다.
- 결과가 0행인 SELECT도 컬럼 헤더가 나온다.
- SQL 오류는 DB 메시지 그대로 표시된다.

---

### T12. 쿼리 취소 ✅ (SQLite 검증 완료 · PG/MySQL 검증은 Docker 준비 후)

**작업 내용**
- `db::cancel::Registry: Mutex<HashMap<ExecId, CancelHandle>>`
  - `CancelHandle::Pg { pid: i32, pool }`, `My { thread_id: u64, pool }`, `Lite { db: usize /* sqlite3* */ }`
- 실행 직전에 핸들을 얻는다.
  - PG: 같은 연결에서 `SELECT pg_backend_pid()`
  - MySQL: `SELECT CONNECTION_ID()`
  - SQLite: `conn.lock_handle().await?.as_raw_handle()`로 포인터를 얻는다(실행 전에 미리 얻어 둔다).
- 커맨드 `cancel_query(exec_id)`
  - PG: 풀의 **다른** 연결로 `SELECT pg_cancel_backend($1)`
  - MySQL: `KILL QUERY <id>`
  - SQLite: `libsqlite3_sys::sqlite3_interrupt(ptr)` (sqlx와 같은 버전의 `libsqlite3-sys`를 의존성에 추가)
  - Manual 트랜잭션 콘솔이 전용 연결로 실행 중이어도 취소는 풀 연결로 보낸다.
- UI: 실행 중에는 결과 영역에 경과 시간(100ms마다 갱신)과 "중지" 버튼을 표시한다. 취소된 쿼리는 "취소됨"으로 표시한다.

**작업 예시**

```rust
pub async fn cancel(h: &CancelHandle) -> Result<(), AppError> {
    match h {
        CancelHandle::Pg { pid, pool } => { sqlx::query("SELECT pg_cancel_backend($1)").bind(pid).execute(pool).await?; }
        CancelHandle::My { thread_id, pool } => { sqlx::raw_sql(&format!("KILL QUERY {thread_id}")).execute(pool).await?; }
        CancelHandle::Lite { db } => unsafe { libsqlite3_sys::sqlite3_interrupt(*db as *mut _) },
    }
    Ok(())
}
```

**완료 조건**
- PG `SELECT pg_sleep(60)`, MySQL `SELECT SLEEP(60)`, SQLite 재귀 CTE 무한 계산을 중지하면 1초 안에 멈춘다.
- 중지한 뒤 같은 콘솔에서 다음 쿼리를 바로 실행할 수 있다(연결 오염 없음).
- PG `pg_stat_activity`에서 해당 쿼리가 사라진 것을 확인한다.

---

### T13. 결과 그리드 (읽기 전용) ✅

**작업 내용**
- `ResultGrid` 컴포넌트를 Glide `DataEditor`로 만든다. 행 번호 마커, 컬럼 리사이즈, 범위 선택, `Ctrl+C`(TSV, `getCellsForSelection` 사용)를 지원한다.
- 셀 표시
  - NULL은 회색 `<null>`
  - Blob은 `<blob 1.2 KB>`
  - 줄바꿈이 있는 텍스트는 한 줄로 표시하고 툴팁을 붙인다.
  - 숫자 타입 컬럼은 우측 정렬한다.
- 결과 영역 탭
  - 문장마다 "결과 N" 탭을 만든다.
  - DML은 "N rows affected (12 ms)" 메시지 패널로 보여 준다.
  - 오류는 빨간 메시지 패널로 보여 준다.
- 하단 바: `1–500 / ?` 표시, 이전/다음 페이지 버튼(`offset` 재실행), "행 수 조회" 버튼(`count_rows` → `?`를 숫자로 대체), 경과 시간.
- 컬럼 폭 자동 계산: 첫 페이지 값 길이의 최대값을 쓰되 상한은 400px로 한다.

**작업 예시**

```tsx
<DataEditor
  theme={glideTheme}
  columns={columns.map(c => ({ title: c.name, id: c.name, width: widths[c.name] }))}
  rows={result.rows.length}
  getCellContent={([col, row]) => toGridCell(result.rows[row][col], colMeta[col])}
  getCellsForSelection={true}
  rowMarkers="number"
  smoothScrollX smoothScrollY
  width="100%" height="100%"
/>
```

```ts
// src/grid/cells.ts
export function toGridCell(c: Cell, meta: ColMeta): GridCell {
  if (c.t === "Null") return { kind: GridCellKind.Text, data: "", displayData: "<null>", allowOverlay: false, themeOverride: { textDark: "var(--muted)" } };
  if (c.t === "Blob") return { kind: GridCellKind.Text, data: "", displayData: `<blob ${fmtBytes(c.v)}>`, allowOverlay: false };
  return { kind: GridCellKind.Text, data: c.v, displayData: oneLine(c.v), allowOverlay: true, readonly: true, contentAlign: meta.numeric ? "right" : "left" };
}
```

**완료 조건**
- 500행 × 50컬럼 결과에서 스크롤이 끊기지 않는다(60fps 근접, DevTools Performance로 확인).
- 범위를 선택해 `Ctrl+C`로 복사한 내용을 엑셀에 붙여 넣으면 셀 구조가 그대로 유지된다.
- 페이지 이동과 행 수 조회가 정확하다(마지막 페이지에서는 "다음" 버튼 비활성).
- 문장 3개를 선택해 실행하면 결과 탭 3개가 생긴다.

---

### T14. 테이블 뷰 탭 ✅ (SQLite 검증 완료 · PG/MySQL 검증은 Docker 준비 후)

**작업 내용**
- 트리에서 테이블을 더블클릭하면 `table` 탭을 연다. 이미 열려 있으면 그 탭으로 전환한다.
- 내부적으로 `SELECT * FROM <quoted schema.table>`을 만들어 T11/T13을 재사용한다. 식별자 따옴표 처리는 `src/sql/quote.ts`가 드라이버별로 맡는다.
- 상단 툴바: 새로고침, (T20에서 추가할) WHERE/ORDER BY 입력란 자리, (T16에서 추가할) 편집 버튼 자리.
- 탭을 열 때 해당 테이블의 `list_columns` 결과(ColumnMeta)를 함께 불러와 탭 상태에 보관한다(T15 이후에 사용).

**작업 예시**

```ts
// src/sql/quote.ts
export const quoteIdent = (d: Driver, s: string) =>
  d === "mysql" ? "`" + s.replaceAll("`", "``") + "`" : '"' + s.replaceAll('"', '""') + '"';
export const qualified = (d: Driver, schema: string | null, table: string) =>
  (schema && d !== "sqlite" ? quoteIdent(d, schema) + "." : "") + quoteIdent(d, table);
```

**완료 조건**
- 대소문자, 공백, 따옴표가 섞인 테이블 이름(시드에 포함)도 3개 DB에서 열린다.
- 같은 테이블을 두 번 더블클릭해도 탭이 하나만 열린다.

> **M1 마일스톤 완료 조건:** 3개 DB에 접속해 트리를 탐색하고, 콘솔에서 쿼리를 실행하고, 결과를 페이지 단위로 보고, 복사하고, 중지할 수 있다. 재시작하면 콘솔이 복원된다.

---

## M2 — 편집

### T15. 편집 가능성 판별과 행 식별 키 결정 ✅

**작업 내용**
- `src/sql/editable.ts`의 `analyzeEditable(stmt, driver): { table: { schema, name } } | { reason: string }`
  - 허용 형태: `SELECT <cols> FROM <단일 테이블> [별칭] [WHERE ..] [ORDER BY ..] [LIMIT ..]`
  - 거부: JOIN, `FROM` 뒤 콤마, 서브쿼리 FROM, GROUP BY, HAVING, DISTINCT, UNION/INTERSECT/EXCEPT, WITH, 집계 함수
- 테이블 뷰 탭은 항상 편집 후보이다.
- `resolveRowKey(resultCols, tableMeta)`
  1. 결과 컬럼에 PK 전체가 있으면 PK를 키로 쓴다.
  2. 그렇지 않고 UNIQUE NOT NULL 컬럼이 있으면 그 컬럼을 쓴다.
  3. 둘 다 없으면 **결과에 있는 모든 컬럼**(Blob, 디코드 실패 컬럼 제외)을 매칭 키로 쓰고 `mode: "allColumns"`로 표시한다.
- 결과 컬럼 이름 중 테이블에 없는 것(계산식, 별칭)이 있으면 그 컬럼만 읽기 전용으로 둔다. 키 컬럼이 결과에 하나도 없으면 편집 불가로 판정한다.
- 판정 결과는 그리드 툴바 아이콘으로 보여 준다(편집 가능/불가와 사유 툴팁).

**작업 예시**

```ts
export type RowKey = { mode: "pk" | "unique" | "allColumns"; cols: number[] /* 결과 컬럼 인덱스 */ };
export function resolveRowKey(res: ColumnInfo[], meta: ColumnMeta[]): RowKey | null {
  const idx = (n: string) => res.findIndex(c => c.name === n);
  const pk = meta.filter(m => m.is_pk).map(m => idx(m.name));
  if (pk.length && pk.every(i => i >= 0)) return { mode: "pk", cols: pk };
  // ... unique, allColumns
}
```

**완료 조건**
- vitest 단위 테스트: 위 허용/거부 패턴 각각, 별칭(`FROM users u`), 따옴표 식별자, 대소문자 차이.
- 시드의 PK 테이블은 `mode=pk`, PK 없는 테이블은 `allColumns`로 판정된다. 판정 결과가 툴바에 보인다.

---

### T16. 보류 변경 모델과 그리드 편집 UI ✅

**작업 내용**
- `src/grid/pending.ts`의 `PendingChanges`
  - `edits: Map<rowIdx, Map<colIdx, Cell>>`
  - `inserted: Cell[][]`
  - `deleted: Set<rowIdx>`
  - `original` 행은 결과에서 참조한다.
  - 원래 값으로 되돌린 셀은 edits에서 제거한다.
- 그리드 동작
  - 편집 가능한 셀은 `readonly: false`이다.
  - `onCellEdited` → `pending.edit`
  - 변경 셀은 `themeOverride.bgCell`을 파란 계열로, 추가 행은 초록, 삭제 행은 빨강 + 취소선으로 표시한다.
- 단축키
  - `Alt+Insert`(또는 툴바 `+`): 행 추가
  - `Ctrl+Delete` 또는 `Delete`(행 선택 시): 삭제 표시
  - `Ctrl+Shift+N`: 선택 셀을 NULL로 지정
  - `Ctrl+Alt+Z`: 선택 셀/행 Revert
  - 툴바 "Revert All"
- 붙여넣기: Glide `onPaste`로 TSV를 여러 셀에 적용한다(편집 가능한 셀만).
- 보류 중인 변경이 있는 탭은 제목에 `*`를 붙인다. 닫을 때와 페이지를 이동할 때는 확인 대화상자를 띄운다.

**작업 예시**

```ts
onCellEdited={([col, row], v) => {
  if (v.kind !== GridCellKind.Text) return;
  pending.edit(row, col, { t: "Text", v: v.data });
  bump(); // zustand 버전 증가 → 리렌더
}}
getCellContent={([col, row]) => decorate(toGridCell(valueAt(row, col), meta[col]), pending.stateOf(row, col))}
```

**완료 조건**
- 셀 수정, 행 추가, 행 삭제, NULL 지정, 개별 Revert, 전체 Revert가 모두 화면에 올바르게 표시된다. 이 단계에서는 DB에 아무것도 쓰지 않는다.
- 엑셀에서 2×3 영역을 붙여 넣으면 6개 셀이 보류 상태가 된다.
- `PendingChanges` 단위 테스트가 통과한다(같은 셀 재편집, 원래 값으로 되돌림, 추가 행 삭제 시 제거).

---

### T17. Submit 커맨드 ✅ (SQLite 검증 완료 · PG/MySQL 검증은 Docker 준비 후)

**작업 내용**
- 커맨드 `submit_changes(req) -> SubmitResult`
  - `req = { conn_id, console_id?, schema, table, key: RowKey, columns: ColumnMeta[], updates[], inserts[], deletes[] }`
  - 각 항목은 원래 값과 새 값을 문자열/NULL로 담는다.
- SQL 생성(`db::edit`, 드라이버별 플레이스홀더와 따옴표)
  - UPDATE: `UPDATE t SET c1 = <p1> WHERE k1 = <p2> AND k2 IS NULL ...`
  - DELETE: `DELETE FROM t WHERE <키 조건>`
  - INSERT: 값이 지정된 컬럼만 넣는다(기본값과 자동 증가 컬럼 유지).
  - PG 값 캐스팅
    - SET/INSERT 값은 `$n::<full_type>`
    - WHERE의 키 비교: `pk`/`unique` 모드는 `col = $n::<full_type>`, `allColumns` 모드는 `col::text = $n`(json 등 등호가 없는 타입 대비, 텍스트 포맷 값과 일치)
  - MySQL/SQLite: `?` 바인딩, 문자열 그대로(암묵 변환)
- 실행
  - 하나의 트랜잭션에서 순서대로 실행한다: DELETE → UPDATE → INSERT.
  - UPDATE/DELETE마다 `rows_affected == 1`을 확인한다. 아니면 **전체 롤백**하고, 문제 항목의 행 인덱스와 영향 행 수를 반환한다.
  - 콘솔이 Manual 트랜잭션 중이면 그 연결에서 SAVEPOINT로 실행하고 커밋하지 않는다(T18 이후 적용).
- 성공 시 프론트는 보류 변경을 비우고 현재 페이지를 다시 조회한다.
- 단축키: 그리드에 포커스가 있을 때 `Ctrl+Enter`로 Submit.

**작업 예시**

```rust
// db/edit.rs (PG UPDATE 조립)
fn pg_update(t: &str, set: &[(&ColumnMeta, Option<&str>)], key: &[(&ColumnMeta, Option<&str>)], all_cols: bool) -> (String, Vec<Option<String>>) {
    let mut sql = format!("UPDATE {t} SET "); let mut binds = vec![]; let mut n = 0;
    for (i, (c, v)) in set.iter().enumerate() {
        n += 1; if i > 0 { sql.push_str(", "); }
        sql.push_str(&format!("{} = ${n}::{}", q(&c.name), c.full_type)); binds.push(v.map(str::to_owned));
    }
    sql.push_str(" WHERE ");
    for (i, (c, v)) in key.iter().enumerate() {
        if i > 0 { sql.push_str(" AND "); }
        match v {
            None => sql.push_str(&format!("{} IS NULL", q(&c.name))),
            Some(v) => { n += 1; sql.push_str(&if all_cols { format!("{}::text = ${n}", q(&c.name)) } else { format!("{} = ${n}::{}", q(&c.name), c.full_type) }); binds.push(Some((*v).to_owned())); }
        }
    }
    (sql, binds)
}
```

콜스택:
```
ResultGrid Ctrl+Enter / 툴바 Submit
 → useGrid.submit(tabId)
   → buildSubmitRequest(pending, result, rowKey, tableMeta)
   → api.submitChanges(req) → invoke("submit_changes")
   → commands::edit::submit_changes
     → db::edit::plan(req) → Vec<(sql, binds, row_ref)>
     → tx = conn.begin()
       → for stmt: sqlx::query(sql).bind(..).execute(&mut *tx) → rows_affected 검사
       → 불일치: tx.rollback() → Err(SubmitError{ row_ref, affected })
     → tx.commit()
 → 성공: pending.clear() → refetch(page) / 실패: 해당 행 강조 + 토스트
```

**완료 조건**
- 3개 DB에서 PK 테이블의 수정, 추가, 삭제가 반영된다. 반영 후 재조회한 값이 일치한다.
- PG에서 int, numeric, date, timestamptz, uuid, json, enum 컬럼 수정이 캐스팅 오류 없이 반영된다.
- PK 없는 테이블에 **완전히 같은 행 2개**가 있을 때 하나를 수정하면, 전체 롤백되고 "2행에 영향" 알림이 뜬다. 이때 DB는 변경되지 않는다.
- 다른 세션에서 먼저 값이 바뀐 행을 수정하면 0행 영향으로 롤백되고 알림이 뜬다.
- 변경 10개 중 1개가 실패하면 나머지 9개도 반영되지 않는다.

---

### T18. Manual 트랜잭션 모드 ✅ (SQLite 검증 완료 · PG/MySQL 검증은 Docker 준비 후)

**작업 내용**
- 콘솔 툴바에 `Auto` / `Manual` 토글을 둔다. Manual로 바꾸면 Commit, Rollback 버튼이 활성화된다.
- Rust `AppState.dedicated: Mutex<HashMap<ConsoleId, DedicatedConn>>`
  - Manual로 전환하면 `DbPool::connect_dedicated(cfg)`로 **풀 밖의** 단일 연결을 만들고 `BEGIN`을 실행한다.
  - `execute`는 콘솔 id로 전용 연결을 먼저 찾는다.
  - Commit/Rollback 후 바로 다음 `BEGIN`을 실행한다(JetBrains와 동일).
  - Auto로 돌아갈 때 미커밋 변경이 있으면 커밋할지 롤백할지 묻고, 연결을 닫는다.
- 콘솔 탭을 닫거나 접속을 해제할 때도 미커밋 확인 후 연결을 정리한다.
- 쿼리 오류로 PG 트랜잭션이 aborted 상태가 되면 상태 표시줄에 "트랜잭션 중단됨 — Rollback 필요"를 표시한다.
- 콘솔 결과 그리드의 Submit은 T17의 SAVEPOINT 경로를 쓴다.

**작업 예시**

```
ConsoleToolbar.toggleTx("manual")
 → api.setTxMode(connId, consoleId, "manual") → invoke("set_tx_mode")
 → commands::exec::set_tx_mode
   → db::pool::connect_dedicated(cfg, pw) → raw_sql("BEGIN")
   → state.dedicated.insert(console_id, conn)
```

**완료 조건**
- Manual 모드에서 `INSERT` 후 다른 콘솔(Auto)에서 조회하면 보이지 않고, Commit 후에는 보인다.
- Rollback하면 변경이 사라진다.
- Manual 콘솔을 3개 열어도 풀(최대 2개)이 고갈되지 않는다. 다른 탭의 쿼리와 메타 조회가 계속 동작한다.
- 미커밋 상태에서 탭을 닫으면 확인 대화상자가 뜬다.

---

### T19. WHERE 없는 UPDATE/DELETE 경고 ✅

**작업 내용**
- 실행 직전에 `stmt.kind === "dml"`이고 첫 키워드(WITH 이후 포함)가 UPDATE/DELETE이며 `!hasTopLevelWhere`이면 확인 대화상자를 띄운다.
  - 문구: "WHERE 조건이 없습니다. 테이블 `x`의 모든 행이 변경됩니다."
  - 버튼: 실행 / 취소
- MySQL의 `DELETE ... LIMIT n`처럼 LIMIT이 있으면 경고 문구만 완화한다(경고 자체는 유지).
- 여러 문장을 실행할 때는 경고 대상이 있으면 실행 전에 한꺼번에 묻는다.

**작업 예시**

```ts
const risky = stmts.filter(s => s.kind === "dml" && /^(UPDATE|DELETE)$/.test(s.dmlVerb!) && !s.hasTopLevelWhere);
if (risky.length && !(await confirmDialog(renderRiskyList(risky)))) return;
```

**완료 조건**
- `DELETE FROM t;`, `UPDATE t SET a=1`은 경고가 뜨고, 취소하면 실행되지 않는다.
- `DELETE FROM t WHERE id IN (SELECT ... WHERE ...)`는 경고가 뜨지 않는다. 서브쿼리의 WHERE가 아니라 최상위 WHERE로 판정하는지 단위 테스트로 확인한다.
- 문자열이나 주석 안의 `WHERE`에 속지 않는다.

> **M2 마일스톤 완료 조건:** 테이블 뷰와 단일 테이블 콘솔 결과를 편집해서 Submit/Revert할 수 있다. PK 없는 테이블의 다중 매칭은 롤백으로 막힌다. Manual 트랜잭션이 동작한다.

---

## M3 — 마무리

### T20. WHERE/ORDER BY 필터와 헤더 정렬 ✅

**작업 내용**
- 테이블 뷰 툴바에 `WHERE`와 `ORDER BY` 한 줄 입력란을 둔다. 둘 다 CodeMirror 단일 행 모드로, 컬럼 자동완성을 지원한다. `Enter`로 적용한다.
- 쿼리 조립: `SELECT * FROM t [WHERE <w>] [ORDER BY <o>]` 후 T11의 페이지 조회를 그대로 탄다.
- 헤더 클릭 정렬
  - 클릭할 때마다 ASC → DESC → 해제 순서로 바뀌고, ORDER BY 입력란 내용을 갱신한다. `Shift+클릭`은 다중 정렬.
  - 헤더에 화살표를 표시한다.
- 콘솔 결과 그리드의 헤더 정렬은 **현재 페이지만 클라이언트 측에서** 정렬하고, 툴팁으로 이를 안내한다.
- 필터를 적용하면 offset을 0으로 초기화한다. 보류 변경이 있으면 확인 대화상자를 띄운다.

**작업 예시**

```ts
const sql = `SELECT * FROM ${qualified(d, schema, table)}` + (where ? ` WHERE ${where}` : "") + (orderBy ? ` ORDER BY ${orderBy}` : "");
```

**완료 조건**
- WHERE 입력 후 결과와 행 수 조회가 필터된 결과를 따른다.
- 헤더 정렬 순환과 다중 정렬이 ORDER BY 입력란과 동기화된다.
- 잘못된 WHERE를 넣으면 DB 오류 메시지가 표시되고, 이전 결과는 유지된다.

---

### T21. 내보내기 (TSV / CSV / JSON / INSERT) ✅ (SQLite 검증 완료 · PG/MySQL INSERT 왕복은 Docker 준비 후 · 엑셀에서 직접 열어 보기는 미확인)

**작업 내용**
- 그리드 우클릭 메뉴 "복사 형식" → TSV(기본), JSON, SQL INSERT. 선택 영역이 없으면 현재 페이지 전체를 대상으로 한다. `navigator.clipboard.writeText`를 쓴다.
  - JSON: `[{ col: value | null }]` 형태이며, 값은 문자열을 유지한다.
  - INSERT: 원본 테이블을 알 때는 그 이름을 쓰고, 모르면 `<table>` 자리표시자를 넣는다. 값은 드라이버별 리터럴로 이스케이프한다(`'` → `''`, NULL은 NULL).
- "CSV로 내보내기..." (쿼리 **전체** 결과)
  - `plugin-dialog`의 `save()`로 경로를 정한다.
  - 커맨드 `export_csv(conn_id, sql, path, exec_id)`: 페이지 LIMIT 없이 `raw_sql(..).fetch(&mut conn)` 스트림을 받아 `BufWriter`로 한 행씩 쓴다. RFC 4180 이스케이프, UTF-8 BOM 옵션(엑셀 호환), 1만 행마다 진행 이벤트(`app.emit`)를 보낸다.
  - T12의 취소 레지스트리를 공유한다. 취소하면 파일을 삭제한다.
- 직렬화 함수는 `src/grid/serialize.ts`(TS)와 `db/export.rs`(Rust CSV)에 둔다.

**작업 예시**

```rust
fn csv_field(s: &str) -> Cow<str> {
    if s.contains([',', '"', '\n', '\r']) { Cow::Owned(format!("\"{}\"", s.replace('"', "\"\""))) } else { Cow::Borrowed(s) }
}
```

콜스택:
```
ResultGrid 우클릭 → "CSV로 내보내기"
 → dialog.save({ defaultPath: `${table}.csv` })
 → api.exportCsv(connId, sql, path, execId) → invoke("export_csv")
 → commands::export::export_csv → db::export::csv(conn, sql, path, |n| app.emit("export-progress", n))
```

**완료 조건**
- 100만 행 CSV 내보내기에서 앱 메모리 증가가 50MB 이하이고 진행률이 표시된다.
- 쉼표, 따옴표, 줄바꿈, 한글이 든 값이 엑셀에서 올바르게 열린다(BOM 옵션 켠 상태).
- INSERT 복사 결과를 같은 DB에서 실행하면 원래 행과 같은 행이 만들어진다(3개 DB).
- 내보내기 중 취소하면 부분 파일이 남지 않는다.

---

### T22. 타입별 에디터 ✅ (SQLite 검증 완료 · enum/bool/json 편집은 PG/MySQL로 Docker 준비 후 검증)

**작업 내용**
- Glide `provideEditor`로 컬럼 메타(`data_type`, `enum_values`)에 따라 오버레이 에디터를 고른다. 모두 브라우저 기본 요소로 만든다.
  - date → `<input type="date">`
  - timestamp/datetime → `<input type="datetime-local" step="1">`(초 단위)
  - 시간대 포함 타입은 원래 문자열의 오프셋을 보존하는 텍스트 입력을 함께 둔다.
  - enum → `<select>` (+ nullable이면 `<null>` 옵션)
  - bool → `<select>` true/false/null
  - json/jsonb → `<textarea>` 팝업 + "포맷" 버튼(`JSON.stringify(JSON.parse(v), null, 2)`). 저장 시 파싱해서 검증하고, 실패하면 저장 버튼을 비활성화하고 오류 위치를 표시한다.
  - 긴 텍스트(200자 초과 또는 줄바꿈 포함) → `<textarea>` 팝업
  - Blob → 팝업에 크기 표시와 버튼 두 개
    - "파일로 저장": 커맨드 `read_blob(conn_id, table, key) → path`. 행 키로 단건을 조회해 파일로 쓴다.
    - "파일에서 불러오기": `write_blob(...)`. 보류 변경으로 넣지 않고 즉시 단건 UPDATE 트랜잭션으로 반영하며, 확인 대화상자를 띄운다.
- 값을 텍스트로 바꿀 때 DB 표기 형식으로 맞춘다. 예: `datetime-local`의 `T`를 공백으로 바꾼다.

**작업 예시**

```tsx
provideEditor={(cell) => {
  const meta = colMetaOf(cell);
  if (meta?.enum_values) return { editor: EnumEditor, disablePadding: true };
  if (isDateType(meta)) return { editor: DateEditor };
  if (isJsonType(meta)) return { editor: JsonEditor, styleOverride: { width: 480 } };
  return undefined; // 기본 텍스트 에디터
}}
```

**완료 조건**
- 3개 DB에서 날짜, 일시, enum, bool, JSON 컬럼을 전용 에디터로 수정하고 Submit할 수 있다.
- 잘못된 JSON은 저장할 수 없다.
- BLOB을 파일로 저장하고 다시 불러온 뒤 내용이 바이트 단위로 같다(해시 비교).
- 추가한 라이브러리가 없다(`package.json` 의존성 변화 없음).

---

### T23. 읽기 전용 접속 모드 ✅ (SQLite 검증 완료 · PG/MySQL 검증은 Docker 준비 후)

**작업 내용**
- `read_only` 접속은 연결 옵션에 반영한다(풀 연결과 전용 연결 모두).
  - PG: `PgConnectOptions::options([("default_transaction_read_only", "on")])`
  - MySQL: `MySqlPoolOptions::after_connect(|c, _| Box::pin(async move { c.execute("SET SESSION TRANSACTION READ ONLY").await.map(|_| ()) }))`
  - SQLite: `SqliteConnectOptions::read_only(true)`
- UI
  - 트리, 탭, 상태 표시줄에 "READ ONLY" 배지와 접속 색상을 표시한다.
  - 그리드 편집, 행 추가/삭제, Submit, BLOB 쓰기 메뉴를 비활성화한다.
  - Manual 트랜잭션 토글은 유지한다(읽기 일관성용).
- 서버가 쓰기를 거부하면 그 오류 메시지를 그대로 보여 준다.
- 수동으로 우회하는 경우(예: PG에서 `SET default_transaction_read_only = off`)는 막지 않는다. 실수 방지 기능이지 보안 기능이 아니라는 점을 설정 다이얼로그 도움말에 적는다.

**완료 조건**
- 3개 DB 모두 읽기 전용 접속의 콘솔에서 `INSERT`, `UPDATE`, `CREATE TABLE`이 서버 오류로 거부된다.
- 같은 접속에서 SELECT, 행 수 조회, CSV 내보내기는 정상 동작한다.
- 그리드 편집 UI가 비활성화돼 있다.

---

### T24. 경량성 점검과 패키징 ✅

**작업 내용**
- `npm run tauri build`로 NSIS 설치 파일과 단독 exe를 만든다.
- 측정·기록 항목을 `DESIGN.md` 끝에 "측정 결과" 표로 남긴다.
  - 설치 파일 크기, exe 크기
  - 시작 후 유휴 메모리(작업 관리자, WebView2 프로세스 포함)
  - 콜드 스타트 시간
  - 프론트 번들 크기(gzip)
- 큰 의존성 점검: `vite build --mode analyze`(rollup-plugin-visualizer는 개발 의존성으로만), `cargo bloat --release --crates`.
- 콘솔 로그와 개발용 코드가 릴리스 빌드에 섞이지 않았는지 확인한다.

**완료 조건**(목표치이며, 넘으면 원인을 기록하고 조치 여부를 결정한다)
- 설치 파일 15MB 이하
- 유휴 메모리 150MB 이하(WebView2 포함)
- 콜드 스타트 1.5초 이하
- 프론트 JS 번들 gzip 1MB 이하
- 측정 결과 표가 DESIGN.md에 추가돼 있다.

> **M3 마일스톤 완료 조건:** DESIGN.md의 모든 기능이 3개 DB에서 동작하고, T24 목표치를 만족하거나 초과 사유가 기록돼 있다.

---

## 의존 관계 요약

```
T01 → T02 → T03 → T04 → T05
                  T04 → T06 → T07
              T02 → T08 → T09 (← T06 스키마 스냅샷)
              T02 → T10
       T04 + T10 → T11 → T12
             T11 + T08 → T13 → T14
M1 완료 → T15 → T16 → T17 → T18 → T19
M2 완료 → T20, T21, T22, T23 (서로 독립) → T24
```

## 확인이 필요한 기술 위험

구현 초기에 짧은 스파이크로 확인한다.

| 위험 | 확인 시점 | 대안 |
|---|---|---|
| sqlx `raw_sql` + `try_get_unchecked::<String>`가 PG/MySQL 텍스트 포맷 값을 모든 타입에서 그대로 읽는지 | T11 시작 시 | 실패하는 타입만 드라이버별 디코더로 분기 |
| SQLite 실행 중 `lock_handle` 포인터 획득과 `sqlite3_interrupt`의 스레드 안전성 | T12 | 취소 시 연결을 버리고 새로 여는 방식 |
| `conn.describe()`가 0행 결과에서 3개 DB 모두 컬럼 이름을 주는지 | T11 | 0행이면 헤더 없이 "0 rows" 표시 |
| Glide Data Grid peer 의존성으로 인한 번들 크기 | T13 | 필요한 경우 lodash 개별 import 별칭 설정 |
| PG에서 `$n::<format_type>` 캐스팅이 배열, 도메인, 스키마 한정 enum에서 동작하는지 | T17 | `allColumns`처럼 `::text` 비교와 `CAST`로 우회 |

## 추가 요청 (2026-10-18)

| | 항목 | 조치 | 확인 |
|---|---|---|---|
| ✅ | 트리에서 테이블 인덱스 목록 보기 + 툴팁에 인덱스 컬럼 | 백엔드 `list_indexes`(PG `pg_index`, MySQL `STATISTICS`, SQLite `pragma_index_list`). SQLite의 rowid 기본키는 `PRIMARY KEY`로 따로 표시. 테이블 아래를 `columns`/`indexes` 폴더로 나누고, `indexes`는 펼칠 때 불러온다. 행에 마우스를 올리면 종류와 컬럼 목록을 툴팁으로 보여 준다 | SQLite 화면 확인, Rust 테스트 |
| ✅ | 결과 툴바: 편집 문구 대신 새로고침·행 추가·행 삭제 버튼 | `✎ 편집 가능 · 기본키` 문구 제거. 새로고침은 데이터를 바꾸는 문장 결과에서는 비활성화. 행 삭제는 선택한 행이 있을 때만 활성화. 키가 없어 모든 컬럼으로 매칭할 때만 `⚠ 키 없음` 표시 | 화면 확인 |
| ✅ | 새 접속에서 DB 종류를 고르면 해당 DB의 BI 표시 | 드라이버 선택을 로고 카드 3개로 변경(인라인 SVG, 브랜드 색). 사이드바 접속 배지도 같은 로고로 변경 | 화면 확인 |
| ✅ | 결과 헤더에 PK 표시 | 단일 테이블 결과면 기본키 컬럼 헤더에 열쇠 아이콘(Glide `headerIcons`). 읽기 전용 접속에서도 표시 | 화면 확인 |
| ✅ | 접속 새로고침 후 컬럼 목록이 `불러오는 중…`에 멈추는 버그 | 원인: 새로고침이 캐시만 비우고, 펼쳐 둔 테이블 노드는 다시 불러오지 않음. 노드가 펼쳐진 상태에서 캐시가 비면 다시 불러오게 수정 | 화면 확인 |
| ✅ | 그리드 편집 Ctrl+Z / Ctrl+Shift+Z | `PendingChanges`에 실행 취소 기록(최대 200단계). 셀 편집, 붙여넣기 1회, 행 추가·삭제, NULL 설정, 되돌리기가 각각 한 단계. Ctrl+Y도 다시 실행. 셀 편집기 안에서는 입력란 자체의 실행 취소가 동작 | 단위 테스트 3개, 화면 확인 |
| ✅ | 스크립트 Ctrl+Shift+Z | CodeMirror 기본 키맵은 Windows에서 Ctrl+Y만 묶으므로 `Mod-Shift-z`를 추가 | 화면 확인 |

- PG/MySQL 인덱스 쿼리는 Docker 준비 후 검증한다.

## 추가 요청 2 (2026-10-18)

| | 항목 | 조치 | 확인 |
|---|---|---|---|
| ✅ | 로고는 공식 로고 사용 | 직접 그린 SVG를 지우고 devicon v2.16.0의 공식 로고 SVG(PostgreSQL, MySQL, SQLite)를 `src/assets/logos/`에 넣음. 출처와 상표 고지는 같은 폴더 `NOTICE.md` | 화면 확인 |
| ✅ | DB 종류는 드롭다운 + 글자 크기 로고 | 카드형 선택을 없애고 드롭다운으로 되돌림. 기본 `<select>`는 옵션에 이미지를 넣을 수 없어 같은 모양의 작은 선택 상자를 만듦(방향키, Enter, Escape 지원. 목록이 열려 있으면 Escape는 목록만 닫음). 사이드바 접속 앞에도 같은 로고 | 화면 확인 |
| ✅ | Submit 전 SQL 확인 모달, 모달에서 쿼리·값 수정 가능 | Submit(또는 그리드 Ctrl+Enter)을 누르면 실제로 나갈 SQL을 값이 들어간 형태로 보여 줌(백엔드 `preview_changes`, 바인딩 실행과 같은 식). 고치지 않으면 기존처럼 바인딩으로 반영하고, 고쳤으면 고친 SQL을 한 트랜잭션으로 실행(`submit_sql`). UPDATE/DELETE가 정확히 1행에 영향을 주지 않거나 오류가 나면 전체 롤백하고 해당 문장을 표시. 트랜잭션 제어문은 거부 | Rust·프론트 단위 테스트, 화면 확인 |
| ✅ | 복사·내보내기를 테이블 상단 버튼으로 | 결과 툴바에 `⧉ 복사 ▾`(TSV/JSON/INSERT)와 `⭳ CSV 내보내기` 버튼. 우클릭 메뉴에도 같은 항목을 남김 | 화면 확인 |
| ✅ | 하단 행 범위를 누르면 페이지 크기 선택 | 100/200/500/1,000/5,000/10,000/직접 입력(최대 100,000). 바꾸면 첫 페이지부터 다시 읽고, 이 PC에 저장. 백엔드 `execute`가 `page_size`를 받음 | Rust 테스트, 화면 확인 |

---

## M4 — Redis · MongoDB (설계: DESIGN.md "Redis · MongoDB")

순서: N01 → Redis(R01~R05) → MongoDB(G01~G07) → N02. PG/MySQL과 마찬가지로 실제 서버 검증은 Docker(WSL2) 준비 후 한다. 그전에는 각 태스크의 단위 테스트를 완료 조건으로 삼고 "서버 검증은 Docker 준비 후"로 표시한다.

### N01. 접속 모델을 비-SQL 드라이버로 넓히기 ✅ (구현 메모: `Backend` 열거형 대신 `AppState`에 Redis·Mongo 접속 맵을 따로 둠. SQL 코드 변경을 최소화하기 위해서)

**작업 내용**
- `Driver`에 `Redis`, `Mongodb` 추가. `ConnectionConfig`에 선택 필드 추가: `redis_db: u8`, `key_separator: String`(기본 `:`), `mongo_uri: String`. 기존 connections.json은 기본값으로 읽힌다(`#[serde(default)]`).
- `Connected.pool: DbPool`을 `Backend { Sql(DbPool), Redis(..), Mongo(mongodb::Client) }`로 바꾼다. SQL 전용 커맨드는 `Sql`이 아니면 "이 접속에서는 지원하지 않습니다" 오류.
- 접속 대화상자: 드라이버별 폼 분기(Redis: 호스트/포트/사용자/비밀번호/DB 번호/구분자/TLS, Mongo: URI + 비밀번호). Mongo URI에 비밀번호가 있으면 떼어 내 비밀번호 칸으로 옮긴다.
- 로고: devicon의 redis·mongodb 공식 SVG를 `src/assets/logos/`에 추가하고 NOTICE 갱신.
- 탭 종류에 `redisKey`, `mongoCollection` 추가. 콘솔은 접속 드라이버로 언어 모드를 고른다.

**작업 예시**

```rust
pub enum Backend {
    Sql(DbPool),
    Redis { conn: redis::aio::MultiplexedConnection, write_cmds: Arc<HashSet<String>> },
    Mongo(mongodb::Client),
}
impl Connected {
    pub fn sql(&self) -> AppResult<&DbPool> {
        match &self.backend { Backend::Sql(p) => Ok(p), _ => Err(AppError::user("SQL 접속이 아닙니다")) }
    }
}
```

**완료 조건**
- 기존 PG/MySQL/SQLite 동작과 테스트가 그대로 통과한다(회귀 없음).
- 기존 connections.json이 그대로 열린다. Redis·Mongo 접속을 저장·편집·삭제할 수 있고, 비밀번호는 키체인에만 있다.
- URI 비밀번호 분리 함수 단위 테스트: `mongodb://u:p@h/?x=1` → URI `mongodb://u@h/?x=1` + 비밀번호 `p`, 퍼센트 인코딩 포함.

---

### R01. Redis 연결 · 연결 테스트 · 읽기 전용 검사 ✅ (단위 테스트 완료 · 서버 검증은 Docker 준비 후)

**작업 내용**
- `db/redis.rs`: 설정 → `redis::ConnectionInfo`(TLS면 `rediss`), 연결 후 `SELECT db`. 연결 테스트는 `PING` + `INFO server`의 버전.
- 접속 시 `COMMAND INFO`(또는 `COMMAND`)로 `write` 플래그 명령 집합을 받아 둔다. 읽기 전용 접속이면 콘솔·편집 명령의 첫 단어가 집합에 있을 때 거부한다. `MULTI`/`EVAL`/`EVALSHA`/`FUNCTION`/`SCRIPT`도 거부한다.
- 키 이름·값은 바이트열로 다룬다. UTF-8이면 텍스트, 아니면 바이너리로 표시한다.

**작업 예시**

```rust
pub fn check_read_only(write_cmds: &HashSet<String>, argv: &[Vec<u8>]) -> AppResult<()> {
    let cmd = String::from_utf8_lossy(&argv[0]).to_ascii_uppercase();
    if write_cmds.contains(&cmd) || ["MULTI", "EVAL", "EVALSHA", "FUNCTION", "SCRIPT"].contains(&cmd.as_str()) {
        return Err(AppError::user(format!("읽기 전용 접속에서는 {cmd}을(를) 실행할 수 없습니다")));
    }
    Ok(())
}
```

**완료 조건**
- 단위 테스트: 읽기 전용 검사(SET 거부, GET 허용, 소문자 명령).
- 서버 검증(Docker 후): 연결 테스트 성공·실패 메시지, TLS 접속, 읽기 전용에서 `SET` 거부.

---

### R02. Redis 트리 (DB 노드 · 키 폴더 · SCAN 500) ✅ (단위 테스트 완료 · 서버 검증은 Docker 준비 후)

**작업 내용**
- 커맨드 `redis_dbs(conn_id) -> [{db, keys}]`(`INFO keyspace`).
- 커맨드 `redis_scan(conn_id, db, cursor, pattern, count=500) -> { cursor, keys: [{name, type}] }`. `SCAN cursor MATCH p COUNT n`을 500개가 모일 때까지 반복하고, 타입은 파이프라인 `TYPE`으로 받는다.
- 트리: 접속 ▸ `db0 (1,204)` ▸ 구분자 폴더 ▸ 키. 폴더는 받은 키 이름으로 만든다. 폴더 옆에 하위 키 수, 키 옆에 타입 배지.
- DB 노드 아래에 패턴 입력(Enter로 다시 스캔)과 "더 불러오기(500)". 끝까지 받았으면 숨긴다.
- 새로고침은 커서를 0부터 다시 시작한다.

**작업 예시**

```ts
// "user:1:profile" → ["user", "1", "profile"] 경로로 폴더 트리를 만든다
export function buildKeyTree(keys: RedisKey[], sep: string): KeyNode { /* 접두어별 Map, 마지막 조각이 키 */ }
```

**완료 조건**
- 단위 테스트: `buildKeyTree`(구분자 변경, 빈 조각 `a::b`, `user`와 `user:1`처럼 키 이름이 폴더 이름과 같은 경우).
- 서버 검증(Docker 후): 키 1만 개에서 처음 500개만 받고 더 불러오기로 늘어난다. 패턴 `user:*`가 서버에서 걸러진다.

---

### R03. Redis 키 탭 (타입별 보기 · 페이지 · TTL) ✅ (단위 테스트 완료 · 서버 검증은 Docker 준비 후)

**작업 내용**
- 커맨드 `redis_key_info(conn_id, db, key) -> { type, ttl, memory, length }`.
- 커맨드 `redis_read(conn_id, db, key, type, cursor/offset, count)`:
  - string: `GET`(크기가 크면 앞부분 + 전체 크기)
  - hash `HSCAN`, set `SSCAN`, zset `ZSCAN`(또는 `ZRANGE … WITHSCORES` 오프셋), list `LRANGE`, stream `XRANGE`
- 탭 UI
  - 상단: 타입 · TTL · 크기 · 길이, 그리고 TTL 변경 / 이름 변경 / 삭제 / 새로고침 버튼.
  - 아래: string이면 텍스트·JSON 편집기, 컨테이너 타입이면 결과 그리드.
  - 그리드 컬럼: hash=field,value / list=index,value / set=member / zset=member,score / stream=id,fields.
- 페이지 크기는 앱 설정을 공유한다. SCAN 계열은 커서 기반이라 "다음"만 있고, 이미 본 페이지는 보관해 "이전"으로 돌아간다.
- 사이드바 우클릭: 새 키(타입 선택), 키 삭제.

**완료 조건**
- 단위 테스트: 결과 → 그리드 행 변환(바이너리 값, zset score 표기).
- 서버 검증(Docker 후): 다섯 타입과 stream 표시, 10만 필드 hash가 페이지 단위로 열린다, TTL 변경·이름 변경·삭제.

---

### R04. Redis 편집 · Submit 미리보기 (WATCH + MULTI/EXEC) ✅ (단위 테스트 완료 · 서버 검증은 Docker 준비 후. 구현 메모: 읽은 뒤 변경 감지는 타입·길이 비교 + 반영 중 WATCH)

**작업 내용**
- 그리드 편집은 기존 `PendingChanges`를 쓴다. 타입별로 보류 변경을 명령 목록으로 바꾼다.
  - hash: 수정·추가 `HSET k f v`, 삭제 `HDEL k f`, field 이름 변경은 `HDEL` + `HSET`
  - list: 수정 `LSET k i v`, 추가 `RPUSH`, 삭제는 `LSET k i <표식>` + `LREM k 1 <표식>`
  - set: 추가 `SADD`, 삭제 `SREM`, 수정은 `SREM` + `SADD`
  - zset: score 수정·추가 `ZADD k score m`, 삭제 `ZREM`, member 수정은 `ZREM` + `ZADD`
  - string: `SET k v KEEPTTL`
- 미리보기 모달: 기존 `SubmitPreview`를 드라이버 중립으로 바꾼다. redis-cli 형식 명령 목록을 보여 주고 고칠 수 있다. "Redis는 실패해도 롤백되지 않음"을 표시한다.
- 반영: 전용 연결에서 `WATCH key` → `MULTI` → 명령들 → `EXEC`. `WATCH`는 키를 읽을 때 걸어 둔다.
  - `EXEC`가 nil이면 "다른 곳에서 바뀌어 반영하지 않았습니다. 다시 읽으세요."를 보여 준다.
- 읽기 전용 접속은 편집 UI를 끄고, 백엔드도 거부한다.

**작업 예시**

```ts
export function redisCommands(kind: RedisType, key: string, p: PendingChanges): string[][] {
  // 예: hash 수정 → [["HSET", key, field, value]]
}
```

**완료 조건**
- 단위 테스트: 타입별 명령 생성(이름 변경, 삭제+추가 순서, 바이너리·공백·따옴표가 든 값의 redis-cli 인용).
- 서버 검증(Docker 후): 다섯 타입 편집 반영. 다른 연결에서 키를 바꾼 뒤 Submit하면 EXEC nil 안내가 나온다.

---

### R05. Redis 콘솔 ✅ (단위 테스트 완료 · 서버 검증은 Docker 준비 후. 구현 메모: SELECT는 콘솔 DB 선택으로 처리, MONITOR/SUBSCRIBE는 지원하지 않음)

**작업 내용**
- 인자 분리기 `splitRedisArgs(line)`: redis-cli 규칙(공백 구분, `"…"` 안의 `\n`·`\xNN` 이스케이프, `'…'`는 원문). 여러 줄을 선택하면 줄마다 실행하고 결과 탭을 만든다.
- 커맨드 `redis_exec(conn_id, console_id, db, argv) -> RedisReply`. 응답은 nil / int / bulk(text|binary) / array / map / error / status를 재귀로 담는다. 읽기 전용 검사를 거친다.
- 결과 표시: redis-cli 형식 텍스트(`1) "a"` 들여쓰기). 배열이면 그리드 보기로 전환할 수 있다(평탄 배열은 1컬럼, HGETALL 같은 짝 배열은 2컬럼).
- 자동완성: `COMMAND DOCS`가 있으면 명령 이름과 인자 요약, 없으면 내장 명령 목록.
- 중지: 실행 중인 명령은 전용 연결을 닫아 끊는다.
- 위험 명령(`FLUSHALL`, `FLUSHDB`, `KEYS *`)은 실행 전에 확인한다.

**완료 조건**
- 단위 테스트: `splitRedisArgs`(따옴표, 이스케이프, 빈 문자열 `""`, 닫히지 않은 따옴표 오류), 응답 → 텍스트 렌더.
- 서버 검증(Docker 후): `HGETALL`, `INFO`, `BLPOP x 0` 중지, 읽기 전용에서 `SET` 거부.

---

### G01. MongoDB 연결 · URI · 읽기 전용 검사 ✅ (단위 테스트 완료 · 서버 검증은 Docker 준비 후)

**작업 내용**
- `db/mongo.rs`: URI 파싱(`ClientOptions::parse`, srv 포함) + 키체인 비밀번호 주입, `appName = data-connector`.
- 연결 테스트는 `ping` + `buildInfo` 버전 + 토폴로지(standalone/replicaset/sharded)를 보여 준다. 토폴로지는 `Connected`에 기록한다(트랜잭션 가능 여부).
- 읽기 전용 검사: 작업 종류로 판단한다. insert/update/delete/replace/findAndModify/drop*/create*/rename, `$out`·`$merge` 단계, runCommand의 쓰기 명령 이름 목록을 거부한다.

**완료 조건**
- 단위 테스트: 비밀번호 주입(URI에 사용자만 있을 때/없을 때), 읽기 전용 판정(aggregate의 `$merge` 거부, `find` 허용, runCommand `{drop: "x"}` 거부).
- 서버 검증(Docker 후): standalone·replicaset 각각 연결 테스트 표시.

---

### G02. MongoDB 트리 ✅ (서버 검증은 Docker 준비 후)

**작업 내용**
- 커맨드 `mongo_dbs`, `mongo_collections(db) -> [{name, kind: collection|view|timeseries, estimated}]`.
- 커맨드 `mongo_indexes(db, coll) -> IndexInfo[]`: 키 목록(`{a: 1, b: -1}`), unique, TTL `expireAfterSeconds`, partial.
- 트리: 접속 ▸ DB ▸ `collections`/`views` 폴더 ▸ 컬렉션(추정 문서 수) ▸ `indexes`(툴팁: 키·옵션). 기존 SQL 트리 컴포넌트(`SubFolder`, 인덱스 툴팁)를 재사용한다.
- 컬렉션을 더블클릭하면 컬렉션 탭이 열린다.

**완료 조건**
- 서버 검증(Docker 후): 시드 DB의 컬렉션·뷰·인덱스와 툴팁.
- 접속 새로고침 후에도 펼친 노드가 다시 불러와진다(기존 버그 회귀 방지).

---

### G03. mongosh 표기 ↔ Extended JSON 변환 ✅ (구현 메모: 소수점 없는 정수는 int32/int64, 소수점이 있으면 double로 표시·해석해 타입이 왕복되게 함)

**작업 내용**
- `src/mongo/shell.ts`의 `parseShellValue(text) -> EJSON`: mongosh 표기를 Canonical Extended JSON으로 바꾼다.
  - 문법: 키 따옴표 생략, 작은따옴표 문자열, 끝 콤마.
  - 타입: `ObjectId("…")`, `ISODate("…")`/`new Date("…")`, `NumberLong`, `NumberInt`, `NumberDecimal`, `BinData(n, "b64")`, `UUID("…")`, `Timestamp(t, i)`, `MinKey`/`MaxKey`, 정규식 `/…/i`.
- `src/mongo/shell.ts`의 `formatShell(ejson, indent?)`: 반대 방향. 그리드 셀은 한 줄, JSON 보기는 들여쓰기.
- 백엔드는 `bson::Bson` ↔ Canonical EJSON 변환만 한다. 숫자 타입(int32/int64/double/decimal)이 보존돼야 한다.

**작업 예시**

```ts
parseShellValue(`{ _id: ObjectId("65f0a1b2c3d4e5f601234567"), at: { $gt: ISODate("2026-10-01") } }`)
// → {"_id":{"$oid":"65f0…"},"at":{"$gt":{"$date":{"$numberLong":"…"}}}}
```

**완료 조건**
- vitest: 위 표기 각각 왕복(parse → format → parse 결과 동일), 큰 정수 정밀도(NumberLong 9007199254740993), 잘못된 입력의 오류 위치.
- Rust 테스트: EJSON ↔ BSON 왕복에서 int32/int64/double/decimal128/date/oid/binary 타입 보존.

---

### G04. 컬렉션 탭 (Filter / Sort / Projection · 그리드 ↔ JSON) ✅ (단위 테스트 완료 · 서버 검증은 Docker 준비 후)

**작업 내용**
- 커맨드 `mongo_find(conn_id, db, coll, filter, sort, projection, skip, limit) -> { docs: EJSON[], has_more }`(limit+1개 조회), `mongo_count(…)`.
- 탭 UI: Filter / Sort / Projection 입력란(한 줄 에디터, mongosh 표기, Enter로 적용). 헤더 클릭 정렬은 Sort 텍스트에 반영한다.
- 그리드 변환
  - 컬럼: 현재 페이지 문서들의 최상위 필드 합집합. `_id`를 먼저 두고, 나머지는 처음 등장한 순서대로.
  - 셀: `formatShell` 한 줄. 없는 필드는 `<없음>`으로 표시해 null과 구분한다.
- "JSON 보기" 전환: 문서마다 들여쓴 JSON(읽기 전용 CodeMirror, 접기 가능).
- 페이지·페이지 크기·전체 수(`countDocuments`)·복사는 기존 그리드 기능을 그대로 쓴다.

**완료 조건**
- 단위 테스트: 문서 → 컬럼 합집합·셀 변환(누락 필드, 중첩, 배열).
- 서버 검증(Docker 후): 필터·정렬·프로젝션, 페이지 이동, 10만 문서 컬렉션에서 첫 페이지 표시 시간.

---

### G05. MongoDB 콘솔 (mongosh 문법 일부) ✅ (단위 테스트 완료 · 서버 검증은 Docker 준비 후)

**작업 내용**
- `src/mongo/console.ts`의 `parseMongoCommand(text) -> MongoOp`이 지원하는 문법:
  - `db.<coll>.find(f?, p?)` + 체인 `.sort() .skip() .limit() .projection()`
  - `aggregate([...])`, `countDocuments(f?)`, `estimatedDocumentCount()`, `distinct(field, f?)`
  - `insertOne/insertMany/updateOne/updateMany/replaceOne/deleteOne/deleteMany(...)`
  - `db.runCommand({...})`, `db.getCollection("이름").…`, `show dbs`, `show collections`, `use <db>`
  - 그 밖(변수, 함수, `for`)은 "지원하지 않는 문법" 오류와 위치를 보여 준다.
- 문장 구분: 세미콜론 또는 줄바꿈으로 끝난 완결 표현식. 커서 위치 문장 실행은 기존 방식과 같다.
- 커맨드 `mongo_exec(conn_id, console_id, db, op)`
  - find/aggregate 결과는 컬렉션 탭과 같은 그리드로 보여 준다.
  - 쓰기 결과는 `matched/modified/inserted/deleted` 수로 보여 준다.
  - 필터가 빈 `updateMany`/`deleteMany`는 실행 전에 확인한다.
- 중지: 작업 future를 취소하고 서버 커서를 닫는다.

**완료 조건**
- vitest: 위 문법 각각의 파싱 결과, 체인 순서 무관, 문자열 안의 괄호·세미콜론, 지원하지 않는 문법 오류.
- 서버 검증(Docker 후): find/aggregate/insert/update/delete/runCommand 실행과 읽기 전용 거부.

---

### G06. MongoDB 편집 · Submit 미리보기 ✅ (단위 테스트 완료 · 서버 검증은 Docker 준비 후)

**작업 내용**
- 셀 편집: 최상위 필드만. 입력은 `parseShellValue`로 해석한다. 원래 값이 문자열이면 따옴표 없이 쓴 입력도 문자열로 보아 원래 BSON 타입을 유지한다. 필드 삭제는 셀 메뉴 "필드 삭제"(`$unset`).
- 문서 JSON 편집: 행 메뉴 "문서 편집…" → mongosh 표기 편집기 → 보류 변경(replace)으로 등록한다.
- 보류 변경 → 작업 목록
  - 수정: `updateOne({_id, <바꾼 필드>: <원래 값>…}, {$set: {...}, $unset: {...}})`
  - 문서 교체: `replaceOne(<원본 문서 전체>, <새 문서>)`
  - 추가 `insertOne(doc)`, 삭제 `deleteOne({_id, …})`
- 미리보기 모달에 mongosh 표기로 보여 주고 고칠 수 있다(고치면 `parseMongoCommand`로 다시 해석).
- 반영
  - 레플리카셋·sharded: 세션 트랜잭션(`start_transaction` → 작업 → `commit`, 실패 시 abort).
  - standalone: "롤백 불가" 경고 후 차례로 실행하고, 첫 실패에서 멈춘 뒤 성공한 수를 알린다.
  - update/delete/replace는 각각 `matched == 1`이어야 한다.
- `_id`가 없는 결과는 편집 불가 사유를 툴바에 표시한다.

**완료 조건**
- 단위 테스트: 보류 변경 → 작업 목록(필드 추가/수정/삭제, 원래 값 조건, ObjectId·Date 타입 유지).
- 서버 검증(Docker 후): replicaset에서 중간 실패 시 전체 롤백, standalone에서 부분 반영 안내, 다른 곳에서 바뀐 문서는 matched 0으로 실패.

---

### G07. MongoDB 내보내기 · 복사 ✅ (단위 테스트 완료 · 서버 검증은 Docker 준비 후)

**작업 내용**
- 커맨드 `mongo_export(conn_id, op, file_name)`: 백엔드 저장 대화상자 → `.jsonl.part`에 문서당 한 줄 Canonical EJSON을 스트리밍 → 성공하면 rename. 진행 이벤트와 취소는 CSV 내보내기와 같다.
- 툴바: Mongo 결과에서는 CSV 버튼 대신 "⭳ JSON Lines 내보내기". 복사 메뉴는 TSV(셀 표기 그대로)와 JSON(mongosh 표기 배열).

**완료 조건**
- Rust 테스트: 줄 단위 출력, 취소 시 기존 파일 보존.
- 서버 검증(Docker 후): 100만 문서 내보내기에서 메모리 증가 50MB 이하, `mongoimport`로 다시 넣어 개수 일치.

---

### N02. 측정 · 문서 ✅ (서버 접속 중 측정은 Docker 준비 후)

**작업 내용**
- 릴리스 빌드에서 exe·설치 파일 크기, 유휴 메모리(Redis·Mongo 접속 전/후), 콜드 스타트를 다시 잰다.
- DESIGN.md 측정 표와 접속 예시(URI) 갱신.

**완료 조건**
- 설치 파일 15MB 이하, 유휴 메모리 150MB 이하, 콜드 스타트 1.5초 이하 유지.

---

## M5 — 스키마 편집 (설계: DESIGN.md "스키마 편집")

순서: S1 → S2 → S3 → S4. 각 단계에서 PG · MySQL · SQLite를 모두 마친다. SQLite는 인메모리 실행 테스트로, PG/MySQL은 생성 SQL 스냅샷 테스트로 완료를 판단한다. 실제 서버 검증은 Docker 준비 후 하며, 그때까지는 "서버 검증은 Docker 준비 후"로 표시한다.

### S1. 구조 메타 확장 · 구조 탭 · 컬럼 편집 ✅ (SQLite 검증 완료 · PG/MySQL은 SQL 스냅샷만, 서버 검증은 Docker 준비 후 · 실제 앱에서 SQLite로 화면·적용·데이터 탭 갱신 확인. 구현 메모: 미리보기는 SubmitPreview와 같은 방식의 별도 `DdlPreview`, `preview_ddl`은 안내(notes)를 함께 돌려주고 DB의 현재 구조와 `original`이 다르면 거부, `apply_ddl`은 문장 문자열 목록을 받음. "새 테이블" 메뉴는 S3, 제약·옵션 섹션은 S2·S4에서 추가. SQLite 재생성은 COLLATE·ON CONFLICT·생성 컬럼·DEFERRABLE이 있는 테이블은 거부(CHECK는 S2부터 파싱해 보존))

**작업 내용**
- 메타 확장 커맨드 `table_structure(conn_id, schema, table) -> TableStructure`. 기존 `list_columns`는 그대로 둔다.
  - `TableStructure { columns: Vec<ColumnDef>, indexes, foreign_keys, checks, options }`. S1에서는 `columns`만 채운다.
  - `ColumnDef { name, full_type, nullable, default: Option<String>, auto_increment, comment, charset, collation, ordinal }`
  - PG
    - 기본값: `pg_get_expr(adbin, adrelid)`
    - IDENTITY: `attidentity`, `serial`(nextval 기본값)도 자동 증가로 본다.
    - 코멘트: `col_description`
    - COLLATE: `attcollation`
  - MySQL: `information_schema.COLUMNS`의 `COLUMN_DEFAULT`, `EXTRA`, `COLUMN_COMMENT`, `CHARACTER_SET_NAME`, `COLLATION_NAME`
  - SQLite
    - `pragma_table_xinfo`의 `dflt_value`
    - `AUTOINCREMENT` 여부: `sqlite_master.sql`을 보고 판단한다.
- 프론트
  - 트리 메뉴: 테이블에 "구조 편집"(뷰는 비활성), 스키마에 "새 테이블"(S3에서 활성).
  - 탭 종류 `structure`. 섹션은 컬럼 / 인덱스 / 제약 / 옵션이며, S1에서는 컬럼만 편집할 수 있고 나머지는 보기만 한다.
  - 상태: `{ original: TableStructure, draft: TableStructure }`. 컬럼의 이름 변경과 수정을 구분하려고 컬럼마다 안정 키 `origName`을 둔다.
  - 행 색 표시(추가/수정/삭제), 행별 되돌리기, 전체 취소. 타입 입력은 `<input list>` + DB별 타입 목록 상수.
  - MySQL만: 컬럼 순서 위/아래 이동.
- 백엔드 `db/ddl.rs`
  - `plan_alter(driver, original, draft) -> Vec<RawStmt>`
  - PG
    - `ADD/DROP/RENAME COLUMN`
    - `ALTER COLUMN … TYPE … USING col::type`
    - `SET/DROP NOT NULL`, `SET/DROP DEFAULT`
    - `ADD/DROP IDENTITY`
  - MySQL
    - 한 테이블의 모든 변경을 `ALTER TABLE t` 한 문장에 묶는다.
    - 절: `ADD COLUMN`, `DROP COLUMN`, `RENAME COLUMN`(MySQL 8 / MariaDB 10.5+), 그 이하는 `CHANGE COLUMN`, `MODIFY COLUMN … [FIRST|AFTER x]`
    - `MODIFY`는 컬럼 전체 정의를 다시 쓰므로 코멘트·문자셋·기본값을 보존한다.
  - SQLite
    - `ADD COLUMN`, `RENAME COLUMN`, `DROP COLUMN`(3.35+)은 바로 쓴다.
    - 그 밖의 변경은 `rebuild_table(original, draft)` 12단계 SQL로 만든다. 인덱스·트리거 원문은 `sqlite_master`에서 가져온다.
  - 각 `RawStmt`에 `destructive: bool` 플래그를 추가한다(DROP, 타입 변경, 재생성). `expect_one`은 false.
- 커맨드
  - `preview_ddl(conn_id, schema, table, original, draft) -> Vec<RawStmt>`
  - `apply_ddl(conn_id, schema, table, statements) -> DdlResult { applied: usize, error: Option<..> }`
    - 실행 연결: 콘솔과 무관한 풀 연결 하나를 사용한다.
    - PG/SQLite: `BEGIN … COMMIT`
    - MySQL: 문장을 차례로 실행하고, 실패하면 `applied` 수와 오류를 반환한다.
    - 읽기 전용 접속은 거부한다.
- `SubmitPreview` 재사용
  - `destructive` 문장을 빨간색으로 강조한다.
  - MySQL에서 문장이 2개 이상이면 "롤백 불가" 경고를 띄운다.
  - SQL을 고치면 고친 SQL을 그대로 `apply_ddl`에 보낸다.
- 적용 전 검사: 같은 `(conn, schema, table)` 데이터 탭에 보류 변경이 있으면 막고 안내한다.
- 적용 후: 구조 다시 읽기, 트리 `refresh`, `schema_snapshot` 갱신, 열린 데이터 탭 `refresh`.

**작업 예시**

```rust
// db/ddl.rs
pub fn plan_alter(d: Driver, t: &QualifiedName, a: &TableStructure, b: &TableStructure) -> AppResult<Vec<RawStmt>> {
    let diff = diff_columns(&a.columns, &b.columns); // Added / Dropped / Renamed / Modified{fields}
    match d {
        Driver::Postgres => Ok(pg::alter_columns(t, &diff)),
        Driver::Mysql => Ok(vec![my::alter_table_one(t, &diff, &b.columns)]),
        Driver::Sqlite if sqlite::alter_only(&diff) => Ok(sqlite::alter_columns(t, &diff)),
        Driver::Sqlite => sqlite::rebuild_table(t, a, b),
    }
}
```

콜스택:
```
StructureTab.onApply
 → guardPendingDataEdits(conn, schema, table)
 → api.previewDdl(...) → invoke("preview_ddl") → db::ddl::plan_alter
 → SubmitPreview(statements, destructive 강조) → 확인
 → api.applyDdl(...) → invoke("apply_ddl") → read_only 검사 → 별도 연결에서 tx/순차 실행
 → reloadStructure · tree.refresh · snapshot.refresh · dataTabs.refresh
```

**완료 조건**
- Rust(SQLite 인메모리)
  - 컬럼 추가·삭제·이름 변경 후 데이터가 보존된다.
  - 타입·NULL·기본값 변경은 재생성으로 처리되며, 재생성 후 행 수, 인덱스, 트리거, FK가 보존되고 `foreign_key_check`가 비어 있다.
  - 중간 실패 시 원래 테이블이 그대로 남는다.
- 스냅샷(PG/MySQL)
  - 위 각 변경의 생성 SQL을 확인한다. 식별자 인용(예약어·공백·따옴표 포함 이름)도 확인한다.
  - MySQL은 여러 변경이 한 문장으로 묶이는지, `MODIFY`가 코멘트·문자셋·기본값을 보존하는지 확인한다.
- vitest: `draft` 변경 판정(추가/수정/삭제/이름 변경), 행 되돌리기, 전체 취소.
- 읽기 전용 접속에서 편집 UI가 꺼지고 `apply_ddl`이 거부된다.
- 데이터 탭에 보류 변경이 있으면 적용이 막힌다.

---

### S2. 인덱스 · 제약 (PK / UNIQUE / FK / CHECK) ✅ (SQLite 검증 완료 · 실제 앱에서 SQLite로 확인 · PG/MySQL은 SQL 스냅샷만, 서버 검증은 Docker 준비 후. 구현 메모: 바뀐 인덱스·제약은 지우고 다시 만든다. 컬럼 이름을 바꾸면 프론트가 기본키·인덱스·외래 키의 컬럼 목록을 함께 바꾸고, 백엔드는 원래 목록을 새 이름으로 옮겨 비교한다. 삭제한 컬럼을 쓰는 항목이 남아 있으면 거부. 식·부분 인덱스는 보존·삭제만. MySQL은 같은 이름의 외래 키를 다시 만들 때만 DROP FOREIGN KEY를 앞 문장으로 나눈다. SQLite CHECK는 CREATE 문을 파싱한다)

**작업 내용**
- `table_structure`에 `indexes`, `foreign_keys`, `checks`를 채운다.
  - PG: `pg_index` + `pg_get_indexdef`, `pg_constraint`(`contype` p/u/f/c, `pg_get_constraintdef`)
  - MySQL: `information_schema.STATISTICS`, `TABLE_CONSTRAINTS`, `KEY_COLUMN_USAGE`, `REFERENTIAL_CONSTRAINTS`, `CHECK_CONSTRAINTS`(8.0.16+ / MariaDB 10.2+). 이 버전 미만이면 CHECK 섹션에 "강제되지 않음" 안내를 띄운다.
  - SQLite: `pragma_index_list` / `pragma_index_info`, `pragma_foreign_key_list`. CHECK는 `sqlite_master.sql`을 파싱한다(기존 SQL 토크나이저 재사용).
- UI
  - 인덱스: 이름, 컬럼 순서 목록, UNIQUE.
  - PK: 컬럼 선택.
  - FK: 컬럼 → 참조 테이블.컬럼, ON DELETE/UPDATE.
  - CHECK: 이름 + 식(자유 입력).
- DDL
  - PG: `CREATE [UNIQUE] INDEX`, `DROP INDEX`, `ADD/DROP CONSTRAINT`. 인덱스 변경은 DROP + CREATE로 한다.
  - MySQL: `ALTER TABLE` 한 문장에 `ADD/DROP INDEX`, `ADD/DROP PRIMARY KEY`, `ADD/DROP FOREIGN KEY`, `ADD/DROP CHECK`(MariaDB는 `DROP CONSTRAINT`)를 묶는다.
  - SQLite
    - 인덱스는 `CREATE/DROP INDEX`로 바로 처리한다.
    - PK, UNIQUE 제약, FK, CHECK 변경은 재생성으로 처리한다.

**완료 조건**
- SQLite 인메모리
  - 인덱스 추가/삭제
  - 재생성으로 FK, CHECK 추가/삭제. FK 위반 데이터가 있으면 롤백되어 원래 상태가 유지된다.
- 스냅샷(PG/MySQL): 복합 인덱스, 복합 PK 교체, FK 액션, CHECK 식 인용.
- 서버 검증(Docker 후): 시드 테이블에서 각 작업을 한다.

---

### S3. 테이블 생성 · 삭제 · 이름 변경 ✅ (SQLite 검증 완료 · 실제 앱에서 SQLite로 생성·이름 변경·삭제 확인 · PG/MySQL은 SQL 스냅샷만, 서버 검증은 Docker 준비 후. 구현 메모: "새 테이블"은 스키마 노드와 tables 폴더 우클릭. 이름 변경은 구조 탭 위쪽 테이블 이름 칸에서 하고, 다른 변경 뒤 마지막 문장으로 붙인다. SQLite는 재생성일 때만 foreign_keys를 끄고 legacy_alter_table을 켠다(이름 변경이 다른 테이블의 외래 키·뷰·트리거까지 고치도록). 삭제는 `preview_drop`으로 만든 SQL을 보여 준다)

**작업 내용**
- "새 테이블"
  - 빈 `original`로 구조 탭을 열고, `CREATE TABLE`을 만든다.
  - 컬럼, PK, UNIQUE, FK, CHECK, 자동 증가는 인라인으로 넣는다. 인덱스는 뒤에 `CREATE INDEX`로 만든다.
  - PG 코멘트는 뒤에 `COMMENT ON`으로 넣는다.
  - 저장하면 탭이 일반 구조 탭으로 바뀐다.
- 이름 변경: 구조 탭 상단의 테이블 이름 입력란.
  - PG `ALTER TABLE … RENAME TO`, MySQL `RENAME TABLE`, SQLite `ALTER TABLE … RENAME TO`.
  - 열린 데이터 탭과 구조 탭의 대상 이름도 바꾼다.
- 삭제: 트리 메뉴 "테이블 삭제…"
  - 미리보기에서 테이블 이름을 그대로 입력해야 실행 버튼이 켜진다.
  - 실행 후 해당 테이블의 탭들을 닫는다(데이터 탭에 보류 변경이 있으면 먼저 막는다).

**완료 조건**
- SQLite 인메모리: 생성, 이름 변경, 삭제가 되고, 생성 결과의 `table_structure`가 폼과 일치한다.
- 스냅샷(PG/MySQL): `CREATE TABLE`(IDENTITY/AUTO_INCREMENT, 복합 PK, FK)을 확인한다.
- vitest: 이름 입력이 일치해야만 실행할 수 있다. 이름을 바꾸면 탭 대상 이름이 갱신된다.

---

### S4. 문자셋 · 정렬규칙 · 코멘트 · 테이블 옵션 ✅ (PG/MySQL은 SQL 스냅샷만 · 옵션 화면은 PG/MySQL 전용이라 앱 화면 확인 전, 서버 검증은 Docker 준비 후. 구현 메모: 선택 목록은 `ddl_choices` 커맨드로 탭마다 한 번 읽어 datalist로 제안하고 자유 입력도 받는다. 문자셋 없이 정렬규칙만 바꾸면 거부. 옵션 변경은 MySQL ALTER 한 문장 끝에 붙인다)

**작업 내용**
- 조회
  - MySQL: `information_schema.TABLES`(`ENGINE`, `TABLE_COLLATION`, `ROW_FORMAT`, `TABLE_COMMENT`)
  - 선택 목록: `SHOW CHARACTER SET` / `SHOW COLLATION`, `SHOW ENGINES`(목록은 접속당 캐시)
  - PG: `obj_description`(테이블 코멘트), `pg_collation`
- UI
  - 옵션 섹션
    - MySQL: 엔진, 문자셋/정렬규칙("기존 데이터 변환" / "기본값만" 라디오), ROW_FORMAT, 테이블 코멘트
    - PG: 테이블 코멘트
  - 컬럼 행
    - 코멘트(PG/MySQL)
    - 문자셋/정렬규칙: MySQL은 문자열 타입만, PG는 COLLATE만
  - SQLite에서는 해당 입력란을 숨긴다.
- DDL
  - MySQL
    - `ALTER TABLE t ENGINE=…, ROW_FORMAT=…, COMMENT='…'`
    - `CONVERT TO CHARACTER SET … COLLATE …` 또는 `DEFAULT CHARACTER SET …`
    - 컬럼은 `MODIFY … CHARACTER SET … COLLATE …`
    - `CONVERT TO`와 엔진 변경은 `destructive`로 표시한다(테이블 전체를 다시 쓰고 잠근다).
  - PG
    - `COMMENT ON TABLE/COLUMN`
    - `ALTER COLUMN … TYPE <같은 타입> COLLATE "x"`

**완료 조건**
- 스냅샷(MySQL)
  - `CONVERT TO`와 `DEFAULT CHARACTER SET`이 구분된다.
  - 코멘트 문자열이 이스케이프된다(따옴표, 백슬래시).
  - 다른 변경과 함께 한 문장으로 묶인다.
- 스냅샷(PG): `COMMENT ON` 인용, `COLLATE`가 포함된 타입 변경.
- 서버 검증(Docker 후): utf8mb3 → utf8mb4 변환 후 한글 데이터가 보존된다.
