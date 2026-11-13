import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import Database from 'better-sqlite3'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const dbPath = process.env.DB_PATH || path.resolve(__dirname, '../data/emotion.db')
fs.mkdirSync(path.dirname(dbPath), { recursive: true })

export const db = new Database(dbPath)
db.pragma('journal_mode = WAL')
db.pragma('foreign_keys = ON')

db.exec(`
CREATE TABLE IF NOT EXISTS users (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  username TEXT NOT NULL UNIQUE,
  display_name TEXT NOT NULL,
  password_hash TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS records (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  day TEXT NOT NULL,
  score INTEGER NOT NULL,
  note TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS shares (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  token TEXT NOT NULL UNIQUE,
  scope TEXT NOT NULL CHECK (scope IN ('colors', 'full')),
  label TEXT NOT NULL DEFAULT '',
  created_at TEXT NOT NULL,
  revoked INTEGER NOT NULL DEFAULT 0
);

CREATE TABLE IF NOT EXISTS grants (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  share_id INTEGER NOT NULL REFERENCES shares(id) ON DELETE CASCADE,
  owner_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  viewer_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  scope TEXT NOT NULL,
  created_at TEXT NOT NULL,
  UNIQUE (owner_id, viewer_id)
);
`)

// 早期版本 records 表带 UNIQUE(user_id, day)，一天只能存一颗扭蛋。
// 现在一天可以有多颗，需要去掉该约束；SQLite 不支持直接删约束，只能重建表。
function recordsHasUniqueDay() {
  const indexes = db.prepare(`SELECT name, "unique" AS isUnique FROM pragma_index_list('records')`).all()
  return indexes.some((index) => {
    if (!index.isUnique) return false
    const columns = db.prepare('SELECT name FROM pragma_index_info(?)').all(index.name).map((c) => c.name)
    return columns.length === 2 && columns.includes('user_id') && columns.includes('day')
  })
}

if (recordsHasUniqueDay()) {
  db.transaction(() => {
    db.exec(`
      DROP TABLE IF EXISTS records_migrate;
      CREATE TABLE records_migrate (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
        day TEXT NOT NULL,
        score INTEGER NOT NULL,
        note TEXT NOT NULL DEFAULT '',
        created_at TEXT NOT NULL,
        updated_at TEXT NOT NULL
      );
      INSERT INTO records_migrate (id, user_id, day, score, note, created_at, updated_at)
        SELECT id, user_id, day, score, note, updated_at, updated_at FROM records;
      DROP TABLE records;
      ALTER TABLE records_migrate RENAME TO records;
    `)
  })()
}

db.exec(`
CREATE INDEX IF NOT EXISTS idx_records_user_day ON records(user_id, day);
CREATE INDEX IF NOT EXISTS idx_grants_viewer ON grants(viewer_id);
`)
