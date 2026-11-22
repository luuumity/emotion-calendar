// 聊天可用的内置工具（客户端 function calling）
// 约定：返回值永远是合法 JSON；超过 MAX_RESULT_CHARS 时不返回半截数据，而是返回提示让模型缩小范围

import { db } from '../db.js'

const MAX_RESULT_CHARS = 6000   // 单次结果字符上限（约 4000 token）
const MAX_SPAN_DAYS = 90        // 明细类查询的时间跨度上限
const MAX_STATS_SPAN_DAYS = 1826 // 聚合统计的上限：5 年
const MAX_ITEMS = 60
const NOTE_PREVIEW = 200
const DEFAULT_LIMIT = 20

function isDay(s) {
  if (typeof s !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

function shanghaiToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function dayDiff(a, b) {
  const ms = new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)
  return Math.round(ms / 86400000)
}

function rangeArgs(args, maxSpan = MAX_SPAN_DAYS) {
  const start = String(args?.start || '')
  const end = String(args?.end || '')
  if (!isDay(start) || !isDay(end)) return { error: '日期格式应为 YYYY-MM-DD' }
  if (start > end) return { error: '起始日期不能晚于结束日期' }
  const span = dayDiff(start, end)
  if (span > maxSpan) {
    return { error: `时间跨度为 ${span} 天，超过 ${maxSpan} 天上限。请缩小范围后分次查询。` }
  }
  return { start, end }
}

function pageArgs(args, maxLimit) {
  const rawLimit = args?.limit
  const rawOffset = args?.offset
  let limit = DEFAULT_LIMIT
  if (rawLimit !== undefined && rawLimit !== null) {
    limit = Number(rawLimit)
    if (!Number.isInteger(limit) || limit < 1 || limit > maxLimit) {
      return { error: `limit 需要是 1 到 ${maxLimit} 之间的整数` }
    }
  }
  let offset = 0
  if (rawOffset !== undefined && rawOffset !== null) {
    offset = Number(rawOffset)
    if (!Number.isInteger(offset) || offset < 0) {
      return { error: 'offset 需要是不小于 0 的整数' }
    }
  }
  return { limit, offset }
}

function pageMeta(total, offset, returned) {
  const next = offset + returned
  return { total, returned, nextOffset: next < total ? next : null }
}

function escapeLike(s) {
  return String(s).replace(/[\\%_]/g, (m) => '\\' + m)
}

function round1(n) {
  return Math.round(n * 10) / 10
}

function round2(n) {
  return Math.round(n * 100) / 100
}

function statsPeriod(day, granularity) {
  if (granularity === 'day') return day
  if (granularity === 'month') return day.slice(0, 7)
  // 周：以周一为起点
  const d = new Date(`${day}T00:00:00Z`)
  const dow = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() - (dow - 1))
  return d.toISOString().slice(0, 10)
}

function makeSnippet(note, query, max = 120) {
  const text = String(note || '').replace(/\s+/g, ' ').trim()
  if (!text) return ''
  const idx = text.toLowerCase().indexOf(String(query).toLowerCase())
  if (idx < 0) return text.length > max ? text.slice(0, max) + '…' : text
  let start = Math.max(0, idx - 40)
  let end = Math.min(text.length, start + max)
  if (end === text.length) start = Math.max(0, end - max)
  return `${start > 0 ? '…' : ''}${text.slice(start, end)}${end < text.length ? '…' : ''}`
}

export const FUNCTION_TOOLS = [
  {
    type: 'function',
    function: {
      name: 'get_days',
      description:
        '读取指定日期范围内的情绪记录。返回 total/returned/nextOffset/items；还有更多时用 nextOffset 作为下一次的 offset。默认返回理由摘要和标签；includeNotes=false 时只返回 id/day/indexInDay/score/originalScore，适合长区间扫描。需要单条完整理由时用 get_record。单次跨度不能超过 90 天。',
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'string', description: '起始日期，YYYY-MM-DD（包含）' },
          end: { type: 'string', description: '结束日期，YYYY-MM-DD（包含）' },
          includeNotes: {
            type: 'boolean',
            description: '是否返回理由摘要和标签，默认 true。设为 false 时只返回核心分值字段，用于快速扫描长区间。'
          },
          limit: { type: 'integer', description: '本页条数，默认 20，最大 60' },
          offset: { type: 'integer', description: '跳过多少条，默认 0；通常传上一页的 nextOffset' }
        },
        required: ['start', 'end']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_tags',
      description:
        '读取指定日期范围内 AI 为记录生成的标签（洞察、建议、模式、纠正）。列表内容截断到 60 字，返回 id/recordId/contentTruncated；需要全文时传 id（此时忽略日期和分页）。单次跨度不能超过 90 天。',
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'string', description: '起始日期，YYYY-MM-DD（包含）' },
          end: { type: 'string', description: '结束日期，YYYY-MM-DD（包含）' },
          id: { type: 'integer', description: '标签编号；传了就返回这一条标签的完整内容' },
          limit: { type: 'integer', description: '本页条数，默认 20，最大 60' },
          offset: { type: 'integer', description: '跳过多少条，默认 0；通常传上一页的 nextOffset' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_record',
      description:
        '读取某一条记录的完整内容（含未截断的理由，indexInDay 表示当天第几颗）。当输入里某条理由被截断、或只显示了日期和 #编号时，用这个编号取全文。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: '记录编号，来自输入里的 #编号' }
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
        '读取过往 AI 分析报告。不传 id 时返回报告列表（编号、类型、周期、开头摘要），返回 total/returned/nextOffset，可用 limit/offset 翻页；传 id 时返回该报告全文。输入里历史报告摘要被截断并带 #编号时，用这个编号取全文。',
      parameters: {
        type: 'object',
        properties: {
          id: { type: 'integer', description: '报告编号；省略则列出报告' },
          limit: { type: 'integer', description: '本页条数，默认 20，最大 20' },
          offset: { type: 'integer', description: '跳过多少条，默认 0；通常传上一页的 nextOffset' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_range_stats',
      description:
        '读取一段时间的情绪聚合统计，适合先看长期趋势。自动按跨度选择粒度（≤31 天按天、≤180 天按周、更长按月），返回总量、时间序列、最低/最高记录、标签计数和理由覆盖率。单次跨度不能超过 5 年。',
      parameters: {
        type: 'object',
        properties: {
          start: { type: 'string', description: '起始日期，YYYY-MM-DD（包含）' },
          end: { type: 'string', description: '结束日期，YYYY-MM-DD（包含）' }
        },
        required: ['start', 'end']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'get_facts',
      description:
        '读取用户的长期事实。预注入只包含前 30 条；需要查看或搜索更多事实时使用。返回 total/returned/nextOffset/items。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '可选关键词，1-50 字；按内容子串匹配' },
          limit: { type: 'integer', description: '本页条数，默认 20，最大 100' },
          offset: { type: 'integer', description: '跳过多少条，默认 0；通常传上一页的 nextOffset' }
        }
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'search_records',
      description:
        '在理由中搜索关键词，返回匹配记录和上下文片段。适合定位某件事发生在哪几天。不传日期则搜索全部历史；返回 total/returned/nextOffset/items。',
      parameters: {
        type: 'object',
        properties: {
          query: { type: 'string', description: '搜索关键词，1-50 字' },
          start: { type: 'string', description: '可选起始日期，YYYY-MM-DD（包含）' },
          end: { type: 'string', description: '可选结束日期，YYYY-MM-DD（包含）' },
          limit: { type: 'integer', description: '本页条数，默认 20，最大 50' },
          offset: { type: 'integer', description: '跳过多少条，默认 0；通常传上一页的 nextOffset' }
        },
        required: ['query']
      }
    }
  },
  {
    type: 'function',
    function: {
      name: 'propose_fact',
      description:
        '提议把一条关于用户的长期事实写入记忆。只是待确认建议，不会立即生效；用户确认后才会保存。只能新增，不能修改或删除已有事实。',
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
        '提议给某一条情绪记录添加标签（洞察/建议/模式/纠正）。只是待确认建议，用户确认后才会写入。每条记录最多一个 AI 标签：如果该记录已有 AI 标签，这次提议会替换它；用户手动添加的标签不会被覆盖。recordId 必须来自 get_days 或 get_record，只作为内部参数，回复用户时不要念编号，用「某天第几颗」描述。',
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
        '提议生成一份单人 AI 分析报告。只是待确认建议，用户确认后由前端触发生成。periodType 为 week 或 month；也可以同时给 start/end 指定自定义区间。只生成新报告，不修改已有报告。',
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
  },
  {
    type: 'function',
    function: {
      name: 'propose_record',
      description:
        '提议新增一颗情绪球（某一天的记录）。只是待确认建议，用户确认后才写入。日期和分值必须由用户明确给出，缺少分值先问用户，不要猜。日期不能是未来。只能新增，不能修改或删除已有记录。',
      parameters: {
        type: 'object',
        properties: {
          day: { type: 'string', description: '日期 YYYY-MM-DD，不能晚于今天' },
          score: { type: 'integer', description: '感受值 0-100 的整数，必须来自用户' },
          note: { type: 'string', description: '理由，可选，最多 2000 字；可以基于用户的话总结' }
        },
        required: ['day', 'score']
      }
    }
  }
]

// 报告生成只开放回读具体内容的两个工具
export const REPORT_FUNCTION_TOOLS = FUNCTION_TOOLS.filter((tool) =>
  ['get_record', 'get_report'].includes(tool.function?.name)
)

function getDays(userId, args) {
  const range = rangeArgs(args)
  if (range.error) return { ok: false, reason: 'bad_args', hint: range.error }
  const page = pageArgs(args, MAX_ITEMS)
  if (page.error) return { ok: false, reason: 'bad_args', hint: page.error }
  const includeNotes = args?.includeNotes !== false

  const total = db
    .prepare('SELECT COUNT(*) AS c FROM records WHERE user_id = ? AND day >= ? AND day <= ?')
    .get(userId, range.start, range.end).c

  const rows = db
    .prepare(
      `SELECT r.id, r.day, r.score, r.original_score, r.note,
         (SELECT COUNT(*) FROM records r2
          WHERE r2.user_id = r.user_id AND r2.day = r.day AND r2.id <= r.id) AS index_in_day
       FROM records r
       WHERE r.user_id = ? AND r.day >= ? AND r.day <= ?
       ORDER BY r.day ASC, r.id ASC
       LIMIT ? OFFSET ?`
    )
    .all(userId, range.start, range.end, page.limit, page.offset)

  const tagsByRecord = {}
  if (includeNotes && rows.length) {
    const ids = rows.map((r) => r.id)
    const placeholders = ids.map(() => '?').join(',')
    const tags = db
      .prepare(
        `SELECT record_id, tag_type, content FROM record_tags
         WHERE user_id = ? AND record_id IN (${placeholders})
         ORDER BY id ASC`
      )
      .all(userId, ...ids)
    for (const t of tags) {
      const content = String(t.content || '')
      tagsByRecord[t.record_id] = {
        tagType: t.tag_type,
        content: content.slice(0, 20),
        contentTruncated: content.length > 20
      }
    }
  }

  const items = rows.map((r) => {
    const item = { id: r.id, day: r.day, indexInDay: r.index_in_day, score: r.score }
    if (r.original_score != null) item.originalScore = r.original_score
    if (includeNotes) {
      const note = String(r.note || '').replace(/\s+/g, ' ').trim()
      if (note) {
        item.note = note.slice(0, NOTE_PREVIEW)
        if (note.length > NOTE_PREVIEW) item.noteTruncated = true
      }
      if (tagsByRecord[r.id]) item.tag = tagsByRecord[r.id]
    }
    return item
  })

  return {
    ok: true,
    start: range.start,
    end: range.end,
    includeNotes,
    ...pageMeta(total, page.offset, items.length),
    items
  }
}

function getTags(userId, args) {
  if (args?.id !== undefined && args?.id !== null) {
    const id = Number(args.id)
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false, reason: 'bad_args', hint: 'id 需要是正整数' }
    }
    const row = db
      .prepare(
        `SELECT t.id, t.record_id, r.day, t.tag_type, t.content
         FROM record_tags t JOIN records r ON r.id = t.record_id
         WHERE t.id = ? AND t.user_id = ?`
      )
      .get(id, userId)
    if (!row) return { ok: false, reason: 'not_found', hint: '没有找到这条标签' }
    return {
      ok: true,
      item: {
        id: row.id,
        recordId: row.record_id,
        day: row.day,
        tagType: row.tag_type,
        content: String(row.content || '')
      }
    }
  }

  const range = rangeArgs(args)
  if (range.error) return { ok: false, reason: 'bad_args', hint: range.error }
  const page = pageArgs(args, MAX_ITEMS)
  if (page.error) return { ok: false, reason: 'bad_args', hint: page.error }

  const total = db
    .prepare(
      `SELECT COUNT(*) AS c FROM record_tags t
       JOIN records r ON r.id = t.record_id
       WHERE t.user_id = ? AND r.day >= ? AND r.day <= ?`
    )
    .get(userId, range.start, range.end).c

  const rows = db
    .prepare(
      `SELECT t.id, t.record_id, r.day, t.tag_type, t.content
       FROM record_tags t
       JOIN records r ON r.id = t.record_id
       WHERE t.user_id = ? AND r.day >= ? AND r.day <= ?
       ORDER BY r.day ASC, t.id ASC
       LIMIT ? OFFSET ?`
    )
    .all(userId, range.start, range.end, page.limit, page.offset)

  const items = rows.map((r) => {
    const content = String(r.content || '')
    return {
      id: r.id,
      recordId: r.record_id,
      day: r.day,
      tagType: r.tag_type,
      content: content.slice(0, 60),
      contentTruncated: content.length > 60
    }
  })

  return {
    ok: true,
    start: range.start,
    end: range.end,
    ...pageMeta(total, page.offset, items.length),
    items
  }
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

  const indexInDay = db
    .prepare('SELECT COUNT(*) AS c FROM records WHERE user_id = ? AND day = ? AND id <= ?')
    .get(userId, r.day, r.id).c
  const item = { id: r.id, day: r.day, indexInDay, score: r.score, note: String(r.note || '') }
  if (r.original_score != null) item.originalScore = r.original_score
  if (r.adjusted_at) item.adjustedAt = r.adjusted_at
  const tag = db
    .prepare('SELECT tag_type, content FROM record_tags WHERE record_id = ? AND user_id = ?')
    .get(r.id, userId)
  if (tag) item.tag = { tagType: tag.tag_type, content: String(tag.content || '') }
  return { ok: true, item }
}

function getReport(userId, args) {
  const id = Number(args?.id)
  // couple_key 是 "小id|大id"，用两端匹配确保只能读自己参与的双人报告
  const coupleLikeA = `%|${userId}`
  const coupleLikeB = `${userId}|%`
  if (args?.id !== undefined && args?.id !== null) {
    if (!Number.isInteger(id) || id <= 0) {
      return { ok: false, reason: 'bad_args', hint: 'id 需要是正整数' }
    }
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

  const page = pageArgs(args, 20)
  if (page.error) return { ok: false, reason: 'bad_args', hint: page.error }

  const where = 'user_id = ? OR couple_key LIKE ? OR couple_key LIKE ?'
  const params = [userId, coupleLikeA, coupleLikeB]
  const total = db.prepare(`SELECT COUNT(*) AS c FROM insights WHERE ${where}`).get(...params).c
  const rows = db
    .prepare(
      `SELECT id, scope, period_type, period_start, period_end, content, generated_at
       FROM insights WHERE ${where}
       ORDER BY period_start DESC, id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, page.limit, page.offset)

  return {
    ok: true,
    ...pageMeta(total, page.offset, rows.length),
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

function getRangeStats(userId, args) {
  const range = rangeArgs(args, MAX_STATS_SPAN_DAYS)
  if (range.error) return { ok: false, reason: 'bad_args', hint: range.error }

  const rows = db
    .prepare(
      `SELECT id, day, score, note FROM records
       WHERE user_id = ? AND day >= ? AND day <= ?
       ORDER BY day ASC, id ASC`
    )
    .all(userId, range.start, range.end)

  const span = dayDiff(range.start, range.end)
  const granularity = span <= 31 ? 'day' : span <= 180 ? 'week' : 'month'

  const tagCounts = { insight: 0, suggestion: 0, pattern: 0, correction: 0 }
  const tagRows = db
    .prepare(
      `SELECT t.tag_type, COUNT(*) AS c FROM record_tags t
       JOIN records r ON r.id = t.record_id
       WHERE t.user_id = ? AND r.day >= ? AND r.day <= ?
       GROUP BY t.tag_type`
    )
    .all(userId, range.start, range.end)
  for (const row of tagRows) {
    if (row.tag_type in tagCounts) tagCounts[row.tag_type] = row.c
  }

  if (!rows.length) {
    return {
      ok: true,
      start: range.start,
      end: range.end,
      granularity,
      firstDay: null,
      lastDay: null,
      recordCount: 0,
      recordedDays: 0,
      avg: null,
      min: null,
      max: null,
      series: [],
      lowestRecords: [],
      highestRecords: [],
      tagCounts,
      notedRecordCount: 0,
      noteCoverage: 0
    }
  }

  const days = new Set()
  const buckets = new Map()
  let sum = 0
  let min = Infinity
  let max = -Infinity
  let notedRecordCount = 0

  for (const r of rows) {
    days.add(r.day)
    sum += r.score
    if (r.score < min) min = r.score
    if (r.score > max) max = r.score
    if (String(r.note || '').trim()) notedRecordCount += 1

    const period = statsPeriod(r.day, granularity)
    let b = buckets.get(period)
    if (!b) {
      b = { recordCount: 0, days: new Set(), sum: 0, min: r.score, max: r.score }
      buckets.set(period, b)
    }
    b.recordCount += 1
    b.days.add(r.day)
    b.sum += r.score
    if (r.score < b.min) b.min = r.score
    if (r.score > b.max) b.max = r.score
  }

  const series = [...buckets.entries()]
    .sort((a, b) => a[0].localeCompare(b[0]))
    .map(([period, b]) => ({
      period,
      recordCount: b.recordCount,
      recordedDays: b.days.size,
      avg: round1(b.sum / b.recordCount),
      min: b.min,
      max: b.max
    }))

  const lowestRecords = [...rows]
    .sort((a, b) => a.score - b.score || a.day.localeCompare(b.day) || a.id - b.id)
    .slice(0, 5)
    .map((r) => ({ id: r.id, day: r.day, score: r.score }))
  const highestRecords = [...rows]
    .sort((a, b) => b.score - a.score || b.day.localeCompare(a.day) || b.id - a.id)
    .slice(0, 5)
    .map((r) => ({ id: r.id, day: r.day, score: r.score }))

  return {
    ok: true,
    start: range.start,
    end: range.end,
    granularity,
    firstDay: rows[0].day,
    lastDay: rows[rows.length - 1].day,
    recordCount: rows.length,
    recordedDays: days.size,
    avg: round1(sum / rows.length),
    min,
    max,
    series,
    lowestRecords,
    highestRecords,
    tagCounts,
    notedRecordCount,
    noteCoverage: round2(notedRecordCount / rows.length)
  }
}

function getFacts(userId, args) {
  const page = pageArgs(args, 100)
  if (page.error) return { ok: false, reason: 'bad_args', hint: page.error }

  let query = null
  if (args?.query !== undefined && args?.query !== null) {
    query = String(args.query).trim()
    if (!query || query.length > 50) {
      return { ok: false, reason: 'bad_args', hint: 'query 需要是 1 到 50 个字符' }
    }
  }

  const where = query ? `user_id = ? AND content LIKE ? ESCAPE '\\'` : 'user_id = ?'
  const params = query ? [userId, `%${escapeLike(query)}%`] : [userId]
  const total = db.prepare(`SELECT COUNT(*) AS c FROM facts WHERE ${where}`).get(...params).c
  const rows = db
    .prepare(
      `SELECT id, content, confidence, pinned FROM facts
       WHERE ${where}
       ORDER BY pinned DESC, confidence DESC, id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, page.limit, page.offset)

  const out = {
    ok: true,
    ...pageMeta(total, page.offset, rows.length),
    items: rows.map((r) => ({
      id: r.id,
      content: String(r.content || ''),
      confidence: r.confidence,
      pinned: Boolean(r.pinned)
    }))
  }
  if (query) out.query = query
  return out
}

function searchRecords(userId, args) {
  const query = String(args?.query ?? '').trim()
  if (!query || query.length > 50) {
    return { ok: false, reason: 'bad_args', hint: 'query 需要是 1 到 50 个字符' }
  }

  const hasStart = args?.start !== undefined && args?.start !== null && String(args.start).trim() !== ''
  const hasEnd = args?.end !== undefined && args?.end !== null && String(args.end).trim() !== ''
  if (hasStart !== hasEnd) {
    return { ok: false, reason: 'bad_args', hint: 'start 和 end 需要同时提供，或都不提供' }
  }

  let start = null
  let end = null
  if (hasStart) {
    const range = rangeArgs(args, 3650)
    if (range.error) return { ok: false, reason: 'bad_args', hint: range.error }
    start = range.start
    end = range.end
  }

  const page = pageArgs(args, 50)
  if (page.error) return { ok: false, reason: 'bad_args', hint: page.error }

  const clauses = ['user_id = ?', `note LIKE ? ESCAPE '\\'`]
  const params = [userId, `%${escapeLike(query)}%`]
  if (hasStart) {
    clauses.push('day >= ? AND day <= ?')
    params.push(start, end)
  }
  const where = clauses.join(' AND ')

  const total = db.prepare(`SELECT COUNT(*) AS c FROM records WHERE ${where}`).get(...params).c
  const rows = db
    .prepare(
      `SELECT id, day, score, note FROM records
       WHERE ${where}
       ORDER BY day DESC, id DESC
       LIMIT ? OFFSET ?`
    )
    .all(...params, page.limit, page.offset)

  const out = {
    ok: true,
    query,
    ...pageMeta(total, page.offset, rows.length),
    items: rows.map((r) => ({
      id: r.id,
      day: r.day,
      score: r.score,
      snippet: makeSnippet(r.note, query)
    }))
  }
  if (hasStart) {
    out.start = start
    out.end = end
  }
  return out
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
  if (kind === 'record') return JSON.stringify([kind, payload.day, payload.score, payload.note])
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
  const record = db.prepare('SELECT id, day, score FROM records WHERE id = ? AND user_id = ?').get(recordId, ctx.userId)
  if (!record) {
    return { ok: false, reason: 'not_found', hint: '没有找到这条记录，recordId 必须来自 get_days 或 get_record。' }
  }
  const tagType = TAG_TYPES.includes(args?.tagType) ? args.tagType : null
  if (!tagType) {
    return { ok: false, reason: 'bad_args', hint: 'tagType 必须是 insight/suggestion/pattern/correction 之一' }
  }
  const content = normText(args?.content, 500)
  if (!content) return { ok: false, reason: 'bad_args', hint: '标签内容需为 1-500 字的文本' }

  const existing = db
    .prepare('SELECT id, tag_type, content, source FROM record_tags WHERE record_id = ? AND user_id = ?')
    .get(recordId, ctx.userId)
  if (existing) {
    if (existing.source === 'user') {
      return {
        ok: false,
        reason: 'user_tag_exists',
        hint: '这颗球已经有用户手动添加的标签，AI 标签不能覆盖它。'
      }
    }
    if (existing.tag_type === tagType && existing.content === content) {
      return { ok: false, reason: 'already_exists', tagId: existing.id, hint: '这条记录已经有同样的标签了，不需要再提。' }
    }
  }

  const recordIndex = db
    .prepare('SELECT COUNT(*) AS c FROM records WHERE user_id = ? AND day = ? AND id <= ?')
    .get(ctx.userId, record.day, recordId).c

  const payload = {
    recordId,
    recordDay: record.day,
    recordIndex,
    recordScore: record.score,
    tagType,
    content
  }
  const previousTag = existing ? { tagType: existing.tag_type, content: existing.content } : null
  const action = existing ? 'update' : 'create'

  // 同一颗球只保留一条待确认标签：用新内容替换旧的待确认提议
  const pendings = db
    .prepare(`SELECT id, payload FROM chat_proposals WHERE session_id = ? AND kind = 'tag' AND status = 'pending'`)
    .all(ctx.sessionId)
  for (const p of pendings) {
    let parsed
    try {
      parsed = JSON.parse(p.payload)
    } catch {
      continue
    }
    if (Number(parsed?.recordId) !== recordId) continue
    db.prepare('UPDATE chat_proposals SET payload = ?, created_at = ? WHERE id = ?').run(
      JSON.stringify(payload),
      new Date().toISOString(),
      p.id
    )
    return {
      ok: true,
      proposalId: p.id,
      status: 'pending',
      replacedPrevious: true,
      action,
      previousTag,
      hint: '已更新这颗球的待确认标签，会替换之前的内容。'
    }
  }

  const result = insertProposal(ctx, 'tag', payload)
  return { ...result, action, previousTag }
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

function proposeRecord(ctx, args) {
  const day = String(args?.day || '')
  if (!isDay(day)) return { ok: false, reason: 'bad_args', hint: 'day 需要是 YYYY-MM-DD' }
  if (day > shanghaiToday()) {
    return { ok: false, reason: 'bad_args', hint: '不能创建未来日期的记录' }
  }

  // 只接受数字或纯数字字符串；null / '' / 布尔 / 数组不能悄悄变成 0
  let score = null
  if (typeof args?.score === 'number') score = args.score
  else if (typeof args?.score === 'string' && /^\d+$/.test(args.score.trim())) score = Number(args.score.trim())
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    return { ok: false, reason: 'bad_args', hint: 'score 需要是 0-100 的整数，并且必须来自用户' }
  }

  if (args?.note !== undefined && args?.note !== null && typeof args.note !== 'string') {
    return { ok: false, reason: 'bad_args', hint: 'note 需要是文本' }
  }
  const note = typeof args?.note === 'string' ? args.note.trim() : ''
  if (note.length > 2000) return { ok: false, reason: 'bad_args', hint: '理由不能超过 2000 字' }

  return insertProposal(ctx, 'record', { day, score, note })
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
    else if (name === 'get_range_stats') data = getRangeStats(userId, args)
    else if (name === 'get_facts') data = getFacts(userId, args)
    else if (name === 'search_records') data = searchRecords(userId, args)
    else if (
      name === 'propose_fact' ||
      name === 'propose_tag' ||
      name === 'propose_report' ||
      name === 'propose_record'
    ) {
      if (!isContext || !ctx.sessionId || !ctx.run) {
        data = { ok: false, reason: 'no_session', hint: '写入建议只能出现在对话里' }
      } else if (name === 'propose_fact') data = proposeFact(ctx, args)
      else if (name === 'propose_tag') data = proposeTag(ctx, args)
      else if (name === 'propose_report') data = proposeReport(ctx, args)
      else data = proposeRecord(ctx, args)
    } else data = { ok: false, reason: 'unknown_tool', hint: '没有这个工具' }
  } catch (err) {
    data = { ok: false, reason: 'tool_error', hint: err.message }
  }

  const text = JSON.stringify(data)
  if (text.length > MAX_RESULT_CHARS) {
    const hints = {
      get_days: '结果过大。请减小 limit，或把 includeNotes 设为 false，或缩小日期范围。',
      get_tags: '结果过大。请减小 limit 或缩小日期范围。',
      get_report: '结果过大。请减小 limit。',
      get_facts: '结果过大。请减小 limit 或提供更具体的 query。',
      search_records: '结果过大。请减小 limit 或缩小日期范围。',
      get_range_stats: '结果过大。请缩短日期范围。'
    }
    return JSON.stringify({
      ok: false,
      reason: 'result_too_large',
      approxChars: text.length,
      hint: hints[name] || '结果过大。请缩小查询范围。'
    })
  }
  return text
}
