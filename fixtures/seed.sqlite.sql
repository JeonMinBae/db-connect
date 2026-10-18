-- db-connect 테스트용 SQLite 시드
DROP TABLE IF EXISTS users;
DROP TABLE IF EXISTS no_pk;
DROP TABLE IF EXISTS order_items;
DROP TABLE IF EXISTS "Weird ""Name"" Table";
DROP TABLE IF EXISTS big;

CREATE TABLE users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  age INTEGER,
  score REAL,
  active INTEGER NOT NULL DEFAULT 1,
  born DATE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  profile TEXT,           -- JSON
  avatar BLOB
);
INSERT INTO users (email, name, age, score, active, born, profile, avatar) VALUES
  ('kim@example.com', '김철수', 31, 88.5, 1, '1994-03-02', '{"lang":"ko","tags":["a","b"]}', X'89504E470D0A1A0A'),
  ('lee@example.com', '이영희', 27, 92.25, 1, '1998-11-20', '{"lang":"ko"}', NULL),
  ('park@example.com', NULL, NULL, NULL, 0, NULL, NULL, NULL),
  ('quote@example.com', 'O''Brien, "Bob"', 45, 1.0, 1, '1980-01-01', NULL, NULL),
  ('multi@example.com', 'line1
line2', 33, 0.1, 1, '1992-07-07', NULL, NULL);

-- PK 없는 테이블 (중복 행 포함)
CREATE TABLE no_pk (label TEXT, qty INTEGER, note TEXT);
INSERT INTO no_pk VALUES ('apple', 3, NULL), ('apple', 3, NULL), ('banana', 5, 'ripe'), ('cherry', NULL, 'x');

-- 복합 PK
CREATE TABLE order_items (order_id INTEGER NOT NULL, line_no INTEGER NOT NULL, sku TEXT NOT NULL, price NUMERIC(10,2), PRIMARY KEY (order_id, line_no));
INSERT INTO order_items VALUES (1, 1, 'A-1', 10.50), (1, 2, 'B-2', 3.00), (2, 1, 'A-1', 10.50);

-- 따옴표/공백/대소문자가 섞인 테이블 이름
CREATE TABLE "Weird ""Name"" Table" ("Mixed Case" TEXT PRIMARY KEY, val INTEGER);
INSERT INTO "Weird ""Name"" Table" VALUES ('x', 1), ('Y', 2);

-- 대용량 (100만 행)
CREATE TABLE big (id INTEGER PRIMARY KEY, grp INTEGER, txt TEXT);
WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000000)
INSERT INTO big SELECT i, i % 100, 'row ' || i FROM n;

CREATE VIEW active_users AS SELECT id, email, name FROM users WHERE active = 1;
