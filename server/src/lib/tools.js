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
  },
  {
    type: 'function',
    function: {
      name: 'get_record',
      description: '读取某一条记录的完整内容（含未截断的理由）。当 get_days 返回 noteTruncated 时用它取全文。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: '记录编号，来自 get_days 返回的 id' }
        },
        required: ['id']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_report',
      description:
        '读取过往 AI 分析报告。不传 id 时返回最近的报告列表（编号、类型、周期、开头摘要）；传 id 时返回该报告全文。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: '报告编号；省略则列出最近报告' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'propose_fact',
      description:
        '提议把一条关于用户的长期事实写入记忆。只是待确认建议，不会立即生效；用户确认后才会保存。',
      parameters: {
        type: 'object',
        properties: {
          content: { type: 'string', description: '事实内容，1-500 字，用陈述句' },
          confidence: { type: 'integer', description: '置信度 1-5，默认 3' }
        },
        required: ['content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'propose_tag',
      description:
        '提议给某一条情绪记录添加标签（洞察/建议/模式/纠正）。只是待确认建议，用户确认后才会写入。recordId 必须来自 get_days 或 get_record。',
      parameters: {
        type: 'object',
        properties: {
          recordId: { type: 'integer', description: '记录编号' },
          tagType: {
            type: 'string',
            enum: ['insight', 'suggestion', 'pattern', 'correction'],
            description: '标签类型'
          },
          content: { type: 'string', description: '标签内容，1-500 字' }
        },
        required: ['recordId', 'tagType', 'content']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'propose_report',
      description:
        '提议生成一份单人 AI 分析报告。只是待确认建议，用户确认后由前端触发生成。periodType 为 week 或 month；也可以同时给 start/end 指定自定义区间。',
      parameters: {
        type: 'object',
        properties: {
          periodType: { type: 'string', enum: ['week', 'month'], description: '周期类型' },
          start: { type: 'string', description: '自定义起始日期 YYYY-MM-DD，可选' },
          end: { type: 'string', description: '自定义结束日期 YYYY-MM-DD，可选' }
        },
        required: ['periodType']
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

function getRecord(userId, args) {
  const id = Number(args?.id)
  if (!Number.isInteger(id) || id <= 0) {
    return { ok: false, reason: 'bad_args', hint: 'id 需要是正整数' }
  }
  const r = db
    .prepare('SELECT id, day, score, original_score, note, adjusted_at FROM records WHERE id = ? AND user_id = ?')
    .get(id, userId)
  if (!r) return { ok: false, reason: 'not_found', hint: '没有找到这条记录' }

  const item = { id: r.id, day: r.day, score: r.score, note: String(r.note || '') }
  if (r.original_score != null) item.originalScore = r.original_score
  if (r.adjusted_at) item.adjustedAt = r.adjusted_at
  return { ok: true, item }
}

function getReport(userId, args) {
  const id = Number(args?.id)
  // couple_key 是 "小id|大id"，用两端匹配确保只能读自己参与的双人报告
  const coupleLikeA = `%|${userId}`
  const coupleLikeB = `${userId}|%`
  if (Number.isInteger(id) && id > 0) {
    const r = db
      .prepare(
        `SELECT id, scope, period_type, period_start, period_end, content, generated_at FROM insights
         WHERE id = ? AND (user_id = ? OR couple_key LIKE ? OR couple_key LIKE ?)`
      )
      .get(id, userId, coupleLikeA, coupleLikeB)
    if (!r) return { ok: false, reason: 'not_found', hint: '没有找到这份报告' }
    return {
      ok: true,
      report: {
        id: r.id,
        scope: r.scope,
        periodType: r.period_type,
        periodStart: r.period_start,
        periodEnd: r.period_end,
        generatedAt: r.generated_at,
        content: String(r.content || '')
      }
    }
  }

  const rows = db
    .prepare(
      `SELECT id, scope, period_type, period_start, period_end, content, generated_at
       FROM insights WHERE user_id = ? OR couple_key LIKE ? OR couple_key LIKE ?
       ORDER BY period_start DESC, id DESC LIMIT 5`
    )
    .all(userId, coupleLikeA, coupleLikeB)

  return {
    ok: true,
    total: rows.length,
    items: rows.map((r) => ({
      id: r.id,
      scope: r.scope,
      periodType: r.period_type,
      periodStart: r.period_start,
      periodEnd: r.period_end,
      generatedAt: r.generated_at,
      preview: String(r.content || '').replace(/\s+/g, ' ').slice(0, 120)
    })),
    hint: '需要全文请再用 get_report 并传入 id'
  }
}

// ======== 写入提议 ========
// 模型只创建待确认提议，真正落库在 routes/proposals.js

const TAG_TYPES = ['insight', 'suggestion', 'pattern', 'correction']
const MAX_PROPOSALS_PER_TURN = 3

function normText(input, max) {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed || trimmed.length > max) return null
  return trimmed
}

function payloadKey(kind, payload) {
  if (kind === 'fact') return JSON.stringify([kind, payload.content, payload.confidence])
  if (kind === 'tag') return JSON.stringify([kind, payload.recordId, payload.tagType, payload.content])
  return JSON.stringify([kind, payload.periodType, payload.start, payload.end])
}

function findPendingProposal(sessionId, kind, key) {
  const rows = db
    .prepare('SELECT id, payload FROM chat_proposals WHERE session_id = ? AND kind = ? AND status = ?')
    .all(sessionId, kind, 'pending')
  for (const row of rows) {
    let payload
    try {
      payload = JSON.parse(row.payload)
    } catch {
      continue
    }
    if (payloadKey(kind, payload) === key) return row.id
  }
  return null
}

function insertProposal(ctx, kind, payload) {
  const existing = findPendingProposal(ctx.sessionId, kind, payloadKey(kind, payload))
  if (existing) {
    return {
      ok: true,
      proposalId: existing,
      status: 'pending',
      duplicate: true,
      hint: '同样的建议已经在等待用户确认，不要重复提交。'
    }
  }
  if (ctx.run.proposalIds.length >= MAX_PROPOSALS_PER_TURN) {
    return { ok: false, reason: 'too_many_proposals', hint: '一轮最多提出 3 条建议，等用户处理完再说。' }
  }
  const info = db
    .prepare('INSERT INTO chat_proposals (user_id, session_id, kind, payload, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(ctx.userId, ctx.sessionId, kind, JSON.stringify(payload), new Date().toISOString())
  ctx.run.proposalIds.push(info.lastInsertRowid)
  return { ok: true, proposalId: info.lastInsertRowid, status: 'pending', hint: '已提交给用户确认，尚未写入。' }
}

function proposeFact(ctx, args) {
  const content = normText(args?.content, 500)
  if (!content) return { ok: false, reason: 'bad_args', hint: '事实内容需为 1-500 字的文本' }

  const confidence = Number(args?.confidence)
  const conf = Number.isInteger(confidence) && confidence >= 1 && confidence <= 5 ? confidence : 3

  const dup = db.prepare('SELECT id FROM facts WHERE user_id = ? AND content = ?').get(ctx.userId, content)
  if (dup) {
    return { ok: false, reason: 'already_exists', factId: dup.id, hint: '这条事实已经在记忆里了，不需要再提。' }
  }
  return insertProposal(ctx, 'fact', { content, confidence: conf })
}

function proposeTag(ctx, args) {
  const recordId = Number(args?.recordId)
  if (!Number.isInteger(recordId) || recordId <= 0) {
    return { ok: false, reason: 'bad_args', hint: 'recordId 需要是正整数' }
  }
  const record = db.prepare('SELECT id, day FROM records WHERE id = ? AND user_id = ?').get(recordId, ctx.userId)
  if (!record) {
    return { ok: false, reason: 'not_found', hint: '没有找到这条记录，recordId 必须来自 get_days 或 get_record。' }
  }
  const tagType = TAG_TYPES.includes(args?.tagType) ? args.tagType : null
  if (!tagType) {
    return { ok: false, reason: 'bad_args', hint: 'tagType 必须是 insight/suggestion/pattern/correction 之一' }
  }
  const content = normText(args?.content, 500)
  if (!content) return { ok: false, reason: 'bad_args', hint: '标签内容需为 1-500 字的文本' }

  return insertProposal(ctx, 'tag', { recordId, recordDay: record.day, tagType, content })
}

function proposeReport(ctx, args) {
  const periodType = args?.periodType === 'week' ? 'week' : args?.periodType === 'month' ? 'month' : null
  if (!periodType) return { ok: false, reason: 'bad_args', hint: 'periodType 只能是 week 或 month' }

  const start = args?.start ? String(args.start) : null
  const end = args?.end ? String(args.end) : null
  if ((start && !end) || (!start && end)) {
    return { ok: false, reason: 'bad_args', hint: 'start 和 end 需要同时提供' }
  }
  if (start) {
    if (!isDay(start) || !isDay(end)) return { ok: false, reason: 'bad_args', hint: '日期格式应为 YYYY-MM-DD' }
    if (start > end) return { ok: false, reason: 'bad_args', hint: '起始日期不能晚于结束日期' }
    if (dayDiff(start, end) > 366) return { ok: false, reason: 'bad_args', hint: '报告区间不能超过 366 天' }
  }
  if (ctx.run.reportCount >= 1) {
    return { ok: false, reason: 'too_many_proposals', hint: '一轮最多提议一份报告。' }
  }

  const result = insertProposal(ctx, 'report', { periodType, start, end })
  if (result.ok && !result.duplicate) ctx.run.reportCount += 1
  return result
}

/**
 * 执行一个工具调用，返回可以直接塞进 role:"tool" 的字符串。
 * 结果过大时不返回半截数据，而是返回一个提示对象。
 * ctx 可以是 userId（读工具兼容旧调用），也可以是 { userId, sessionId, run }。
 */
export function executeTool(name, args, ctx) {
  const isContext = ctx && typeof ctx === 'object'
  const userId = isContext ? ctx.userId : ctx
  let data
  try {
    if (name === 'get_days') data = getDays(userId, args)
    else if (name === 'get_tags') data = getTags(userId, args)
    else if (name === 'get_record') data = getRecord(userId, args)
    else if (name === 'get_report') data = getReport(userId, args)
    else if (name === 'propose_fact' || name === 'propose_tag' || name === 'propose_report') {
      if (!isContext || !ctx.sessionId || !ctx.run) {
        data = { ok: false, reason: 'no_session', hint: '写入建议只能出现在对话里' }
      } else if (name === 'propose_fact') data = proposeFact(ctx, args)
      else if (name === 'propose_tag') data = proposeTag(ctx, args)
      else data = proposeReport(ctx, args)
    } else data = { ok: false, reason: 'unknown_tool', hint: '没有这个工具' }
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
