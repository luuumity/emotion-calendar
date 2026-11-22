// 把已落库的完整工具轨迹压成给下一轮 prompt 用的查询日志。
// 只读：不写库、不改历史、不注入 prompt。后续接入时再决定窗口和注入位置。

import { db } from '../db.js'

const MAX_LINE = 260

function parseJson(value) {
  if (value == null) return null
  if (typeof value === 'object') return value
  try {
    return JSON.parse(value)
  } catch {
    return value
  }
}

function clean(value, max = 60) {
  const s = String(value ?? '').replace(/\s+/g, ' ').trim()
  return s.length > max ? s.slice(0, max) + '…' : s
}

function isNum(value) {
  return typeof value === 'number' && Number.isFinite(value)
}

function rangeText(start, end) {
  if (start && end) return `${start} ~ ${end}`
  return start || end || ''
}

function callArgs(name, args) {
  const a = args && typeof args === 'object' ? args : {}
  switch (name) {
    case 'get_days': {
      const parts = [rangeText(a.start, a.end)]
      if (a.includeNotes === false) parts.push('includeNotes=false')
      if (a.limit != null) parts.push(`limit=${a.limit}`)
      if (a.offset != null) parts.push(`offset=${a.offset}`)
      return `get_days(${parts.filter(Boolean).join(', ')})`
    }
    case 'get_tags': {
      const parts = []
      if (a.id != null) parts.push(`id=${a.id}`)
      else parts.push(rangeText(a.start, a.end))
      if (a.limit != null) parts.push(`limit=${a.limit}`)
      if (a.offset != null) parts.push(`offset=${a.offset}`)
      return `get_tags(${parts.filter(Boolean).join(', ')})`
    }
    case 'get_range_stats':
      return `get_range_stats(${rangeText(a.start, a.end)})`
    case 'get_record':
      return `get_record(${a.id})`
    case 'get_report': {
      const parts = []
      if (a.id != null) parts.push(`id=${a.id}`)
      if (a.limit != null) parts.push(`limit=${a.limit}`)
      if (a.offset != null) parts.push(`offset=${a.offset}`)
      return `get_report(${parts.join(', ')})`
    }
    case 'get_facts': {
      const parts = []
      if (a.query) parts.push(`query=${JSON.stringify(clean(a.query, 24))}`)
      if (a.limit != null) parts.push(`limit=${a.limit}`)
      if (a.offset != null) parts.push(`offset=${a.offset}`)
      return `get_facts(${parts.join(', ')})`
    }
    case 'search_records': {
      const parts = [`query=${JSON.stringify(clean(a.query, 24))}`]
      if (a.start && a.end) parts.push(rangeText(a.start, a.end))
      if (a.limit != null) parts.push(`limit=${a.limit}`)
      if (a.offset != null) parts.push(`offset=${a.offset}`)
      return `search_records(${parts.join(', ')})`
    }
    default: {
      const keys = Object.keys(a)
      const parts = keys.slice(0, 4).map((k) => `${k}=${clean(a[k], 24)}`)
      return `${name}(${parts.join(', ')})`
    }
  }
}

function listSummary(out, unit) {
  const parts = []
  const total = isNum(out.total) ? out.total : null
  const returned = isNum(out.returned)
    ? out.returned
    : Array.isArray(out.items)
      ? out.items.length
      : null
  if (total != null) parts.push(`共 ${total} ${unit}`)
  if (returned != null) parts.push(`返回 ${returned}`)
  if (out.nextOffset != null) parts.push(`nextOffset=${out.nextOffset}`)
  return parts.join('，') || '成功'
}

function resultSummary(name, args, status, error, output) {
  if (status === 'duplicate') return `未执行：${clean(error || '同样的查询已经执行过', 100)}`
  if (status === 'too_large') return `失败：${clean(error || '结果过大，未返回', 100)}`
  if (status === 'not_found') return `失败：${clean(error || '未找到', 80)}`
  if (status === 'error') return `失败：${clean(error || '工具执行出错', 100)}`

  const out = output && typeof output === 'object' ? output : null
  if (!out) return status === 'ok' ? '成功' : clean(status, 40)
  if (out.ok === false) return `失败：${clean(out.hint || out.reason || '未知原因', 100)}`

  switch (name) {
    case 'get_range_stats': {
      if (out.recordCount === 0) return '0 条'
      const parts = []
      if (isNum(out.recordCount)) parts.push(`${out.recordCount} 条`)
      if (isNum(out.recordedDays)) parts.push(`${out.recordedDays} 天`)
      if (isNum(out.avg)) parts.push(`均分 ${out.avg}`)
      if (out.min != null || out.max != null) parts.push(`${out.min ?? '?'}~${out.max ?? '?'}`)
      if (out.firstDay && out.lastDay) parts.push(`实际 ${out.firstDay} ~ ${out.lastDay}`)
      if (out.granularity && out.granularity !== 'day') parts.push(`粒度=${out.granularity}`)
      return parts.join('，') || '成功'
    }
    case 'get_days': {
      const total = isNum(out.total)
        ? out.total
        : Array.isArray(out.items)
          ? out.items.length
          : null
      if (total === 0) return '0 条'
      const parts = []
      if (total != null) parts.push(`共 ${total} 条`)
      const returned = isNum(out.returned)
        ? out.returned
        : Array.isArray(out.items)
          ? out.items.length
          : null
      if (returned != null) parts.push(`返回 ${returned}`)
      if (out.nextOffset != null) parts.push(`nextOffset=${out.nextOffset}`)
      const items = Array.isArray(out.items) ? out.items : []
      const days = new Set(items.map((item) => item.day).filter(Boolean))
      if (days.size) parts.push(`覆盖 ${days.size} 天`)
      if (args?.includeNotes === false) parts.push('仅分值')
      else if (items.some((item) => item.noteTruncated)) parts.push('含截断理由')
      else if (items.some((item) => item.note)) parts.push('含理由')
      return parts.join('，')
    }
    case 'get_record': {
      const item = out.item
      if (!item) return '未找到'
      const parts = [`id=${item.id}`]
      if (item.day) parts.push(item.day)
      if (item.indexInDay != null) parts.push(`第${item.indexInDay}颗`)
      if (item.score != null) parts.push(`${item.score} 分`)
      if (typeof item.note === 'string') parts.push(`全文 ${item.note.length} 字`)
      if (item.originalScore != null) parts.push(`原分 ${item.originalScore}`)
      return parts.join('，')
    }
    case 'get_tags': {
      if (out.item) {
        const item = out.item
        const parts = [`记录 id=${item.recordId}`]
        if (item.day) parts.push(item.day)
        if (item.tagType) parts.push(item.tagType)
        if (typeof item.content === 'string') parts.push(`全文 ${item.content.length} 字`)
        return parts.join('，')
      }
      return listSummary(out, '条')
    }
    case 'get_report': {
      if (out.report) {
        const report = out.report
        const parts = [`报告 #${report.id}`]
        if (report.periodStart && report.periodEnd) parts.push(`${report.periodStart} ~ ${report.periodEnd}`)
        if (report.scope) parts.push(report.scope)
        if (typeof report.content === 'string') parts.push(`全文 ${report.content.length} 字`)
        return parts.join('，')
      }
      return listSummary(out, '份')
    }
    case 'get_facts':
      return listSummary(out, '条')
    case 'search_records': {
      const parts = [listSummary(out, '条')]
      const hits = (Array.isArray(out.items) ? out.items : [])
        .slice(0, 3)
        .map((item) => `${item.day} ${item.score}分(id=${item.id})`)
      if (hits.length) parts.push(`命中：${hits.join('；')}`)
      return parts.join('，')
    }
    default:
      return '成功'
  }
}

function formatToolResult(event) {
  const payload = event.payload || {}
  const args = payload.args && typeof payload.args === 'object'
    ? payload.args
    : parseJson(payload.args) || {}
  const output = parseJson(payload.output)
  const status = payload.status || (output?.ok === false ? 'error' : 'ok')
  const error = payload.error || output?.hint || output?.reason || ''
  const line = `${callArgs(payload.name, args)} → ${resultSummary(payload.name, args, status, error, output)}`
  return clean(line, MAX_LINE)
}

function questionOf(turnId) {
  return db.prepare('SELECT content FROM chat_messages WHERE id = ? AND role = ?').get(turnId, 'user')?.content || ''
}

/**
 * 生成单轮查询日志。
 * @returns {{ turnId:number, question:string, calls:number, lines:string[] }}
 */
export function buildTurnLog(sessionId, turnId) {
  const events = db
    .prepare(
      `SELECT seq, type, payload FROM chat_trace_events
       WHERE session_id = ? AND turn_id = ? ORDER BY seq ASC`
    )
    .all(sessionId, turnId)
    .map((row) => ({ ...row, payload: parseJson(row.payload) || {} }))

  const lines = []
  const resultIds = new Set()
  for (const event of events) {
    if (event.type === 'tool_result') {
      resultIds.add(event.payload.tool_call_id)
      lines.push(formatToolResult(event))
    }
  }

  // 极端情况下模型发出了调用但没等到结果，也留一行，避免日志看起来像没查过。
  for (const event of events) {
    if (event.type !== 'assistant_tool_calls') continue
    for (const call of event.payload.tool_calls || []) {
      if (resultIds.has(call.id)) continue
      const name = call.function?.name || 'unknown'
      const args = parseJson(call.function?.arguments) || {}
      lines.push(clean(`${callArgs(name, args)} → 结果未记录`, MAX_LINE))
    }
  }

  return {
    turnId,
    question: String(questionOf(turnId)),
    calls: lines.length,
    lines
  }
}

/**
 * 取最近 N 个有工具轨迹的 turn，按时间正序返回。
 */
export function buildRecentTurnLogs(sessionId, limit = 3) {
  const turns = db
    .prepare(
      `SELECT turn_id FROM chat_trace_events
       WHERE session_id = ?
       GROUP BY turn_id
       ORDER BY turn_id DESC
       LIMIT ?`
    )
    .all(sessionId, Math.max(1, Number(limit) || 3))
    .map((row) => row.turn_id)
    .reverse()
  return turns.map((turnId) => buildTurnLog(sessionId, turnId))
}

export function renderTurnLog(log, { includeQuestion = true } = {}) {
  const lines = []
  if (includeQuestion && log.question) lines.push(`[问：${clean(log.question, 40)}]`)
  for (const line of log.lines) lines.push(`- ${line}`)
  return lines.join('\n') || '（本轮无工具调用）'
}

export function renderRecentLogs(logs, { includeQuestion = true, includeTurnId = false } = {}) {
  if (!logs.length) return '【最近查询记录】\n（无）'
  const parts = ['【最近查询记录】']
  logs.forEach((log, index) => {
    parts.push(includeTurnId ? `[turn ${log.turnId}]` : `[第 ${index + 1} 轮]`)
    if (includeQuestion && log.question) parts.push(`[问：${clean(log.question, 40)}]`)
    for (const line of log.lines) parts.push(`- ${line}`)
    if (index < logs.length - 1) parts.push('')
  })
  return parts.join('\n')
}

const TRACE_LOG_PREFACE =
  '【最近查询记录】\n以下查询已经完成，不要重复全量扫描；需要细节时按记录里的 id 重取，不要向用户展示内部编号。'

/**
 * 生成注入用的聚合日志块。超过预算时先丢最旧的轮次，单轮仍超长再按行截断。
 */
export function buildTraceLogBlock(
  sessionId,
  { turns = 6, maxChars = 2500, includeQuestion = true } = {}
) {
  let logs = buildRecentTurnLogs(sessionId, turns).filter((log) => log.lines.length)
  if (!logs.length) return ''

  let text = renderRecentLogs(logs, { includeQuestion })
  while (logs.length > 1 && text.length > maxChars) {
    logs = logs.slice(1)
    text = renderRecentLogs(logs, { includeQuestion })
  }
  if (text.length > maxChars) {
    text = text.slice(0, maxChars).replace(/\n[^\n]*$/, '\n…')
  }
  return text.replace('【最近查询记录】', TRACE_LOG_PREFACE)
}
