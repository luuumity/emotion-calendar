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
import { buildCoupleReportMessages, buildCoupleMemoryMessages } from '../lib/prompts/couple-report.js'
import { generateSingleInsightSync, getSingleColdStartInfo, view, isValidDay, collectSinglePersonaData } from '../lib/single-insight.js'

const router = Router()
router.use(requireUser)

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

  res.json({
    insights: [...mine, ...couples].sort((a, b) => b.generated_at.localeCompare(a.generated_at)).map(view),
    coldStart: getSingleColdStartInfo(req.user.id)
  })
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

// 删除报告：单人仅本人；双人仅该 couple 的成员（删除后双方都看不到）
router.delete('/:id', (req, res) => {
  const id = toInt(req.params.id)
  if (!id) return res.status(400).json({ error: '无效的报告编号' })
  const row = db.prepare('SELECT * FROM insights WHERE id = ?').get(id)
  if (!row) return res.status(404).json({ error: '没有找到这份报告' })

  if (row.scope === 'single') {
    if (row.user_id !== req.user.id) return res.status(403).json({ error: '无权删除' })
  } else if (row.scope === 'couple') {
    if (!isInCouple(row.couple_key, req.user.id)) return res.status(403).json({ error: '无权删除' })
  } else {
    return res.status(403).json({ error: '无权删除' })
  }

  db.prepare('DELETE FROM insights WHERE id = ?').run(id)
  res.json({ ok: true })
})

// POST /api/insights/single/generate  手动触发单人报告
router.post('/single/generate', async (req, res) => {
  const requestedType = req.body?.periodType
  const periodType = requestedType === 'month' ? 'month' : 'week'
  // 支持指定周期（手动 = 自定义）
  const rawStart = String(req.body?.start ?? '').trim()
  const rawEnd = String(req.body?.end ?? '').trim()
  const hasStart = rawStart !== ''
  const hasEnd = rawEnd !== ''
  if (hasStart !== hasEnd) return res.status(400).json({ error: '需要同时提供 start 和 end' })
  if (hasStart && !isValidDay(rawStart)) {
    return res.status(400).json({ error: '起始日期格式应为 YYYY-MM-DD' })
  }
  if (hasEnd && !isValidDay(rawEnd)) {
    return res.status(400).json({ error: '结束日期格式应为 YYYY-MM-DD' })
  }
  if (hasStart && rawStart > rawEnd) {
    return res.status(400).json({ error: '起始日期不能晚于结束日期' })
  }
  const customStart = hasStart ? rawStart : null
  const customEnd = hasEnd ? rawEnd : null
  // 自定义区间统一按 manual 存储；普通 week/month 用各自类型
  const effectiveType = customStart && customEnd ? 'manual' : periodType

  try {
    const result = await generateSingleInsightSync({ userId: req.user.id, periodType: effectiveType, customStart, customEnd })
    res.status(result.existing ? 200 : 201).json(result)
  } catch (err) {
    if (err.code === 'NO_RECORDS') return res.status(400).json({ error: err.message })
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

  // 首次生成时没有水位，用本期最早的一条记录作为开始日期
  const analysisStart = incrementStart || rawRecordsA[0]?.day || rawRecordsB[0]?.day || periodEnd

  // 组装 A 的数据池 → 按 B 给 A 的授权裁剪（full，已经校验过）
  // persona 取数按 period_end 截止，标签只取本增量区间内的
  const aPool = collectSinglePersonaData(req.user.id, { periodStart: analysisStart, periodEnd })
  const bPool = collectSinglePersonaData(partnerId, { periodStart: analysisStart, periodEnd })

  // A 的数据喂给双人 AI：用 B 给 A 的授权裁剪（都是 full，实际上不裁；但以后支持 colors 档时生效）
  const aCropped = cropForCouple({ ...aPool, records: rawRecordsA }, 'full')
  const bCropped = cropForCouple({ ...bPool, records: rawRecordsB }, 'full')

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

// ======== 定时入口 ========

// 定时任务直接使用 lib/single-insight.js，不经过 HTTP。

export { checkCoupleGrants }
export default router
