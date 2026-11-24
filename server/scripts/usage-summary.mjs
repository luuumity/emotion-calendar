// 用量汇总：直接读独立流水 usage_events（删会话/报告不影响历史）。
// 只统计 token，不折算金额。用法：node scripts/usage-summary.mjs [天数=7]
// 若表为空，先跑 scripts/backfill-usage-events.mjs 回填 v16 之后的历史。

import { db } from '../src/db.js'

const days = Math.max(1, Number(process.argv[2]) || 7)
const since = new Date(Date.now() - days * 86400000).toISOString()

const n = (v) => Number(v || 0)
const hitRate = (hit, miss) => {
  const total = hit + miss
  return total ? `${((hit / total) * 100).toFixed(1)}%` : '-'
}

const rows = db
  .prepare(
    `SELECT kind,
            COUNT(*) AS calls,
            SUM(input_tokens) AS input,
            SUM(output_tokens) AS output,
            SUM(hit_tokens) AS hit,
            SUM(miss_tokens) AS miss
     FROM usage_events
     WHERE created_at >= ?
     GROUP BY kind`
  )
  .all(since)

const LABELS = { chat: '聊天', single: '单人报告', couple: '双人报告' }
const byKind = Object.fromEntries(rows.map((r) => [r.kind, r]))
const total = rows.reduce(
  (acc, r) => ({
    calls: acc.calls + n(r.calls),
    input: acc.input + n(r.input),
    output: acc.output + n(r.output),
    hit: acc.hit + n(r.hit),
    miss: acc.miss + n(r.miss)
  }),
  { calls: 0, input: 0, output: 0, hit: 0, miss: 0 }
)

function line(label, r) {
  const calls = String(n(r.calls)).padStart(4)
  const input = String(n(r.input)).padStart(9)
  const output = String(n(r.output)).padStart(8)
  const rate = hitRate(n(r.hit), n(r.miss)).padStart(6)
  return `${label.padEnd(10)} 调用 ${calls}  输入 ${input}  输出 ${output}  命中 ${rate}`
}

console.log(`最近 ${days} 天用量（${since.slice(0, 10)} 起）`)
for (const kind of ['chat', 'single', 'couple']) console.log(line(LABELS[kind], byKind[kind] || {}))
console.log(line('合计', total))
