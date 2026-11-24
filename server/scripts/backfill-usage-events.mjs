// 回填 usage_events：把 v16 之后已落库的聊天/报告用量搬到独立流水。
// 可重复执行（dedupe_key 保证幂等）。用法：node scripts/backfill-usage-events.mjs

import { db } from '../src/db.js'

function coupleOwnerId(coupleKey) {
  const first = String(coupleKey || '').split(':')[0]
  const id = Number(first)
  return Number.isInteger(id) && id > 0 ? id : null
}

const insert = db.prepare(
  `INSERT OR IGNORE INTO usage_events
    (user_id, kind, source_id, dedupe_key, model, input_tokens, output_tokens, hit_tokens, miss_tokens, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
)

const chatRows = db
  .prepare(
    `SELECT m.id, m.cache_hit_tokens, m.cache_miss_tokens, m.completion_tokens, m.created_at, s.user_id
     FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
     WHERE m.role = 'assistant'
       AND (m.cache_hit_tokens + m.cache_miss_tokens + m.completion_tokens) > 0
     ORDER BY m.id`
  )
  .all()

const reportRows = db
  .prepare(
    `SELECT id, scope, user_id, couple_key, prompt_tokens, completion_tokens,
            cache_hit_tokens, cache_miss_tokens, model, generated_at
     FROM insights
     WHERE (prompt_tokens + completion_tokens) > 0
     ORDER BY id`
  )
  .all()

let chatAdded = 0
let reportAdded = 0
let skipped = 0

db.transaction(() => {
  for (const row of chatRows) {
    const info = insert.run(
      row.user_id,
      'chat',
      row.id,
      `chat:${row.id}`,
      '',
      row.cache_hit_tokens + row.cache_miss_tokens,
      row.completion_tokens,
      row.cache_hit_tokens,
      row.cache_miss_tokens,
      row.created_at
    )
    chatAdded += info.changes
  }

  for (const row of reportRows) {
    const userId = row.scope === 'couple' ? row.user_id || coupleOwnerId(row.couple_key) : row.user_id
    if (!userId) {
      skipped += 1
      continue
    }
    const info = insert.run(
      userId,
      row.scope,
      row.id,
      `report:${row.id}`,
      row.model || '',
      row.prompt_tokens,
      row.completion_tokens,
      row.cache_hit_tokens,
      row.cache_miss_tokens,
      row.generated_at
    )
    reportAdded += info.changes
  }
})()

const totals = db
  .prepare(
    `SELECT kind, COUNT(*) AS events, SUM(input_tokens) AS input, SUM(output_tokens) AS output
     FROM usage_events GROUP BY kind`
  )
  .all()

console.log(`回填完成：聊天新增 ${chatAdded} 条，报告新增 ${reportAdded} 条，跳过 ${skipped} 条`)
for (const row of totals) {
  console.log(`  ${row.kind}: ${row.events} 条，输入 ${row.input || 0}，输出 ${row.output || 0}`)
}
