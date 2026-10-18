USE sample;
SET NAMES utf8mb4;

CREATE TABLE users (
  id INT AUTO_INCREMENT PRIMARY KEY,
  email VARCHAR(255) NOT NULL UNIQUE,
  name VARCHAR(100),
  age INT,
  score DECIMAL(6,2),
  active TINYINT(1) NOT NULL DEFAULT 1,
  born DATE,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  feeling ENUM('sad','ok','happy'),
  profile JSON,
  avatar BLOB
) DEFAULT CHARSET=utf8mb4;
INSERT INTO users (email, name, age, score, active, born, feeling, profile, avatar) VALUES
  ('kim@example.com', '김철수', 31, 88.5, 1, '1994-03-02', 'happy', '{"lang":"ko","tags":["a","b"]}', X'89504E470D0A1A0A'),
  ('lee@example.com', '이영희', 27, 92.25, 1, '1998-11-20', 'ok', '{"lang":"ko"}', NULL),
  ('park@example.com', NULL, NULL, NULL, 0, NULL, NULL, NULL, NULL),
  ('quote@example.com', 'O''Brien, "Bob"', 45, 1.0, 1, '1980-01-01', 'sad', NULL, NULL),
  ('multi@example.com', 'line1\nline2', 33, 0.1, 1, '1992-07-07', NULL, NULL, NULL);

CREATE TABLE no_pk (label VARCHAR(50), qty INT, note VARCHAR(50)) DEFAULT CHARSET=utf8mb4;
INSERT INTO no_pk VALUES ('apple', 3, NULL), ('apple', 3, NULL), ('banana', 5, 'ripe'), ('cherry', NULL, 'x');

CREATE TABLE order_items (order_id INT NOT NULL, line_no INT NOT NULL, sku VARCHAR(20) NOT NULL, price DECIMAL(10,2), PRIMARY KEY (order_id, line_no));
INSERT INTO order_items VALUES (1, 1, 'A-1', 10.50), (1, 2, 'B-2', 3.00), (2, 1, 'A-1', 10.50);

CREATE TABLE `Weird "Name" Table` (`Mixed Case` VARCHAR(20) PRIMARY KEY, val INT);
INSERT INTO `Weird "Name" Table` VALUES ('x', 1), ('Y', 2);

CREATE TABLE big (id INT PRIMARY KEY, grp INT, txt VARCHAR(30));
SET SESSION cte_max_recursion_depth = 1000001;
INSERT INTO big WITH RECURSIVE n(i) AS (SELECT 1 UNION ALL SELECT i + 1 FROM n WHERE i < 1000000) SELECT i, i % 100, CONCAT('row ', i) FROM n;

CREATE VIEW active_users AS SELECT id, email, name FROM users WHERE active = 1;

GRANT PROCESS ON *.* TO 'dbc'@'%';
