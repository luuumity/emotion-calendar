// 单人/双人 AI 报告
// 读：列表 + 单条详情（接口层保证权限：单人只读自己的，双人只有双方能读）
// 生成：单人手动触发（也会有定时 cron 调用）；双人手动触发，必须双方都给 full 档授权
// 调用 DeepSeek（未配置 API key 时返回占位内容，不报错）

import { Router } from 'express'
import { db } from '../db.js'
import { requireUser } from '../auth.js'
import { callDeepSeek, hasDeepSeekKey } from '../lib/llm.js'
import { serializePersona } from '../lib/persona.js'
import { cropForCouple } from '../lib/privacy.js'
import { makeCoupleKey, getOrInitCoupleMemory, computeIncrementStart, updateCoupleMemory, isInCouple } from '../lib/incremental.js'
import { buildSingleReportMessages } from '../lib/prompts/single-report.js'
import { buildCoupleReportMessages, buildCoupleMemoryMessages } from '../lib/prompts/couple-report.js'

const router = Router()
router.use(requireUser)

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const COUPLE_MEMORY_LIMIT = 300

/**
 * 把旧记忆 + 本期增量记录压成新记忆。
 * 失败时返回 null，由调用方退回旧行为（截取报告开头），不影响报告本身。
 */
async function summarizeCoupleMemory(input) {
  try {
    const result = await callDeepSeek(buildCoupleMemoryMessages(input), { tools: false, temperature: 0.2 })
    const text = String(result.content || '').trim().slice(0, COUPLE_MEMORY_LIMIT)
    if (!text) return null
    return { text, usage: result.usage || {} }
  } catch (err) {
    console.error('[insights] 双人记忆摘要失败，降级为报告开头:', err.message)
    return null
  }
}

// ======== 工具函数 ========

function toInt(input) {
  const n = Number(input)
  return Number.isInteger(n) ? n : null
}

function view(row) {
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
  // anchor 是 Date 对象，periodType: week/month/manual → 返回 {start, end} (YYYY-MM-DD)
  const a = new Date(anchor)
  a.setUTCHours(0, 0, 0, 0)
  if (periodType === 'week') {
    const day = a.getUTCDay() || 7 // 周几（0=周日 → 7=周日）
    const start = new Date(a); start.setUTCDate(a.getUTCDate() - (day - 1)) // 周一
    const end = new Date(start); end.setUTCDate(start.getUTCDate() + 6)
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
  }
  if (periodType === 'month') {
    const start = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth(), 1))
    const end = new Date(Date.UTC(a.getUTCFullYear(), a.getUTCMonth() + 1, 0))
    return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
  }
  // manual：anchor 当天
  return { start: a.toISOString().slice(0, 10), end: a.toISOString().slice(0, 10) }
}

// ======== 读取 ========

// 列表：自己的单人报告 + 自己参与的双人报告
router.get('/', (req, res) => {
  const mine = db
    .prepare('SELECT * FROM insights WHERE scope = ? AND user_id = ? ORDER BY generated_at DESC')
    .all('single', req.user.id)

  const couples = db
    .prepare('SELECT * FROM insights WHERE scope = ? AND couple_key IS NOT NULL ORDER BY generated_at DESC')
    .all('couple')
    .filter((row) => isInCouple(row.couple_key, req.user.id))

  res.json({ insights: [...mine, ...couples].sort((a, b) => b.generated_at.localeCompare(a.generated_at)).map(view) })
})

// 单条详情（权限硬校验）
router.get('/:id', (req, res) => {
  const id = toInt(req.params.id)
  if (!id) return res.status(400).json({ error: '无效的报告编号' })
  const row = db.prepare('SELECT * FROM insights WHERE id = ?').get(id)
  if (!row) return res.status(404).json({ error: '没有找到这份报告' })

  if (row.scope === 'single') {
    if (row.user_id !== req.user.id) return res.status(403).json({ error: '无权查看' })
  } else if (row.scope === 'couple') {
    if (!isInCouple(row.couple_key, req.user.id)) return res.status(403).json({ error: '无权查看' })
  }

  res.json({ insight: view(row) })
})

// ======== 单人报告生成 ========

/**
 * 组装 persona 输入数据（单人场景，全量不裁剪）。
 */
function collectSinglePersonaData(userId) {
  const displayName = db.prepare('SELECT display_name FROM users WHERE id = ?').get(userId)?.display_name || '用户'
  const facts = db.prepare('SELECT * FROM facts WHERE user_id = ? ORDER BY confidence DESC, id DESC').all(userId)
  const tags = db.prepare(
    `SELECT t.*, r.day AS record_day FROM record_tags t JOIN records r ON r.id = t.record_id
     WHERE t.user_id = ? ORDER BY t.id DESC LIMIT 20`
  ).all(userId)
  const singleInsights = db
    .prepare('SELECT period_start, period_end, content FROM insights WHERE scope = ? AND user_id = ? ORDER BY period_start DESC LIMIT 5')
    .all('single', userId)
  const recentChats = db
    .prepare(
      `SELECT m.role, m.content FROM chat_messages m JOIN chat_sessions s ON s.id = m.session_id
       WHERE s.user_id = ? ORDER BY m.created_at DESC LIMIT 20`
    )
    .all(userId)
    .reverse()

  return { displayName, facts, tags, singleInsights, recentChats }
}

function generateSingleInsightSync({ userId, periodType = 'week', customStart, customEnd }) {
  const { start, end } = customStart && customEnd ? { start: customStart, end: customEnd } : computePeriod(periodType)
  const now = new Date().toISOString()

  // 取周期内记录
  const records = db
    .prepare(
      `SELECT id, day, score, note, original_score, adjusted_at FROM records
       WHERE user_id = ? AND day BETWEEN ? AND ? ORDER BY day, id`
    )
    .all(userId, start, end)

  // 组装 persona（单人不裁剪）
  const { displayName, facts, tags, singleInsights, recentChats } = collectSinglePersonaData(userId)
  const personaBlock = serializePersona({ displayName, facts, tags, recentChats, singleInsights })

  const messages = buildSingleReportMessages({ personaBlock, periodStart: start, periodEnd: end, records })

  // 调模型
  return callDeepSeek(messages).then((result) => {
    // 写 insights。部分唯一索引会自动拦重复——同一用户 + 同周期类型 + 同起点 = 唯一
    db.prepare(
      `INSERT OR IGNORE INTO insights
        (scope, user_id, couple_key, period_type, period_start, period_end, content, model, prompt_version, tokens, generated_at)
       VALUES (?, ?, NULL, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run('single', userId, periodType, start, end, result.content, result.model, 'single-v1', result.usage.total_tokens || 0, now)

    const row = db.prepare('SELECT * FROM insights WHERE scope = ? AND user_id = ? AND period_start = ? AND period_type = ? ORDER BY id DESC LIMIT 1').get('single', userId, start, periodType)
    return { insight: view(row), usage: result.usage, hasKey: hasDeepSeekKey() }
  })
}

// POST /api/insights/single/generate  手动触发单人报告
router.post('/single/generate', async (req, res) => {
  const periodType = req.body?.periodType === 'month' ? 'month' : 'week'
  // 支持指定周期（手动 = 自定义）
  const customStart = DAY_RE.test(String(req.body?.start || '')) ? String(req.body.start) : null
  const customEnd = DAY_RE.test(String(req.body?.end || '')) ? String(req.body.end) : null
  if (customStart && !customEnd) return res.status(400).json({ error: '需要同时提供 start 和 end' })
  if (!customStart && customEnd) return res.status(400).json({ error: '需要同时提供 start 和 end' })

  try {
    const result = await generateSingleInsightSync({ userId: req.user.id, periodType, customStart, customEnd })
    res.status(201).json(result)
  } catch (err) {
    console.error('[insights] 单人报告生成失败:', err.message)
    res.status(500).json({ error: '生成失败，请稍后再试' })
  }
})

// ======== 双人报告生成 ========

/**
 * 检查双向授权是否 full。返回 null = 可以生成；否则返回错误字符串。
 */
function checkCoupleGrants(userIdA, userIdB) {
  if (userIdA === userIdB) return '不能和自己生成双人报告'

  const getScope = (owner, viewer) => {
    const row = db
      .prepare(
        `SELECT g.scope, s.revoked FROM grants g JOIN shares s ON s.id = g.share_id
         WHERE g.owner_id = ? AND g.viewer_id = ?`
      )
      .get(owner, viewer)
    if (!row || row.revoked) return null
    return row.scope
  }

  const aToB = getScope(userIdA, userIdB)
  const bToA = getScope(userIdB, userIdA)

  if (!aToB) return `${userIdA} 没有给 ${userIdB} 授权`
  if (!bToA) return `${userIdB} 没有给 ${userIdA} 授权`
  if (aToB !== 'full') return `${userIdA} 只给了 colors 档授权，需要 full 档`
  if (bToA !== 'full') return `${userIdB} 只给了 colors 档授权，需要 full 档`
  return null
}

router.post('/couple/generate', async (req, res) => {
  const partnerId = toInt(req.body?.partnerId)
  if (!partnerId) return res.status(400).json({ error: '请指定对方的编号 (partnerId)' })

  const now = new Date()
  const coupleKey = makeCoupleKey(req.user.id, partnerId)

  // 硬门槛：双方都给 full 档授权
  const grantError = checkCoupleGrants(req.user.id, partnerId)
  if (grantError) return res.status(403).json({ error: grantError })

  // 对方信息
  const partner = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(partnerId)
  const me = db.prepare('SELECT id, display_name FROM users WHERE id = ?').get(req.user.id)

  // 取 couple_memory → 算增量起点
  const memory = getOrInitCoupleMemory(coupleKey)
  const incrementStart = computeIncrementStart(memory) // null = 全量

  // 取增量区间内双方记录
  const periodEnd = now.toISOString().slice(0, 10)
  const periodStart = incrementStart || '2020-01-01' // 没跑过就取从 2020 至今（实际上用户记录从哪年开始就取哪年）

  const recordsStmt = db.prepare(
    `SELECT id, day, score, note, original_score, adjusted_at FROM records
     WHERE user_id = ? AND day >= ? ORDER BY day, id`
  )
  const rawRecordsA = recordsStmt.all(req.user.id, periodStart)
  const rawRecordsB = recordsStmt.all(partnerId, periodStart)

  if (!rawRecordsA.length && !rawRecordsB.length) {
    return res.status(400).json({ error: '这个区间里没有新的情绪记录，生成不了报告' })
  }

  // 组装 A 的数据池 → 按 B 给 A 的授权裁剪（full，已经校验过）
  const aPool = collectSinglePersonaData(req.user.id)
  const bPool = collectSinglePersonaData(partnerId)

  // A 的数据喂给双人 AI：用 B 给 A 的授权裁剪（都是 full，实际上不裁；但以后支持 colors 档时生效）
  const aCropped = cropForCouple({ ...aPool, records: rawRecordsA }, 'full')
  const bCropped = cropForCouple({ ...bPool, records: rawRecordsB }, 'full')

  // 首次生成时没有水位，用本期最早的一条记录作为开始日期
  const analysisStart = incrementStart || rawRecordsA[0]?.day || rawRecordsB[0]?.day || periodEnd

  // 序列化两个 persona
  const personaA = serializePersona({
    displayName: me.display_name,
    facts: aCropped.facts,
    tags: aCropped.tags,
    recentChats: aPool.recentChats,
    singleInsights: aCropped.singleInsights
  })
  const personaB = serializePersona({
    displayName: partner.display_name,
    facts: bCropped.facts,
    tags: bCropped.tags,
    recentChats: bPool.recentChats,
    singleInsights: bCropped.singleInsights
  })

  // prompt
  const messages = buildCoupleReportMessages({
    personaA,
    personaB,
    partnerAName: me.display_name,
    partnerBName: partner.display_name,
    recordsA: aCropped.records,
    recordsB: bCropped.records,
    periodStart: analysisStart,
    periodEnd,
    lastSummary: memory.summary
  })

  try {
    const result = await callDeepSeek(messages)

    // 记忆摘要：旧记忆 + 本期增量记录 → 新记忆；失败则退回截取报告开头
    const memoryResult = await summarizeCoupleMemory({
      lastSummary: memory.summary,
      periodStart: analysisStart,
      periodEnd,
      partnerAName: me.display_name,
      partnerBName: partner.display_name,
      recordsA: aCropped.records,
      recordsB: bCropped.records
    })
    const nextSummary = memoryResult?.text || result.content.slice(0, COUPLE_MEMORY_LIMIT)
    const totalTokens = (result.usage?.total_tokens || 0) + (memoryResult?.usage?.total_tokens || 0)

    // 写 insights
    const generatedAt = now.toISOString()
    db.prepare(
      `INSERT OR IGNORE INTO insights
        (scope, user_id, couple_key, period_type, period_start, period_end, content, model, prompt_version, tokens, covered_until, generated_at)
       VALUES (?, NULL, ?, 'manual', ?, ?, ?, ?, 'couple-v1', ?, ?, ?)`
    ).run(
      'couple', coupleKey,
      analysisStart,
      periodEnd,
      result.content,
      result.model,
      totalTokens,
      periodEnd,
      generatedAt
    )

    updateCoupleMemory(coupleKey, periodEnd, nextSummary)

    const row = db.prepare('SELECT * FROM insights WHERE scope = ? AND couple_key = ? AND generated_at = ?').get('couple', coupleKey, generatedAt)
    res.status(201).json({ insight: view(row), usage: result.usage, hasKey: hasDeepSeekKey() })
  } catch (err) {
    console.error('[insights] 双人报告生成失败:', err.message)
    res.status(500).json({ error: '生成失败，请稍后再试' })
  }
})

// ======== 定时入口（cron 调用） ========

// 供 cron 脚本调用的单人定时生成入口，内部和手动触发用同一个函数
// 对外不暴露（cron 脚本通过服务器内网或本地调用），先注释掉公开路由
// router.post('/single/cron', ...)

export { generateSingleInsightSync, checkCoupleGrants }
export default router
