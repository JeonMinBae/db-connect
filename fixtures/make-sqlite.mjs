// node fixtures/make-sqlite.mjs → fixtures/sample.db 재생성 (Node 22+ 내장 node:sqlite 사용)
import { DatabaseSync } from "node:sqlite";
import { readFileSync, rmSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const dir = dirname(fileURLToPath(import.meta.url));
const path = join(dir, "sample.db");
rmSync(path, { force: true });
const db = new DatabaseSync(path);
db.exec(readFileSync(join(dir, "seed.sqlite.sql"), "utf8"));
db.close();
console.log("created", path);
