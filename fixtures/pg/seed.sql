CREATE EXTENSION IF NOT EXISTS pgcrypto;
CREATE TYPE mood AS ENUM ('sad', 'ok', 'happy');

CREATE TABLE users (
  id SERIAL PRIMARY KEY,
  email TEXT NOT NULL UNIQUE,
  name TEXT,
  age INT,
  score NUMERIC(6,2),
  active BOOLEAN NOT NULL DEFAULT true,
  born DATE,
  created_at TIMESTAMPTZ DEFAULT now(),
  uid UUID DEFAULT gen_random_uuid(),
  feeling mood,
  profile JSONB,
  avatar BYTEA
);
INSERT INTO users (email, name, age, score, active, born, feeling, profile, avatar) VALUES
  ('kim@example.com', '김철수', 31, 88.5, true, '1994-03-02', 'happy', '{"lang":"ko","tags":["a","b"]}', '\x89504e470d0a1a0a'),
  ('lee@example.com', '이영희', 27, 92.25, true, '1998-11-20', 'ok', '{"lang":"ko"}', NULL),
  ('park@example.com', NULL, NULL, NULL, false, NULL, NULL, NULL, NULL),
  ('quote@example.com', 'O''Brien, "Bob"', 45, 1.0, true, '1980-01-01', 'sad', NULL, NULL),
  ('multi@example.com', E'line1\nline2', 33, 0.1, true, '1992-07-07', NULL, NULL, NULL);

CREATE TABLE no_pk (label TEXT, qty INT, note TEXT, meta JSON);
INSERT INTO no_pk VALUES ('apple', 3, NULL, '{"a":1}'), ('apple', 3, NULL, '{"a":1}'), ('banana', 5, 'ripe', NULL), ('cherry', NULL, 'x', NULL);

CREATE TABLE order_items (order_id INT NOT NULL, line_no INT NOT NULL, sku TEXT NOT NULL, price NUMERIC(10,2), PRIMARY KEY (order_id, line_no));
INSERT INTO order_items VALUES (1, 1, 'A-1', 10.50), (1, 2, 'B-2', 3.00), (2, 1, 'A-1', 10.50);

CREATE TABLE "Weird ""Name"" Table" ("Mixed Case" TEXT PRIMARY KEY, val INT);
INSERT INTO "Weird ""Name"" Table" VALUES ('x', 1), ('Y', 2);

CREATE TABLE big (id INT PRIMARY KEY, grp INT, txt TEXT);
INSERT INTO big SELECT i, i % 100, 'row ' || i FROM generate_series(1, 1000000) i;

CREATE VIEW active_users AS SELECT id, email, name FROM users WHERE active;

CREATE SCHEMA other;
CREATE TABLE other.things (id INT PRIMARY KEY, label TEXT);
INSERT INTO other.things VALUES (1, 'one');
