# data-connector 설계

JetBrains 데이터 그리드와 비슷한 UI에서 핵심 기능만 갖춘 개인용 데스크톱 DB 접속 툴.

## 전제

- **되도록 가볍게.** 기능과 라이브러리를 고를 때는 번들 크기, 메모리, 구현 범위가 작은 쪽을 기본으로 한다.
- 사용자는 나 혼자다. 팀 배포, 인증, 공유 기능은 범위 밖이다.

## 기술 스택

| 영역 | 선택 | 이유 |
|---|---|---|
| 앱 셸 | Tauri 2 | 작은 바이너리, 시스템 WebView2 사용 |
| 백엔드 | Rust + sqlx | PG/MySQL/SQLite를 한 API로 다룸, SSL 기본 지원 |
| 프론트엔드 | React + TypeScript | Glide Data Grid가 React에 의존 |
| 데이터 그리드 | Glide Data Grid | Canvas 렌더링, 셀 편집·범위 선택·복사/붙여넣기 내장, MIT |
| SQL 에디터 | CodeMirror 6 (`@codemirror/lang-sql`) | Monaco보다 훨씬 가벼움(약 150~300KB) |
| 비밀번호 저장 | Rust `keyring` 크레이트 → Windows 자격 증명 관리자 | 설정 파일에는 비밀번호를 두지 않음 |

## 지원 DB

- PostgreSQL
- MySQL / MariaDB
- SQLite
- Redis (단일 서버) — 아래 "Redis" 절
- MongoDB — 아래 "MongoDB" 절

Oracle과 MSSQL은 범위 밖이다.

## 화면 구성 (JetBrains식)

```
┌──────────────┬──────────────────────────────────────┐
│ 스키마 트리   │ [콘솔: prod-pg] [users] [orders] ... │  ← 탭(콘솔 / 테이블 뷰)
│ 접속          │ ┌──────────────────────────────────┐ │
│  └ DB         │ │ SQL 에디터 (CodeMirror)           │ │
│    └ 스키마   │ └──────────────────────────────────┘ │
│      └ 테이블 │ [결과 1] [결과 2]                     │  ← 문장별 결과 탭
│        └ 컬럼 │ ┌──────────────────────────────────┐ │
│               │ │ 데이터 그리드 (Glide)             │ │
│               │ └──────────────────────────────────┘ │
└──────────────┴──────────────────────────────────────┘
```

- 트리에서 테이블을 더블클릭하면 테이블 뷰 탭이 열린다.
- 테이블 아래에 `columns`와 `indexes` 폴더를 둔다. 인덱스 행에 마우스를 올리면 종류(PK/UNIQUE)와 컬럼 목록을 툴팁으로 보여 준다.
- 사이드바 접속과 접속 대화상자의 드라이버 드롭다운에 글자 크기의 공식 DB 로고(devicon SVG, 출처는 `src/assets/logos/NOTICE.md`)를 표시한다.
- 테마는 OS 설정(`prefers-color-scheme`)에 따라 다크/라이트로 바뀐다. 테마 객체는 Glide용과 CodeMirror용으로 각각 2개씩 둔다.

## 접속과 연결

- 접속 설정: 호스트, 포트, DB, 사용자, SSL/TLS 옵션, 읽기 전용 여부, 표시 색상. SQLite는 파일 경로.
- **연결 모델:** 접속마다 작은 풀(1~2개 연결)을 두고 탭들이 공유한다. Manual 트랜잭션 모드로 바꾼 콘솔만 전용 연결을 붙잡고, 커밋/롤백하거나 Auto로 돌아오면 반납한다.
- **읽기 전용 모드:** SQL 파싱 없이 DB 세션 레벨에서 막는다.
  - PostgreSQL: `SET default_transaction_read_only = on`
  - MySQL: `SET SESSION TRANSACTION READ ONLY`
  - SQLite: `mode=ro`로 열기
  - 그리드 편집 UI를 비활성화하고, 접속별 색상으로 탭과 트리를 표시한다.
  - **실수 방지용이며 보안 경계가 아니다.** PG/MySQL은 세션 설정을 SQL로 되돌릴 수 있으므로, 읽기 전용 접속에서는 `READ WRITE`·`*_read_only`가 들어간 문장을 백엔드가 거부한다. 확실한 보호가 필요하면 DB에서 SELECT 권한만 있는 계정을 쓴다.
  - 접속 설정을 바꾸면 연결 중인 세션을 새 설정으로 다시 연결한다 (미커밋 트랜잭션·보류 변경이 있으면 먼저 묻는다).

## SQL 에디터

- 문법 하이라이트와 방언(PG/MySQL/SQLite) 지원.
- 실행 취소 `Ctrl+Z`, 다시 실행 `Ctrl+Shift+Z` / `Ctrl+Y`.
- 스키마 메타데이터를 바탕으로 테이블/컬럼 이름을 자동완성한다. 별칭 해석이나 JOIN 제안 같은 완전한 인텔리센스는 범위 밖이다.
- **실행:** `Ctrl+Enter`는 커서가 있는 문장, 또는 선택 영역이 있으면 선택 영역을 실행한다. 선택 영역에 문장이 여러 개면 차례로 실행하고 문장마다 결과 탭을 만든다.
- **트랜잭션:** 기본은 Auto-commit이다. 툴바에서 Manual로 바꾸면 Commit/Rollback 버튼이 활성화된다.
- **안전장치:** WHERE 없는 `UPDATE`/`DELETE`는 실행 전에 확인 대화상자를 띄운다.
- **취소:** 실행 중에는 경과 시간과 중지 버튼을 보여 준다. 중지하면 서버 쪽에서도 쿼리를 멈춘다.
  - PostgreSQL: `pg_cancel_backend(pid)`
  - MySQL: `KILL QUERY <id>`
  - SQLite: interrupt
  - 기본 타임아웃은 두지 않는다.

## 결과 그리드

- **페이지 조회:** 기본 500행씩 가져온다. 이전/다음 페이지 버튼과 전체 행 수 조회 버튼(`COUNT(*)`)을 둔다. 행 범위 표시를 누르면 페이지 크기(100/200/500/1,000/5,000/10,000/직접 입력, 최대 100,000)를 고른다. 이 PC에 저장된다.
- 단일 테이블 결과는 기본키 컬럼 헤더에 열쇠 아이콘을 표시한다.
- 결과 위 툴바: 새로고침(데이터를 바꾸는 문장 결과에서는 비활성화), 행 추가, 행 삭제, 복사(TSV/JSON/INSERT), CSV 내보내기, 되돌리기, Submit.
- **필터/정렬(테이블 뷰):** 그리드 위에 `WHERE` / `ORDER BY` 입력란을 두고, 입력한 조건으로 서버에 다시 쿼리한다. 헤더를 클릭하면 `ORDER BY`가 바뀐다.

## 그리드 편집

- **편집 가능 조건:** 단일 테이블 결과만 편집할 수 있다(테이블 뷰, 또는 `SELECT ... FROM <한 테이블>`). JOIN, 뷰, 계산식이 섞인 결과는 읽기 전용이다.
- **반영 방식:** 변경 사항을 모아 두었다가 Submit할 때 반영한다.
  - 수정한 셀, 추가한 행, 삭제한 행을 색으로 표시한다.
  - Submit(`Ctrl+Enter`)하면 먼저 실제로 나갈 SQL을 값이 들어간 형태로 미리보기 모달에 보여 준다. 모달에서 SQL(값 포함)을 고칠 수 있다. 고치지 않으면 바인딩 파라미터로, 고쳤으면 고친 SQL 그대로 **하나의 트랜잭션**으로 반영한다. 트랜잭션 제어문은 넣을 수 없다.
  - Revert로 보류 중인 변경을 버릴 수 있다.
  - `Ctrl+Z` / `Ctrl+Shift+Z`(또는 `Ctrl+Y`)로 보류 변경을 한 동작씩 실행 취소·다시 실행한다. 붙여넣기 한 번은 한 단계다. Submit하거나 다시 조회하면 기록이 사라진다.
- **행 식별:**
  - PK, 또는 UNIQUE NOT NULL 컬럼이 있으면 그 컬럼을 쓴다.
  - 없으면 **모든 컬럼의 기존 값**으로 `WHERE`를 만든다. NULL은 `IS NULL`로 비교한다.
  - 문장 하나의 영향 행 수가 1이 아니면(0 또는 2 이상) **Submit 트랜잭션 전체를 롤백**하고 문제 행을 표시한다.
- **값 편집(타입별 에디터, 브라우저 기본 입력 사용):**
  - NULL: 단축키로 지정한다.
  - 날짜/시간: `<input type="date">`, `<input type="datetime-local">`
  - 열거형(PG enum, MySQL ENUM): `<select>`
  - JSON: 팝업에서 `JSON.parse` / `JSON.stringify`로 포맷하고 검증한다.
  - 긴 텍스트: 크게 보기 팝업.
  - BLOB: 크기를 표시하고, Tauri 파일 대화상자로 파일에서 불러오기/파일로 저장한다.
  - 그 밖의 타입: 텍스트로 입력하고 파싱은 DB에 맡긴다.

## 내보내기와 복사

외부 라이브러리 없이 구현한다.

- TSV 클립보드 복사(선택 영역 `Ctrl+C`, 엑셀에 붙여넣기 가능)
- CSV 파일: 쿼리 전체 결과를 Rust에서 파일로 스트리밍한다.
- JSON: 행 배열.
- SQL INSERT문: 선택한 행을 INSERT 구문으로.

## 보안

- 파일을 읽고 쓰는 명령(BLOB 저장·불러오기, CSV 내보내기)은 웹뷰에서 경로를 받지 않는다. 백엔드가 파일 대화상자를 직접 열고, 사용자가 고른 경로만 쓴다.
- CSV는 임시 파일(`.csv.part`)에 쓴 뒤 성공했을 때만 이름을 바꾼다. 실패하거나 취소해도 기존 파일은 그대로 남는다.
- CSV 내보내기는 쿼리를 다시 실행한다. 따라서 데이터를 바꾸는 문장(`DML ... RETURNING`, 데이터 변경 CTE)에서는 막고, 이런 문장은 페이지 조회도 하지 않는다.
- 릴리스 빌드는 CSP를 적용한다(`default-src 'self' ipc:`, 인라인 스크립트 금지).
- 비밀번호를 비운 채 연결 테스트를 하면 저장된 비밀번호를 쓴다. 이때 호스트·포트·사용자가 저장된 설정과 다르면 저장된 비밀번호를 보내지 않는다.
- 원격 서버에 인증서를 검증하지 않는 SSL 모드(disable/prefer/require)로 접속하려 하면 대화상자에서 경고한다.

## 저장

- 앱 데이터 폴더에 저장한다.
  - 접속 목록(비밀번호 제외)
  - 접속별 콘솔 내용(자동 저장, 재시작하면 복원)
- 실행 이력은 남기지 않는다.

## 개발 환경 (Windows)

- `winget install jdx.mise`
- 프로젝트의 `mise.toml`에 `node`(LTS)와 `rust`(stable)를 고정한다.
- `winget`으로 VS Build Tools를 C++ 워크로드만 설치한다(MSVC 링커용).
- WebView2는 이미 설치돼 있다.

## 마일스톤

1. **M1 — 읽기:** 접속 관리(키체인, SSL), 스키마 트리, 쿼리 콘솔(CodeMirror, 자동완성, 커서 문장 실행, 중지), 결과 그리드(페이지 조회), 콘솔 자동 저장, 테마.
2. **M2 — 편집:** 그리드 편집, 보류 표시, Submit/Revert, 행 식별(PK / 모든 컬럼 매칭 + 롤백), Manual 트랜잭션 모드, WHERE 없는 UPDATE/DELETE 경고.
3. **M3 — 마무리:** WHERE/ORDER BY 필터와 헤더 정렬, 내보내기(TSV/CSV/JSON/INSERT), 타입별 에디터, 읽기 전용 접속 모드.
4. **M4 — Redis · MongoDB:** 아래 "Redis · MongoDB" 절.
5. **M5 — 스키마 편집:** 아래 "스키마 편집" 절. S1 컬럼 → S2 인덱스·제약 → S3 테이블 생성/삭제/이름 → S4 문자셋·코멘트·옵션.

## 범위 밖

Oracle/MSSQL, SSH 터널, 팀 공유/인증, 실행 이력, 완전한 SQL 인텔리센스, JOIN 결과 편집, 무한 스크롤 스트리밍, 쿼리 기본 타임아웃, Redis Sentinel/Cluster, Redis stream 편집 UI, mongosh 스크립트(변수·함수·반복문), MongoDB CSV 내보내기.

## Redis · MongoDB (2026-10-18 합의, 순서: Redis → MongoDB)

### 공통

- **드라이버:** Redis는 `redis` 1.x(`tokio-native-tls-comp`, 기존 schannel TLS 재사용), MongoDB는 공식 `mongodb` 3.x(기본 기능, rustls + SRV DNS 포함). 둘 다 기본 빌드에 넣는다.
  - 실측(같은 릴리스 프로필, 단독 프로브): redis +0.2MB, mongodb +3.1MB. 실제 앱은 exe 5.65MB → 10.58MB, 설치 파일 2.32 → 3.83MiB(아래 측정 결과). 클린 빌드 시간 약 2배.
  - Mongo 드라이버는 자체 TLS(rustls + ring, 내장 루트 인증서)를 쓴다. Windows 인증서 저장소를 쓰지 않으므로 사내 CA는 접속 설정의 CA 파일로 지정한다.
- **화면 구조는 그대로 쓴다:** 접속 ▸ 트리 ▸ 탭(콘솔 / 객체 뷰) ▸ 결과 그리드. 백엔드는 `db/redis.rs`, `db/mongo.rs`와 각 커맨드 모듈로 나누고, 연결 상태(`Connected`)는 드라이버별 클라이언트를 담는 열거형으로 넓힌다.
- **읽기 전용:** 백엔드가 쓰기 명령·작업을 거부한다(실수 방지용, 보안 경계 아님). 편집 UI도 끈다.
  - Redis: 접속 시 `COMMAND INFO`로 `write` 플래그 명령 목록을 받아 캐시하고, 콘솔·편집 명령을 검사한다.
  - MongoDB: insert/update/delete/replace/findAndModify/drop/create/createIndexes/dropIndexes/`$out`·`$merge` 파이프라인 등 쓰기 작업을 거부한다.
- **편집 반영:** SQL과 같이 변경을 모았다가 Submit하면 실제 명령 미리보기 모달을 띄우고, 모달에서 반영한다. 실행 취소(Ctrl+Z / Ctrl+Shift+Z)도 같은 방식이다.
- **검증:** Docker(WSL2) 준비 후 compose에 redis·mongo를 추가해 검증한다. 그전에는 순수 로직(파서, 명령 생성, 변환) 단위 테스트만 한다.

### Redis

- **접속:** 단일 서버만. host / port / ACL 사용자(선택) / 비밀번호(키체인) / 기본 DB 번호 / TLS. Sentinel·Cluster는 범위 밖.
- **트리:** `INFO keyspace`로 키가 있는 DB만 노드로 보인다(예: `db0 (1,204)`). DB 아래는 키 이름을 구분자(기본 `:`, 접속 설정에서 변경)로 나눈 폴더 트리다.
  - `SCAN`으로 처음 500개를 받고 "더 불러오기"로 다음 500개를 받는다. 패턴 필터는 서버의 `MATCH`로 보낸다. 트리는 지금까지 받은 키로만 만든다.
- **키 탭:** 키를 열면 탭 하나. 상단에 타입·TTL·크기(`MEMORY USAGE`), 아래에 값.
  - string: 텍스트/JSON 편집기(JSON이면 포맷), 바이너리는 크기와 hex.
  - hash(field, value) · list(index, value) · set(member) · zset(member, score): 기존 결과 그리드. 큰 컬렉션은 `HSCAN`/`SSCAN`/`ZSCAN`/`LRANGE`로 페이지 크기만큼 나눠 읽는다.
  - stream: 항목 목록 보기만(`XRANGE`). 추가·삭제는 콘솔로.
  - 모듈 타입(ReJSON 등): 타입 이름만 보이고 콘솔로 다룬다.
  - TTL 변경(`EXPIRE`/`PERSIST`), 키 이름 변경(`RENAME`), 키 삭제, 새 키 만들기.
- **편집 반영:** 보류 변경을 `HSET`/`HDEL`/`LSET`/`SADD`/`SREM`/`ZADD`/`ZREM`/`SET` 등 명령으로 만들어 미리보기에 보여 준다. 키를 읽은 뒤 다른 곳에서 바뀌었으면 반영하지 않도록 `WATCH key` + `MULTI`/`EXEC`로 보낸다(EXEC가 nil이면 "다른 곳에서 바뀜, 다시 읽기" 안내). Redis는 실패해도 롤백이 없다는 점을 미리보기에 표시한다.
- **콘솔:** 기존 콘솔처럼 에디터에 명령을 적고 `Ctrl+Enter`로 커서 줄(또는 선택한 여러 줄)을 실행한다. 인자는 redis-cli 규칙(따옴표·이스케이프)으로 나눈다. 결과는 redis-cli 형식 텍스트로 보이고, 배열 결과는 그리드로도 볼 수 있다. 명령 이름 자동완성. 중지는 연결을 끊는 방식으로 한다(`BLPOP` 등 대기 명령 대비).

### MongoDB

- **접속:** 연결 문자열(`mongodb://` / `mongodb+srv://`) + 비밀번호 칸. 비밀번호는 키체인에 두고, URI에 비밀번호가 들어 있으면 저장 전에 떼어 낸다. 레플리카셋·Atlas 옵션은 모두 URI로 받는다.
- **트리:** DB ▸ `collections` / `views` ▸ 컬렉션 ▸ `indexes`(키·unique·TTL 툴팁). 컬렉션 옆에 추정 문서 수(`estimatedDocumentCount`). 필드 목록은 보이지 않는다(스키마 없음).
- **값 표기:** mongosh 표기를 쓴다. `ObjectId("…")`, `ISODate("…")`, `NumberLong("…")`, `NumberDecimal("…")`, `BinData(…)`. 백엔드는 Canonical Extended JSON으로 주고받고, 프론트가 표기를 바꾼다(입력도 같은 표기를 받아 Extended JSON으로 바꿔 보낸다).
- **컬렉션 탭:** 테이블 뷰처럼 Filter / Sort / Projection 입력란(키 따옴표 생략, mongosh 표기 허용). 헤더 클릭 정렬은 Sort에 반영한다.
  - 결과는 그리드가 기본이다. 컬럼은 현재 페이지 문서들의 최상위 필드 합집합이고, 중첩 객체·배열은 JSON 텍스트 셀이다. 버튼으로 문서별 JSON 보기로 전환한다.
  - 페이지는 기존과 같이 `skip`/`limit`(페이지 크기 공유), 전체 수는 `countDocuments`.
- **콘솔:** mongosh 문법 일부를 파서로 해석한다(JS 엔진 없음). `db.<coll>.find(f, p).sort(s).skip(n).limit(n)`, `aggregate([...])`, `countDocuments`, `distinct`, `insertOne/Many`, `updateOne/Many`, `deleteOne/Many`, `replaceOne`, `db.runCommand({...})`, `show dbs/collections`, `use <db>`. 변수·함수·반복문은 지원하지 않는다고 오류로 알린다. 쓰기 명령도 `UPDATE`/`DELETE`처럼 필터가 비어 있으면 경고한다.
- **편집:** 그리드 셀 편집(최상위 필드, 원래 BSON 타입 유지) + 문서 JSON 편집(중첩 필드). 행 추가는 새 문서, 행 삭제는 `deleteOne`.
  - Submit 미리보기에 `updateOne({_id, <바꾼 필드>: <원래 값>}, {$set/$unset})` / `insertOne` / `deleteOne({_id, …})`을 보여 준다. 일치 문서가 1개가 아니면 실패로 본다(SQL의 영향 행 1개 규칙). 문서 전체 JSON 편집은 원본 문서 전체를 조건으로 `replaceOne`.
  - 레플리카셋·Atlas면 세션 트랜잭션으로 묶어 실패 시 모두 롤백한다. standalone이면 미리보기에 "롤백 불가" 경고를 띄우고 차례로 실행하다 첫 실패에서 멈추고 어디까지 반영됐는지 보여 준다.
  - `_id`가 없는 결과(aggregate, 프로젝션으로 `_id` 제외)는 읽기 전용이다.
- **내보내기:** 쿼리 전체 결과를 JSON Lines(문서당 한 줄, Canonical Extended JSON, `mongoimport` 호환) 파일로 스트리밍한다. 복사는 기존처럼 TSV/JSON. CSV는 지원하지 않는다.

## 스키마 편집 (2026-10-18 합의)

행 데이터 편집(M2)은 이미 있다. 여기서는 테이블 구조(DDL)를 폼으로 바꾸는 기능을 다룬다.

- **대상:** PostgreSQL · MySQL/MariaDB · SQLite의 테이블. 뷰, Redis, MongoDB는 범위 밖이다(뷰는 트리 메뉴에서 비활성).
- **지원 작업**
  - 테이블: 생성 / 삭제 / 이름 변경.
  - 컬럼: 추가 / 삭제 / 이름 변경 / 타입 / NULL 허용 / 기본값 / 자동 증가(MySQL `AUTO_INCREMENT`, PG `IDENTITY`, SQLite `INTEGER PRIMARY KEY AUTOINCREMENT`).
  - 컬럼 순서: MySQL만(`FIRST` / `AFTER`). PG는 재생성 말고는 방법이 없어 제외하고, SQLite는 어차피 재생성하므로 지원한다.
  - 인덱스(일반/UNIQUE), PK, UNIQUE, FK(ON DELETE/UPDATE), CHECK. MySQL 8.0.16 미만과 MariaDB 10.2 미만에서는 CHECK가 강제되지 않는다는 안내를 띄운다.
  - 코멘트: 테이블·컬럼(PG `COMMENT ON`, MySQL `COMMENT`). SQLite는 지원하지 않는다.
  - 문자셋: MySQL은 테이블·컬럼 `CHARACTER SET`/`COLLATE`를 바꿀 수 있다. 테이블은 "기존 데이터 변환(`CONVERT TO`)"과 "기본값만 변경(`DEFAULT CHARACTER SET`)" 중에서 고른다. PG는 인코딩이 DB 단위이므로 컬럼 `COLLATE`만 바꾼다. SQLite는 해당 없음.
  - 테이블 옵션: MySQL `ENGINE`, `ROW_FORMAT` 등.
- **SQLite 재생성:** `ALTER`로 안 되는 변경(타입, NULL, 기본값, 제약, 순서)은 SQLite 공식 12단계 절차로 처리한다.
  - 순서: `foreign_keys` 끄기 → 트랜잭션 → 새 테이블 생성 → `INSERT … SELECT` → 기존 테이블 삭제 → 이름 변경 → 인덱스·트리거 재생성 → `foreign_key_check` → 커밋 → `foreign_keys` 복원.
  - 미리보기에는 이 전체 SQL을 보여 준다.
- **화면:** 테이블 우클릭 "구조 편집", 스키마 우클릭 "새 테이블"로 별도 **구조 탭**을 연다.
  - 섹션은 컬럼 / 인덱스 / 제약 / 옵션 네 개다.
  - 타입은 자유 텍스트로 입력하고, DB별 흔한 타입을 `datalist`로 제안한다.
  - 바뀐 항목은 데이터 편집처럼 추가·수정·삭제 색으로 표시하고, 항목별 되돌리기와 전체 취소를 둔다. undo 스택은 두지 않는다.
- **반영 흐름:** Rust가 폼 상태(변경 전/후 구조)로 DDL을 만든다. 기존 `SubmitPreview` 모달에서 사용자가 SQL을 고칠 수 있다. 실행 후에는 폼과 실제 실행이 다를 수 있으므로 구조를 DB에서 다시 읽는다.
  - 실행은 항상 별도 자동 커밋 연결에서 한다. 콘솔의 Manual 트랜잭션과는 무관하다(MySQL 암묵 커밋이 콘솔 트랜잭션을 깨는 사고를 막기 위해서).
  - PG · SQLite: `BEGIN … COMMIT`으로 묶고, 실패하면 모두 롤백한다.
  - MySQL: DDL은 암묵 커밋이라 되돌릴 수 없다. 한 테이블 변경은 가능한 한 `ALTER TABLE` 한 문장에 여러 절로 묶는다. 여러 문장이 필요하면 미리보기에 "롤백 불가" 경고를 띄우고, 실패하면 어디까지 반영됐는지 보여 준다.
- **안전**
  - 읽기 전용 접속에서는 구조 탭이 보기 전용이고, 백엔드도 거부한다.
  - 미리보기에서 파괴적 문장(컬럼·테이블·인덱스 삭제, 타입 변경, SQLite 재생성)을 빨간색으로 강조한다. `DROP TABLE`은 테이블 이름을 직접 입력해야 실행된다.
  - 같은 테이블의 데이터 탭에 미제출 변경이 있으면 적용을 막고 "먼저 제출/취소" 안내를 한다.
  - 적용 후에는 트리, 자동완성 스냅샷, 열린 데이터 탭을 새로 고친다.
- **메타데이터 확장:** 기본값, 자동 증가, 컬럼 코멘트·문자셋·정렬규칙, FK, CHECK, 테이블 코멘트·엔진·문자셋 조회를 추가한다.
- **검증:** SQLite는 인메모리 DB로 실행 테스트를 한다(재생성 후 데이터·인덱스·FK 보존 포함). PG/MySQL은 생성 SQL 스냅샷 테스트를 하고, Docker 준비 후 수동 검증한다.

## 측정 결과 (T24, 2026-10-18, Windows 10 · 릴리스 빌드)

| 항목 | 목표 | 결과 | 비고 |
|---|---|---|---|
| NSIS 설치 파일 | 15MB 이하 | **2.32MiB** | |
| 단독 exe | — | 5.65MB | `opt-level="s"`, LTO, strip |
| 유휴 메모리 (WebView2 포함, private) | 150MB 이하 | **약 111MB** (빈 작업 공간) / 약 127MB (탭 5개 복원) | `--disable-gpu` 적용 후. 적용 전에는 약 168MB / 201MB |
| 콜드 스타트 (실행 → 화면 렌더 완료) | 1.5초 이하 | **약 0.47~0.5초** | |
| 프론트 JS 번들 (gzip) | 1MB 이하 | **276KB** (+ 지연 로드 청크 8KB) | React 18 + Glide + CodeMirror 6 포함. 쓰지 않는 Glide 의존성(marked, carousel)을 빈 구현으로 바꿔 296KB에서 줄임 |
| 500행 × 50컬럼 스크롤 | 60fps 근접 | 평균 16.5ms, p95 16.7ms | GPU를 꺼도 같은 결과 |
| 100만 행 CSV 내보내기 | 메모리 증가 50MB 이하 | 앱 프로세스 +2.5MB | 스트리밍 |

### Redis·MongoDB 추가 후 (N02, 2026-10-18, 같은 조건)

| 항목 | 목표 | 결과 | T24 대비 |
|---|---|---|---|
| NSIS 설치 파일 | 15MB 이하 | **3.83MiB** | +1.51MiB |
| 단독 exe | — | 10.58MB | +4.9MB (mongodb 드라이버·rustls·DNS가 대부분) |
| 유휴 메모리 (탭 5개 복원, private) | 150MB 이하 | **약 131MB** | +4MB. Rust 프로세스는 5.5MB로 같음 |
| 콜드 스타트 | 1.5초 이하 | **약 0.52초** | 거의 같음 |
| 프론트 JS 번들 (gzip) | 1MB 이하 | **306KB** | +24KB (Redis·Mongo 화면, mongosh 파서) |

Redis·MongoDB 접속 중 메모리와 서버 쪽 동작은 Docker 준비 후 다시 잰다.

메모리 내역(빈 작업 공간, GPU 끄기 전): Rust 프로세스 5.5MB, 페이지 렌더러 36MB, WebView2 브라우저 38MB, GPU 프로세스 67MB, 유틸리티 19MB. 가장 큰 GPU 프로세스는 `additionalBrowserArgs`에 `--disable-gpu`를 넣어 줄였다. Glide 그리드는 canvas 2D라 소프트웨어 렌더링으로도 60fps가 나온다.
