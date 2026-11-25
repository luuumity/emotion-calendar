// AI 用量汇总：按用户聚合 usage_events（只读）。
// 明细粒度是一轮对话 / 一份报告，这里只做求和，不落汇总表。

import { Router } from 'express'
import { db } from '../db.js'
import { requireUser } from '../auth.js'

const router = Router()
router.use(requireUser)

const KINDS = ['chat', 'single', 'couple']

function safeZone(timeZone) {
  try {
    new Intl.DateTimeFormat('en-CA', { timeZone }).format(new Date())
    return timeZone
  } catch {
    return 'Asia/Shanghai'
  }
}

function localDay(date, timeZone) {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit'
  }).format(date)
}

/** 该时区相对 UTC 的偏移毫秒数（毫秒为正表示东边）。 */
function zoneOffset(date, timeZone) {
  const parts = new Intl.DateTimeFormat('en-US', {
    timeZone,
    hour12: false,
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit'
  }).formatToParts(date)
  const get = (type) => Number(parts.find((p) => p.type === type)?.value)
  const asUtc = Date.UTC(get('year'), get('month') - 1, get('day'), get('hour') % 24, get('minute'), get('second'))
  return asUtc - Math.floor(date.getTime() / 1000) * 1000
}

/** 当地「本月 1 日 00:00」对应的 UTC 时刻。 */
function monthStart(now, timeZone) {
  const [year, month] = localDay(now, timeZone).split('-').map(Number)
  const guess = new Date(Date.UTC(year, month - 1, 1))
  return new Date(guess.getTime() - zoneOffset(guess, timeZone))
}

function hitRate(row) {
  const denom = row.hit + row.miss
  return denom > 0 ? row.hit / denom : null
}

router.get('/summary', (req, res) => {
  const timeZone = safeZone(req.user.timezone || 'Asia/Shanghai')
  const range = req.query.range === '30d' ? '30d' : 'month'
  const now = new Date()
  const start = range === '30d' ? new Date(now.getTime() - 30 * 86400 * 1000) : monthStart(now, timeZone)
  const startIso = start.toISOString()

  const rows = db
    .prepare(
      `SELECT kind,
              COUNT(*) AS calls,
              COALESCE(SUM(input_tokens), 0) AS input,
              COALESCE(SUM(output_tokens), 0) AS output,
              COALESCE(SUM(hit_tokens), 0) AS hit,
              COALESCE(SUM(miss_tokens), 0) AS miss
       FROM usage_events
       WHERE user_id = ? AND created_at >= ?
       GROUP BY kind`
    )
    .all(req.user.id, startIso)

  const byKind = new Map(rows.map((row) => [row.kind, row]))
  const kinds = KINDS.map((kind) => {
    const row = byKind.get(kind) || { calls: 0, input: 0, output: 0, hit: 0, miss: 0 }
    return {
      kind,
      calls: row.calls,
      input: row.input,
      output: row.output,
      tokens: row.input + row.output,
      hitRate: hitRate(row)
    }
  })

  const totals = kinds.reduce(
    (acc, item) => ({
      calls: acc.calls + item.calls,
      input: acc.input + item.input,
      output: acc.output + item.output,
      tokens: acc.tokens + item.tokens
    }),
    { calls: 0, input: 0, output: 0, tokens: 0 }
  )
  const totalsRow = rows.reduce(
    (acc, row) => ({ hit: acc.hit + row.hit, miss: acc.miss + row.miss }),
    { hit: 0, miss: 0 }
  )
  totals.hitRate = hitRate(totalsRow)

  const first = db.prepare('SELECT MIN(created_at) AS first FROM usage_events WHERE user_id = ?').get(req.user.id)
  const trackedFrom = first?.first ? localDay(new Date(first.first), timeZone) : null

  res.json({
    range,
    startDate: localDay(start, timeZone),
    trackedFrom,
    totals,
    kinds
  })
})

export default router
