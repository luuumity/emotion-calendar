// 用量汇总：聊天与报告的 token 明细、缓存命中率
// 用法：node scripts/usage-summary.mjs [天数=7]
// 说明：聊天的 prompt_tokens 记录的是末次请求规模，不是整轮累加；completion 与缓存是整轮累加。

import { db } from '../src/db.js'

const days = Math.max(1, Number(process.argv[2]) || 7)
const since = new Date(Date.now() - days * 86400000).toISOString()

const n = (v) => Number(v || 0)
const hitRate = (hit, miss) => {
  const total = hit + miss
  return total ? `${((hit / total) * 100).toFixed(1)}%` : '-'
}

const chat = db
  .prepare(
    `SELECT COUNT(*) AS calls,
            SUM(prompt_tokens) AS prompt,
            SUM(completion_tokens) AS completion,
            SUM(cache_hit_tokens) AS hit,
            SUM(cache_miss_tokens) AS miss
     FROM chat_messages
     WHERE role = 'assistant' AND created_at >= ?`
  )
  .get(since)

const reports = db
  .prepare(
    `SELECT scope,
            COUNT(*) AS calls,
            SUM(prompt_tokens) AS prompt,
            SUM(completion_tokens) AS completion,
            SUM(cache_hit_tokens) AS hit,
            SUM(cache_miss_tokens) AS miss
     FROM insights
     WHERE generated_at >= ?
     GROUP BY scope`
  )
  .all(since)

function line(label, r) {
  const calls = String(n(r.calls)).padStart(4)
  const prompt = String(n(r.prompt)).padStart(9)
  const completion = String(n(r.completion)).padStart(8)
  const rate = hitRate(n(r.hit), n(r.miss)).padStart(6)
  return `${label.padEnd(10)} 调用 ${calls}  输入 ${prompt}  输出 ${completion}  命中 ${rate}`
}

console.log(`最近 ${days} 天用量（${since.slice(0, 10)} 起）`)
console.log(line('聊天', chat || {}))
if (reports.length) {
  for (const r of reports) console.log(line(r.scope === 'couple' ? '双人报告' : '单人报告', r))
} else {
  console.log(line('报告', {}))
}
