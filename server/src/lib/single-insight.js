// 单人报告生成核心：手动接口与定时扫描共用。
// 生成逻辑从 routes/insights.js 抽出，避免定时任务依赖 HTTP 层。

import { db } from '../db.js'
import { hasDeepSeekKey } from './llm.js'
import { serializePersona } from './persona.js'
import { REPORT_FUNCTION_TOOLS } from './tools.js'
import { runWithTools } from './tool-loop.js'
import { buildSingleReportMessages } from './prompts/single-report.js'

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

// 报告侧只允许最多 6 步模型调用，额度用尽后强制收尾一次
const MAX_REPORT_TOOL_STEPS = 6

export function isValidDay(s) {
  if (!DAY_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

export function view(row) {
  if (!row) return null
  return {
    id: row.id,
    scope: row.scope,
    userId: row.user_id,
    coupleKey: row.couple_key,
    periodType: row.period_type,
    periodStart: row.period_start,
    periodEnd: row.period_end,
    content: row.content,
    model: row.model,
    promptVersion: row.prompt_version,
    tokens: row.tokens,
    sources: row.sources ? JSON.parse(row.sources) : null,
    coveredUntil: row.covered_until,
    generatedAt: row.generated_at
  }
}

function computePeriod(periodType, anchor = new Date()) {
  // 周期按 Asia/Shanghai 计算：先整体 +8 小时，再用 UTC 字段读取当地日历日期，
  // 避免服务器跑在 UTC 时，凌晨 0-8 点被算到前一天 / 上一周 / 上个月。
  const a = new Date(anchor.getTime() + 8 * 3600 * 1000)
  a.setUTCHours(0, 0, 0, 0)
  if (periodType === 'week') {
    const day = a.getUTCDay() || 7
    const start = new Date(a)
    start.setUTCDate(a.getUTCDate() - (day - 1))
    const end = new Date(start)
    end.setUTCDate(start.getUTCDate() + 6)
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
  }
  if (periodType === 'month') {
    const start = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1))
    const end = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 1, 0))
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
  }
  return { start: a.toISOString().slice(0, 10), end: a.toISOString().slice(0, 10) }
}

function shanghaiToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

// 周期结束日（Asia/Shanghai）对应的 UTC 截止时间，用于过滤周期结束后才产生的内容
function endOfDayUtcIso(day) {
  return new Date(`${day}T23:59:59.999+08:00`).toISOString()
}

/**
 * 冷启动信息：是否还没有任何单人报告。
 * 手动和定时任务都通过这里判断，保证口径一致。
 */
export function getSingleColdStartInfo(userId) {
  const stats = db
    .prepare('SELECT MIN(day) AS first_day, COUNT(*) AS record_count FROM records WHERE user_id = ?')
    .get(userId)
  const recordCount = stats?.record_count || 0
  const hasRecords = recordCount > 0 && Boolean(stats?.first_day)
  const hasReport = hasRecords
    ? Boolean(
        db.prepare('SELECT 1 FROM insights WHERE scope = ? AND user_id = ? LIMIT 1').get('single', userId)
      )
    : false
  return {
    hasRecords,
    needed: hasRecords && !hasReport,
    start: hasRecords ? stats.first_day : null,
    end: hasRecords ? shanghaiToday() : null,
    recordCount
  }
}

/**
 * 组装 persona 输入数据（单人场景）。
 * 传入 periodEnd 时，facts / 标签 / 历史报告 / 对话都只取该周期结束前已存在的内容；
 * 标签还要求记录日落在 [periodStart, periodEnd] 内。
 */
export function collectSinglePersonaData(userId, { periodStart = null, periodEnd = null, excludeInsightId = null } = {}) {
  const displayName = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId)?.display_name || '用户'
  const cutoff = periodEnd ? endOfDayUtcIso(periodEnd) : null

  const facts = cutoff
    ? db
        .prepare('SELECT * FROM facts WHERE user_id = ? AND created_at <= ? ORDER BY confidence DESC, id DESC')
        .all(userId, cutoff)
    : db.prepare('SELECT * FROM facts WHERE user_id = ? ORDER BY confidence DESC, id DESC').all(userId)

  let tags
  if (cutoff && periodStart) {
    tags = db
      .prepare(
        `SELECT t.*, r.day AS record_day FROM record_tags t JOIN records r ON r.id = t.record_id
         WHERE t.user_id = ? AND r.day BETWEEN ? AND ? AND t.created_at <= ?
         ORDER BY t.id DESC LIMIT 20`
      )
      .all(userId, periodStart, periodEnd, cutoff)
  } else if (cutoff) {
    tags = db
      .prepare(
        `SELECT t.*, r.day AS record_day FROM record_tags t JOIN records r ON r.id = t.record_id
         WHERE t.user_id = ? AND r.day <= ? AND t.created_at <= ?
         ORDER BY t.id DESC LIMIT 20`
      )
      .all(userId, periodEnd, cutoff)
  } else {
    tags = db
      .prepare(
        `SELECT t.*, r.day AS record_day FROM record_tags t JOIN records r ON r.id = t.record_id
         WHERE t.user_id = ? ORDER BY t.id DESC LIMIT 20`
      )
      .all(userId)
  }

  const singleInsights = cutoff
    ? db
        .prepare(
          `SELECT id, period_start, period_end, content FROM insights
           WHERE scope = ? AND user_id = ? AND generated_at <= ? AND id != ?
           ORDER BY period_start DESC LIMIT 5`
        )
        .all('single', userId, cutoff, excludeInsightId || 0)
    : db
        .prepare(
          `SELECT id, period_start, period_end, content FROM insights
           WHERE scope = ? AND user_id = ? AND id != ?
           ORDER BY period_start DESC LIMIT 5`
        )
        .all('single', userId, excludeInsightId || 0)

  const recentChats = cutoff
    ? db
        .prepare(
          `SELECT m.role, m.content FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
           WHERE s.user_id = ? AND m.created_at <= ?
           ORDER BY m.created_at DESC LIMIT 20`
        )
        .all(userId, cutoff)
        .reverse()
    : db
        .prepare(
          `SELECT m.role, m.content FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
           WHERE s.user_id = ? ORDER BY m.created_at DESC LIMIT 20`
        )
        .all(userId)
        .reverse()

  return { displayName, facts, tags, singleInsights, recentChats }
}

/** 查找已存在的单人报告。自定义周期以 start+end 共同判定，避免起点相同、终点不同被误判为重复。 */
export function findExistingSingleInsight(userId, periodType, start, end) {
  if (periodType === 'manual') {
    return db
      .prepare(
        `SELECT * FROM insights WHERE scope = 'single' AND user_id = ? AND period_type = 'manual'
         AND period_start = ? AND period_end = ? ORDER BY id DESC LIMIT 1`
      )
      .get(userId, start, end)
  }
  return db
    .prepare(
      `SELECT * FROM insights WHERE scope = 'single' AND user_id = ? AND period_type = ? AND period_start = ?
       ORDER BY id DESC LIMIT 1`
    )
    .get(userId, periodType, start)
}

/**
 * 生成单人报告（同步等待模型）。
 * @param {object} input
 * @param {number} input.userId
 * @param {string} [input.periodType] week/month/manual
 * @param {string} [input.customStart]
 * @param {string} [input.customEnd]
 * @param {boolean} [input.force] 已存在时原地重新生成并覆盖（用于覆盖半周报告）
 * @returns {Promise<{insight: object, usage: object|null, hasKey: boolean, existing: boolean, coldStart: boolean, action: string}>}
 */
export async function generateSingleInsightSync({
  userId,
  periodType = 'week',
  customStart,
  customEnd,
  force = false,
  nowIso = null
}) {
  const cold = getSingleColdStartInfo(userId)
  if (!cold.hasRecords) {
    const err = new Error('还没有任何记录，先记录几天再来生成报告')
    err.code = 'NO_RECORDS'
    throw err
  }

  // 冷启动：还没有任何单人报告时，首份报告永远从第一条记录到今天。
  // 手动、定时任务都调用本函数，因此共用同一口径。
  let resolvedType = periodType
  let start
  let end
  let coldStart = false
  if (cold.needed) {
    resolvedType = 'manual'
    start = cold.start
    end = cold.end
    coldStart = true
  } else {
    const period =
      customStart && customEnd ? { start: customStart, end: customEnd } : computePeriod(periodType)
    start = period.start
    end = period.end
  }

  // 先查重：已存在且未要求覆盖，就直接返回，不再调用模型
  const existing = findExistingSingleInsight(userId, resolvedType, start, end)
  if (existing && !force) {
    return {
      insight: view(existing),
      usage: null,
      hasKey: hasDeepSeekKey(),
      existing: true,
      coldStart,
      action: 'existing'
    }
  }

  const now = nowIso || new Date().toISOString()

  // 取周期内记录与内联标签（一球一标签）；标签只取周期结束前已写入的
  const cutoff = endOfDayUtcIso(end)
  const records = db
    .prepare(
      `SELECT r.id, r.day, r.score, r.note, r.original_score, r.adjusted_at,
              (SELECT COUNT(*) FROM records r2
                WHERE r2.user_id = r.user_id AND r2.day = r.day AND r2.id <= r.id) AS index_in_day,
              t.tag_type AS tag_type, t.content AS tag_content
       FROM records r
       LEFT JOIN record_tags t ON t.record_id = r.id AND t.user_id = r.user_id AND t.created_at <= ?
       WHERE r.user_id = ? AND r.day BETWEEN ? AND ?
       ORDER BY r.day, r.id`
    )
    .all(cutoff, userId, start, end)
    .map((r) => ({
      id: r.id,
      day: r.day,
      score: r.score,
      note: r.note,
      originalScore: r.original_score,
      adjustedAt: r.adjusted_at,
      indexInDay: r.index_in_day,
      tag: r.tag_type ? { tagType: r.tag_type, content: r.tag_content } : null
    }))

  // 组装 persona：按 period_end 截止；单人不再输入对话
  const { displayName, facts, singleInsights } = collectSinglePersonaData(userId, {
    periodStart: start,
    periodEnd: end,
    excludeInsightId: existing?.id || null
  })
  const personaBlock = serializePersona({ displayName, facts, singleInsights })

  const messages = buildSingleReportMessages({
    personaBlock,
    periodStart: start,
    periodEnd: end,
    records,
    coldStart,
    isFirst: coldStart
  })

  // 报告只开放 get_record / get_report 回读；不限制总工具调用次数
  const result = await runWithTools(
    messages,
    { userId },
    {
      functions: REPORT_FUNCTION_TOOLS,
      maxSteps: MAX_REPORT_TOOL_STEPS,
      allowedTools: ['get_record', 'get_report'],
      finalHint: '回读额度已用完。请直接根据已有信息完成报告，不要输出工具调用格式；没读到的内容不要编造。'
    }
  )

  // 覆盖半周报告：生成成功后再 UPDATE，失败时旧报告保留
  if (existing && force) {
    db.prepare(
      `UPDATE insights
       SET content = ?, model = ?, prompt_version = ?, tokens = ?, generated_at = ?
       WHERE id = ?`
    ).run(result.content, result.model, 'single-v2', result.usage.total_tokens || 0, now, existing.id)
    const row = db.prepare('SELECT * FROM insights WHERE id = ?').get(existing.id)
    return {
      insight: view(row),
      usage: result.usage,
      hasKey: hasDeepSeekKey(),
      existing: false,
      coldStart,
      action: 'updated'
    }
  }

  // 写 insights。部分唯一索引会自动拦重复——同一用户 + 同周期类型 + 同起点 = 唯一。
  // 若并发请求在模型返回前抢先写入，这里 changes = 0，直接返回已存在的那份。
  const info = db
    .prepare(
      `INSERT OR IGNORE INTO insights
        (scope, user_id, couple_key, period_type, period_start, period_end, content, model, prompt_version, tokens, generated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
    )
    .run('single', userId, resolvedType, start, end, result.content, result.model, 'single-v2', result.usage.total_tokens || 0, now)

  const row = findExistingSingleInsight(userId, resolvedType, start, end)
  return {
    insight: view(row),
    usage: result.usage,
    hasKey: hasDeepSeekKey(),
    existing: info.changes === 0,
    coldStart,
    action: info.changes === 0 ? 'existing' : 'created'
  }
}
