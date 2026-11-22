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
  },
  {
    version: 4,
    // AI 能力全套表：持久记忆、记录标签、单人/双人报告、对谈会话
    up() {
      db.exec(`
        -- Facts：关于用户自身的稳定事实，用户可控写入
        CREATE TABLE IF NOT EXISTS facts (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          content TEXT NOT NULL,
          confidence INTEGER NOT NULL DEFAULT 3 CHECK (confidence BETWEEN 1 AND 5),
          source TEXT NOT NULL DEFAULT 'user' CHECK (source IN ('user', 'agent_extracted', 'report_derived')),
          source_ref_id INTEGER,
          couple_visible INTEGER NOT NULL DEFAULT 0,
          pinned INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_facts_user ON facts(user_id);

        -- AI 标签：附着在具体记录上的对话洞察
        CREATE TABLE IF NOT EXISTS record_tags (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          record_id INTEGER NOT NULL REFERENCES records(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          tag_type TEXT NOT NULL CHECK (tag_type IN ('insight', 'suggestion', 'pattern', 'correction')),
          content TEXT NOT NULL,
          source TEXT NOT NULL DEFAULT 'agent' CHECK (source IN ('user', 'agent')),
          source_ref_message_id INTEGER,
          couple_visible INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_record_tags_record ON record_tags(record_id);
        CREATE INDEX IF NOT EXISTS idx_record_tags_user ON record_tags(user_id);

        -- 单人/双人 AI 报告
        CREATE TABLE IF NOT EXISTS insights (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          scope TEXT NOT NULL CHECK (scope IN ('single', 'couple')),
          user_id INTEGER REFERENCES users(id) ON DELETE CASCADE,
          couple_key TEXT,
          period_type TEXT NOT NULL CHECK (period_type IN ('week', 'month', 'manual')),
          period_start TEXT NOT NULL,
          period_end TEXT NOT NULL,
          content TEXT NOT NULL,
          model TEXT NOT NULL DEFAULT '',
          prompt_version TEXT NOT NULL DEFAULT '',
          tokens INTEGER NOT NULL DEFAULT 0,
          sources TEXT,            -- JSON：联网检索的引用
          input_hash TEXT NOT NULL DEFAULT '',
          covered_until TEXT,      -- 增量分析的水位
          generated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_insights_single_user ON insights(scope, user_id, period_start);
        CREATE INDEX IF NOT EXISTS idx_insights_couple_key ON insights(scope, couple_key, period_start);

        -- 双人增量记忆：记录上次分析覆盖到哪一天 + 摘要
        CREATE TABLE IF NOT EXISTS couple_memory (
          couple_key TEXT PRIMARY KEY,
          summary TEXT NOT NULL DEFAULT '',
          covered_until TEXT NOT NULL DEFAULT '',
          updated_at TEXT NOT NULL
        );

        -- 问答会话
        CREATE TABLE IF NOT EXISTS chat_sessions (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          title TEXT NOT NULL DEFAULT '',
          created_at TEXT NOT NULL,
          updated_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chat_sessions_user ON chat_sessions(user_id);

        -- 问答消息
        CREATE TABLE IF NOT EXISTS chat_messages (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          role TEXT NOT NULL CHECK (role IN ('user', 'assistant', 'system')),
          content TEXT NOT NULL,
          refs TEXT,               -- JSON：引用的报告 / 记录 ID
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chat_messages_session ON chat_messages(session_id);
      `)
    }
  },
  {
    version: 5,
    // 幂等保护：给 insights 加数据库层部分唯一索引
    // SQLite 部分唯一索引支持 WHERE 子句限定 scope，单人/双人各一条
    // 同时给 facts 加普通索引加速"用户已有相似内容"查询
    up() {
      db.exec(`
        CREATE UNIQUE INDEX IF NOT EXISTS idx_insights_single_unique
          ON insights(user_id, period_type, period_start) WHERE scope = 'single';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_insights_couple_unique
          ON insights(couple_key, period_type, period_start) WHERE scope = 'couple';
        CREATE INDEX IF NOT EXISTS idx_facts_user_content ON facts(user_id, content, couple_visible);
      `)
    }
  },
  {
    version: 6,
    // 会话压缩摘要：summary 存滚动摘要，summary_until_id 标记已压缩到哪条消息
    up() {
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN summary TEXT NOT NULL DEFAULT '';`)
      db.exec(`ALTER TABLE chat_sessions ADD COLUMN summary_until_id INTEGER NOT NULL DEFAULT 0;`)
    }
  },
  {
    version: 7,
    // 记录每次回答末次请求的 prompt 规模，用于校准 token 估算与成本统计
    up() {
      db.exec(`ALTER TABLE chat_messages ADD COLUMN prompt_tokens INTEGER NOT NULL DEFAULT 0;`)
      db.exec(`ALTER TABLE chat_messages ADD COLUMN prompt_chars INTEGER NOT NULL DEFAULT 0;`)
    }
  },
  {
    version: 8,
    // Agent 写入提议：模型只提议，用户确认后才落库
    up() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_proposals (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          message_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('fact', 'tag', 'report')),
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected')),
          couple_visible INTEGER NOT NULL DEFAULT 0,
          result_ref_id INTEGER,
          created_at TEXT NOT NULL,
          decided_at TEXT
        );
        CREATE INDEX IF NOT EXISTS idx_chat_proposals_message ON chat_proposals(message_id);
        CREATE INDEX IF NOT EXISTS idx_chat_proposals_session ON chat_proposals(session_id, status);
      `)
    }
  },
  {
    version: 9,
    // 提议闭环：允许 record 类型、expired 状态；记录用户是否改过内容
    // SQLite 改不了 CHECK，只能重建表
    up() {
      db.exec(`
        CREATE TABLE chat_proposals_v9 (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          message_id INTEGER REFERENCES chat_messages(id) ON DELETE CASCADE,
          kind TEXT NOT NULL CHECK (kind IN ('fact', 'tag', 'report', 'record')),
          payload TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'rejected', 'expired')),
          couple_visible INTEGER NOT NULL DEFAULT 0,
          result_ref_id INTEGER,
          final_payload TEXT,
          edited INTEGER NOT NULL DEFAULT 0,
          created_at TEXT NOT NULL,
          decided_at TEXT
        );

        INSERT INTO chat_proposals_v9
          (id, user_id, session_id, message_id, kind, payload, status, couple_visible, result_ref_id, final_payload, edited, created_at, decided_at)
        SELECT id, user_id, session_id, message_id, kind, payload, status, couple_visible, result_ref_id, NULL, 0, created_at, decided_at
        FROM chat_proposals;

        DROP TABLE chat_proposals;
        ALTER TABLE chat_proposals_v9 RENAME TO chat_proposals;

        CREATE INDEX IF NOT EXISTS idx_chat_proposals_message ON chat_proposals(message_id);
        CREATE INDEX IF NOT EXISTS idx_chat_proposals_session ON chat_proposals(session_id, status);
      `)
    }
  },
  {
    version: 10,
    // 自定义区间（manual）的报告可以起点相同、终点不同，唯一键需要带上 period_end。
    // week/month 仍按 (user_id, period_type, period_start) 去重。
    up() {
      db.exec(`
        DROP INDEX IF EXISTS idx_insights_single_unique;
        CREATE UNIQUE INDEX IF NOT EXISTS idx_insights_single_unique
          ON insights(user_id, period_type, period_start)
          WHERE scope = 'single' AND period_type != 'manual';
        CREATE UNIQUE INDEX IF NOT EXISTS idx_insights_single_manual_unique
          ON insights(user_id, period_start, period_end)
          WHERE scope = 'single' AND period_type = 'manual';
      `)
    }
  },
  {
    version: 11,
    // 完整工具调用轨迹：先只落库，不改历史、压缩和提示词。
    // turn_id 指向本轮 user 消息；seq 保证同一轮内的消息顺序。
    up() {
      db.exec(`
        CREATE TABLE IF NOT EXISTS chat_trace_events (
          id INTEGER PRIMARY KEY AUTOINCREMENT,
          session_id INTEGER NOT NULL REFERENCES chat_sessions(id) ON DELETE CASCADE,
          user_id INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          turn_id INTEGER NOT NULL REFERENCES chat_messages(id) ON DELETE CASCADE,
          seq INTEGER NOT NULL,
          type TEXT NOT NULL CHECK (type IN ('assistant_tool_calls', 'tool_result')),
          payload TEXT NOT NULL,
          created_at TEXT NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_chat_trace_session_turn
          ON chat_trace_events(session_id, turn_id, seq);
      `)
    }
  },
  {
    version: 12,
    // 一球一标签：每条记录只保留一个标签；已有重复时保留最新一条（id 最大）。
    up() {
      db.exec(`
        DELETE FROM record_tags
        WHERE id NOT IN (SELECT MAX(id) FROM record_tags GROUP BY record_id);

        CREATE UNIQUE INDEX IF NOT EXISTS idx_record_tags_record_unique
          ON record_tags(record_id);
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
