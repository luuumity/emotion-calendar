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

function tableExists(name) {
  return !!db.prepare("SELECT 1 FROM sqlite_master WHERE type = 'table' AND name = ?").get(name)
}

// 早期版本 records 表带 UNIQUE(user_id, day)，一天只能存一颗扭蛋。
// SQLite 不支持直接删约束，只能重建表。
function recordsHasUniqueDay() {
  const indexes = db.prepare(`SELECT name, "unique" AS isUnique FROM pragma_index_list('records')`).all()
  return indexes.some((index) => {
    if (!index.isUnique) return false
    const columns = db.prepare('SELECT name FROM pragma_index_info(?)').all(index.name).map((c) => c.name)
    return columns.length === 2 && columns.includes('user_id') && columns.includes('day')
  })
}

const migrations = [
  {
    version: 1,
    // 基线：当前的四张表与索引。全部用 IF NOT EXISTS，老库执行也无副作用。
    up() {
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

      if (recordsHasUniqueDay()) {
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
      }

      db.exec(`
        CREATE INDEX IF NOT EXISTS idx_records_user_day ON records(user_id, day);
        CREATE INDEX IF NOT EXISTS idx_grants_viewer ON grants(viewer_id);
      `)
    }
  },
  {
    version: 2,
    // 提醒功能：用户级配置 + 设备订阅
    up() {
      db.exec(`
        ALTER TABLE users ADD COLUMN reminder_enabled INTEGER NOT NULL DEFAULT 0;
        ALTER TABLE users ADD COLUMN reminder_time TEXT NOT NULL DEFAULT '21:00';
        ALTER TABLE users ADD COLUMN timezone TEXT NOT NULL DEFAULT 'Asia/Shanghai';
        ALTER TABLE users ADD COLUMN last_reminded_on TEXT NOT NULL DEFAULT '';

        CREATE TABLE IF NOT EXISTS push_subscriptions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          endpoint TEXT NOT NULL UNIQUE,
          p256dh TEXT NOT NULL,
          auth TEXT NOT NULL,
          created_at TEXT NOT NULL,
          last_ok_at TEXT,
          fail_count INTEGER NOT NULL DEFAULT 0
        );

        CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
      `)
    }
  },
  {
    version: 3,
    // 允许事后微调分值：记录首次调整前的原始分与最近一次调整时间
    up() {
      db.exec(`
        ALTER TABLE records ADD COLUMN original_score INTEGER;
        ALTER TABLE records ADD COLUMN adjusted_at TEXT;
      `)
    }
  }
]

function backupBeforeMigrate(targetVersion) {
  const dir = path.resolve(path.dirname(dbPath), '../backups')
  fs.mkdirSync(dir, { recursive: true })
  const stamp = new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)
  const dest = path.join(dir, `pre-migrate-v${targetVersion}-${stamp}.db`)
  db.exec(`VACUUM INTO '${dest.replace(/'/g, "''")}'`)
  return dest
}

function migrate() {
  const current = db.pragma('user_version', { simple: true })
  const pending = migrations.filter((m) => m.version > current)
  if (!pending.length) return

  const target = pending[pending.length - 1].version
  // 已有数据的库先做一次快照；全新库没有可丢的东西，跳过备份
  if (tableExists('users')) {
    console.log(`[db] 迁移前备份: ${backupBeforeMigrate(target)}`)
  }

  db.transaction(() => {
    for (const migration of pending) {
      migration.up()
      db.exec(`PRAGMA user_version = ${migration.version}`)
    }
  })()

  console.log(`[db] 数据库已迁移: v${current} -> v${target}`)
}

migrate()
