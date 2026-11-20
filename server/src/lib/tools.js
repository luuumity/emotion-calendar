// 聊天可用的内置工具（客户端 function calling）
// 约定：返回值永远是合法 JSON；超过 MAX_RESULT_CHARS 时不返回半截数据，而是返回提示让模型缩小范围

import { db } from '../db.js'

const MAX_RESULT_CHARS = 6000   // 单次结果字符上限（约 4000 token）
const MAX_SPAN_DAYS = 90        // 单次查询的时间跨度上限
const MAX_ITEMS = 60
const NOTE_PREVIEW = 200

function isDay(s) {
  return typeof s === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(s)
}

function dayDiff(a, b) {
  const ms = new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)
  return Math.round(ms / 86400000)
}

function rangeArgs(args) {
  const start = String(args?.start || '')
  const end = String(args?.end || '')
  if (!isDay(start) || !isDay(end)) return { error: '日期格式应为 YYYY-MM-DD' }
  if (start > end) return { error: '起始日期不能晚于结束日期' }
  const span = dayDiff(start, end)
  if (span > MAX_SPAN_DAYS) {
    return { error: `时间跨度为 ${span} 天，超过 ${MAX_SPAN_DAYS} 天上限。请缩小范围后分次查询。` }
  }
  return { start, end }
}

export const FUNCTION_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_days',
      description:
        '读取指定日期范围内的情绪记录。返回每天的扭蛋：日期、分值、理由摘要、标签。单次跨度不能超过 90 天。',
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'string', description: '起始日期，YYYY-MM-DD' },
          end: { type: 'string', description: '结束日期，YYYY-MM-DD' }
        },
        required: ['start', 'end']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_tags',
      description: '读取指定日期范围内 AI 为记录生成的标签（洞察、建议、模式、纠正）。单次跨度不能超过 90 天。',
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'string', description: '起始日期，YYYY-MM-DD' },
          end: { type: 'string', description: '结束日期，YYYY-MM-DD' }
        },
        required: ['start', 'end']
      }
    }
  }
]

function getDays(userId, args) {
  const range = rangeArgs(args)
  if (range.error) return { ok: false, reason: 'bad_args', hint: range.error }

  const rows = db
    .prepare(
      `SELECT id, day, score, original_score, note FROM records
       WHERE user_id = ? AND day >= ? AND day <= ?
       ORDER BY day ASC, id ASC`
    )
    .all(userId, range.start, range.end)

  const tags = db
    .prepare(
      `SELECT t.record_id, t.content FROM record_tags t
       JOIN records r ON r.id = t.record_id
       WHERE t.user_id = ? AND r.day >= ? AND r.day <= ?
       ORDER BY t.id ASC`
    )
    .all(userId, range.start, range.end)

  const tagsByRecord = {}
  for (const t of tags) {
    const list = tagsByRecord[t.record_id] || (tagsByRecord[t.record_id] = [])
    if (list.length < 3) list.push(String(t.content || '').slice(0, 20))
  }

  const total = rows.length
  const items = rows.slice(0, MAX_ITEMS).map((r) => {
    const note = String(r.note || '').replace(/\s+/g, ' ').trim()
    const item = { id: r.id, day: r.day, score: r.score }
    if (r.original_score != null) item.originalScore = r.original_score
    if (note) {
      item.note = note.slice(0, NOTE_PREVIEW)
      if (note.length > NOTE_PREVIEW) item.noteTruncated = true
    }
    const ts = tagsByRecord[r.id]
    if (ts && ts.length) item.tags = ts
    return item
  })

  const out = { ok: true, start: range.start, end: range.end, total, returned: items.length, items }
  if (total > MAX_ITEMS) {
    out.hint = `共 ${total} 条，只返回最早 ${MAX_ITEMS} 条。请把范围缩小到更短的区间再查。`
  }
  return out
}

function getTags(userId, args) {
  const range = rangeArgs(args)
  if (range.error) return { ok: false, reason: 'bad_args', hint: range.error }

  const rows = db
    .prepare(
      `SELECT r.day, t.tag_type, t.content FROM record_tags t
       JOIN records r ON r.id = t.record_id
       WHERE t.user_id = ? AND r.day >= ? AND r.day <= ?
       ORDER BY r.day ASC, t.id ASC`
    )
    .all(userId, range.start, range.end)

  const total = rows.length
  const items = rows.slice(0, MAX_ITEMS).map((r) => ({
    day: r.day,
    kind: r.tag_type,
    content: String(r.content || '').slice(0, 60)
  }))

  const out = { ok: true, start: range.start, end: range.end, total, returned: items.length, items }
  if (total > MAX_ITEMS) out.hint = `共 ${total} 条，只返回最早 ${MAX_ITEMS} 条。请缩小范围。`
  return out
}

/**
 * 执行一个工具调用，返回可以直接塞进 role:"tool" 的字符串。
 * 结果过大时不返回半截数据，而是返回一个提示对象。
 */
export function executeTool(name, args, userId) {
  let data
  try {
    if (name === 'get_days') data = getDays(userId, args)
    else if (name === 'get_tags') data = getTags(userId, args)
    else data = { ok: false, reason: 'unknown_tool', hint: '没有这个工具' }
  } catch (err) {
    data = { ok: false, reason: 'tool_error', hint: err.message }
  }

  const text = JSON.stringify(data)
  if (text.length > MAX_RESULT_CHARS) {
    return JSON.stringify({
      ok: false,
      reason: 'result_too_large',
      approxChars: text.length,
      hint: '结果过大。请把日期范围缩小到 7 天以内再查询。'
    })
  }
  return text
}
