# 테스트 DB

- SQLite: `node fixtures/make-sqlite.mjs` → `fixtures/sample.db`
- PostgreSQL / MySQL: `docker compose -f fixtures/docker-compose.yml up -d` (시드는 컨테이너 첫 기동 시 자동 적용)
  - PG: `localhost:55432`, db `sample`, user `dbc` / pw `dbc`
  - MySQL: `localhost:53306`, db `sample`, user `dbc` / pw `dbc`
  - Redis: `localhost:56379`, 비밀번호 `dbc` (시드 없음: 콘솔이나 트리의 "새 키…"로 만든다)
  - MongoDB 레플리카셋(트랜잭션 검증용): `mongodb://localhost:57017/?directConnection=true`
  - MongoDB standalone(롤백 불가 경고 검증용): `mongodb://localhost:57018/`
