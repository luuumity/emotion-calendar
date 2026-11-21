// 问答会话与消息
// 每轮对话：前端 POST /api/chat/sessions/:id/messages → 后端组装 persona + 历史 → 调模型 → 存两边 → 返回 assistant 回复
// 未配置 DEEPSEEK_API_KEY 时返回占位内容，不报错（方便 UI 联调）

import { Router } from 'express'
import { db } from '../db.js'
import { requireUser } from '../auth.js'
import { callDeepSeek } from '../lib/llm.js'
import { ensureCompressed } from '../lib/compress.js'
import { getDefaultSystemPrompt } from '../lib/persona.js'
import { buildChatMessages } from '../lib/prompts/chat.js'
import { FUNCTION_TOOLS, executeTool } from '../lib/tools.js'
import { withLiveTagTarget } from '../lib/proposalView.js'

const router = Router()
router.use(requireUser)

// ======== 工具 ========

function toInt(input) {
  const n = Number(input)
  return Number.isInteger(n) ? n : null
}

function nowIso() {
  return new Date().toISOString()
}

function sessionView(row, messageCount = 0) {
  if (!row) return null
  return {
    id: row.id,
    title: row.title,
    messageCount,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

function messageView(row, proposals = []) {
  if (!row) return null
  let refs = null
  try { refs = row.refs ? JSON.parse(row.refs) : null } catch { refs = null }
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    refs,
    proposals,
    createdAt: row.created_at
  }
}

function proposalView(row) {
  let payload = null
  try { payload = row.payload ? JSON.parse(row.payload) : null } catch { payload = null }
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    payload: withLiveTagTarget(row, payload),
    coupleVisible: Boolean(row.couple_visible),
    resultRefId: row.result_ref_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at
  }
}

function sessionBelongsToUser(sessionId, userId) {
  return !!db.prepare('SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?').get(sessionId, userId)
}

// ======== Session CRUD ========

router.get('/sessions', (req, res) => {
  const sessions = db
    .prepare('SELECT * FROM chat_sessions WHERE user_id = ? ORDER BY updated_at DESC, id DESC')
    .all(req.user.id)

  const countStmt = db.prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ?')
  const result = sessions.map((s) => {
    const c = countStmt.get(s.id).c
    return sessionView(s, c)
  })
  res.json({ sessions: result })
})

router.post('/sessions', (req, res) => {
  const title = String(req.body?.title || '新对话').slice(0, 80)
  const now = nowIso()
  const info = db.prepare('INSERT INTO chat_sessions (user_id, title, created_at, updated_at) VALUES (?, ?, ?, ?)').run(req.user.id, title, now, now)
  const row = db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(info.lastInsertRowid)
  const c = db.prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ?').get(row.id).c
  res.status(201).json({ session: sessionView(row, c) })
})

router.patch('/sessions/:id', (req, res) => {
  const id = toInt(req.params.id)
  if (!id) return res.status(400).json({ error: '无效的会话编号' })
  if (!sessionBelongsToUser(id, req.user.id)) return res.status(404).json({ error: '没有找到这个会话' })
  const title = String(req.body?.title || '').slice(0, 80)
  if (!title) return res.status(400).json({ error: '标题不能为空' })
  db.prepare('UPDATE chat_sessions SET title = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(title, nowIso(), id, req.user.id)
  const c = db.prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ?').get(id).c
  res.json({ session: sessionView(db.prepare('SELECT * FROM chat_sessions WHERE id = ?').get(id), c) })
})

router.delete('/sessions/:id', (req, res) => {
  const id = toInt(req.params.id)
  if (!id) return res.status(400).json({ error: '无效的会话编号' })
  if (!sessionBelongsToUser(id, req.user.id)) return res.status(404).json({ error: '没有找到这个会话' })
  // ON DELETE CASCADE 会自动删消息
  db.prepare('DELETE FROM chat_sessions WHERE id = ? AND user_id = ?').run(id, req.user.id)
  res.json({ ok: true })
})

// ======== 消息列表 ========

router.get('/sessions/:id/messages', (req, res) => {
  const id = toInt(req.params.id)
  if (!id) return res.status(400).json({ error: '无效的会话编号' })
  if (!sessionBelongsToUser(id, req.user.id)) return res.status(404).json({ error: '没有找到这个会话' })

  const proposalRows = db
    .prepare('SELECT * FROM chat_proposals WHERE session_id = ? AND message_id IS NOT NULL ORDER BY id ASC')
    .all(id)
  const byMessage = new Map()
  for (const row of proposalRows) {
    const list = byMessage.get(row.message_id) || []
    list.push(proposalView(row))
    byMessage.set(row.message_id, list)
  }

  const messages = db
    .prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC')
    .all(id)
    .map((row) => messageView(row, byMessage.get(row.id) || []))

  res.json({ messages })
})

// ======== 发送消息 + 获取 AI 回复 ========

function shanghaiToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
}

function shiftDay(day, delta) {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

// 记忆块：关于用户生活的跨会话知识（规则生成，不调模型）
function buildMemoryBlock(userId) {
  const today = shanghaiToday()
  const from = shiftDay(today, -13)

  const report = db
    .prepare('SELECT period_start, period_end, content FROM insights WHERE scope = ? AND user_id = ? ORDER BY period_start DESC LIMIT 1')
    .get('single', userId)

  const records = db
    .prepare('SELECT day, score, original_score, note FROM records WHERE user_id = ? AND day >= ? ORDER BY day ASC')
    .all(userId, from)

  const tagRows = db
    .prepare(
      `SELECT r.day, t.content FROM record_tags t JOIN records r ON r.id = t.record_id
       WHERE t.user_id = ? AND r.day >= ? ORDER BY t.id DESC`
    )
    .all(userId, from)

  const tagsByDay = {}
  for (const t of tagRows) {
    const list = tagsByDay[t.day] || (tagsByDay[t.day] = [])
    if (list.length < 2) list.push(String(t.content || '').replace(/\s+/g, '').slice(0, 10))
  }

  const lines = ['【记忆】', `今天是 ${today}。`]
  if (report) {
    const text = String(report.content || '').replace(/\s+/g, ' ').slice(0, 300)
    lines.push(`最近一份自我分析（${report.period_start} ~ ${report.period_end}）：${text}`)
  }
  if (records.length) {
    lines.push('近 14 天记录（日期 分值 理由）：')
    for (const r of records) {
      const score = r.original_score != null ? `${r.score}（原 ${r.original_score}）` : String(r.score)
      const note = String(r.note || '').replace(/\s+/g, ' ').slice(0, 60)
      const tags = (tagsByDay[r.day] || []).map((t) => `#${t}`).join(' ')
      lines.push(`${r.day.slice(5)} ${score} ${note}${tags ? ` ${tags}` : ''}`.trim())
    }
  } else {
    lines.push('近 14 天没有记录。')
  }
  return lines.join('\n')
}

function buildFactsBlock(userId) {
  const facts = db
    .prepare('SELECT content FROM facts WHERE user_id = ? ORDER BY pinned DESC, id ASC LIMIT 30')
    .all(userId)
  if (!facts.length) return ''
  return '【关于用户的稳定事实】\n' + facts.map((f) => `- ${f.content}`).join('\n')
}

function parseJson(text) {
  try {
    return JSON.parse(text)
  } catch {
    return null
  }
}

// 自上次回复以来用户处理过的提议，拼成一段临时 system（只在本轮请求里出现，不落库）
export function buildProposalNotice(sessionId, userId, since) {
  const rows = db
    .prepare(
      `SELECT kind, status, payload, final_payload, edited FROM chat_proposals
       WHERE session_id = ? AND user_id = ? AND status != 'pending'
         AND decided_at IS NOT NULL AND decided_at > ?
       ORDER BY decided_at ASC, id ASC LIMIT 5`
    )
    .all(sessionId, userId, since || '')
  if (!rows.length) return ''

  const KIND = { fact: '长期记忆', tag: '标签', report: '报告', record: '记录' }
  const STATUS = { accepted: '已采纳', rejected: '已拒绝', expired: '未处理，已作废' }
  const lines = rows.map((r) => {
    const payload = parseJson(r.final_payload || r.payload) || {}
    let preview = ''
    if (r.kind === 'report') {
      preview = payload.periodType === 'month' ? '月度报告' : '周度报告'
    } else if (r.kind === 'record') {
      preview = `${payload.day || ''} ${payload.score != null ? `${payload.score}分` : ''} ${payload.note || ''}`.trim()
    } else {
      preview = String(payload.content || '')
    }
    preview = preview.replace(/\s+/g, ' ').slice(0, 40)

    let status = STATUS[r.status] || r.status
    if (r.status === 'accepted' && r.edited) status = '已采纳（用户修改后保存）'
    if (r.status === 'accepted' && r.kind === 'report') {
      status = '已采纳，前端会触发生成；如需确认结果用 get_report 查'
    }
    return `- [${KIND[r.kind] || r.kind}] ${status}：${preview}`
  })

  return [
    '自上一条回复以来，用户处理了这些建议：',
    ...lines,
    '不要主动催促用户，也不要重复提议；需要时以库里的最终内容为准。'
  ].join('\n')
}

// 纯防失控的安全阈值，不是产品级限制
const MAX_TOOL_STEPS = 8

function mergeUsage(total, usage) {
  if (!usage) return total
  return {
    prompt_tokens: (total.prompt_tokens || 0) + (usage.prompt_tokens || 0),
    completion_tokens: (total.completion_tokens || 0) + (usage.completion_tokens || 0),
    total_tokens: (total.total_tokens || 0) + (usage.total_tokens || 0)
  }
}

/**
 * 工具循环：模型可调用 get_days / get_tags 按需取数。
 * 相同参数的重复调用直接拒绝，避免原地打转。
 */
async function runWithTools(baseMessages, ctx) {
  const work = [...baseMessages]
  const seen = new Set()
  let usage = {}
  let lastPromptTokens = 0
  let lastPromptChars = 0

  for (let step = 0; step < MAX_TOOL_STEPS; step++) {
    lastPromptChars = work.reduce((n, m) => n + String(m.content || '').length, 0)
    const result = await callDeepSeek(work, { functions: FUNCTION_TOOLS })
    usage = mergeUsage(usage, result.usage)
    lastPromptTokens = result.usage?.prompt_tokens || lastPromptTokens

    if (!result.toolCalls) return { content: result.content, usage, lastPromptTokens, lastPromptChars }

    const assistantMsg = { role: 'assistant', content: result.message.content ?? '', tool_calls: result.toolCalls }
    // 思考模式下，带 tool_calls 的 assistant 消息必须把 reasoning_content 原样带回去
    if (result.message.reasoning_content) assistantMsg.reasoning_content = result.message.reasoning_content
    work.push(assistantMsg)

    for (const call of result.toolCalls) {
      const name = call.function?.name
      const rawArgs = call.function?.arguments || '{}'
      const key = `${name}:${rawArgs}`

      let output
      if (seen.has(key)) {
        output = JSON.stringify({
          ok: false,
          reason: 'duplicate_call',
          hint: '同样的查询已经执行过，请缩小范围或换一种查法。'
        })
      } else {
        seen.add(key)
        let args = {}
        try {
          args = JSON.parse(rawArgs)
        } catch {
          args = {}
        }
        output = executeTool(name, args, ctx)
      }

      work.push({ role: 'tool', tool_call_id: call.id, content: output })
    }
  }

  // 步数用尽：明确告知额度用尽并撤掉工具，避免模型把工具调用当文本输出
  work.push({
    role: 'system',
    content: '工具调用额度已用完。不要再调用或输出任何工具调用格式，直接根据已经拿到的信息回答；信息不完整就说明哪部分没查到。'
  })
  lastPromptChars = work.reduce((n, m) => n + String(m.content || '').length, 0)
  const final = await callDeepSeek(work, { tools: false })
  usage = mergeUsage(usage, final.usage)
  lastPromptTokens = final.usage?.prompt_tokens || lastPromptTokens
  return { content: final.content, usage, lastPromptTokens, lastPromptChars }
}

router.post('/sessions/:id/messages', async (req, res) => {
  const id = toInt(req.params.id)
  if (!id) return res.status(400).json({ error: '无效的会话编号' })
  if (!sessionBelongsToUser(id, req.user.id)) return res.status(404).json({ error: '没有找到这个会话' })

  const content = String(req.body?.content || '').trim().slice(0, 2000)
  const refsRaw = req.body?.refs || []
  const refs = Array.isArray(refsRaw)
    ? refsRaw.filter((r) => r && typeof r === 'object' && (r.id || r.content)).map((r) => ({
        id: r.id,
        type: r.type || 'unknown',
        content: r.content ? String(r.content).slice(0, 300) : ''
      }))
    : []

  if (!content) return res.status(400).json({ error: '消息不能为空' })

  // 0. 用户没确认上一轮的建议就继续提问：剩余 pending 一律作废
  const lastAssistantAt =
    db.prepare(`SELECT created_at FROM chat_messages WHERE session_id = ? AND role = 'assistant' ORDER BY id DESC LIMIT 1`).get(id)
      ?.created_at || ''
  db.prepare(
    `UPDATE chat_proposals SET status = 'expired', decided_at = ?
     WHERE session_id = ? AND user_id = ? AND status = 'pending'`
  ).run(nowIso(), id, req.user.id)
  const proposalNotice = buildProposalNotice(id, req.user.id, lastAssistantAt)

  // 1. 压缩：必须在写入本轮消息之前，否则本轮会被误压进摘要
  const compressed = await ensureCompressed(id)

  const now = nowIso()

  // 2. 存 user 消息
  const userInfo = db
    .prepare('INSERT INTO chat_messages (session_id, role, content, refs, created_at) VALUES (?, ?, ?, ?, ?)')
    .run(id, 'user', content, refs.length ? JSON.stringify(refs) : null, now)

  // 更新 session updated_at
  db.prepare('UPDATE chat_sessions SET updated_at = ? WHERE id = ?').run(now, id)

  // 如果是第一次发消息，把标题设成用户第一句的前 30 字（替代默认"新对话"）
  const firstMsg = db.prepare('SELECT COUNT(*) AS c FROM chat_messages WHERE session_id = ?').get(id).c
  const sessionRow = db.prepare('SELECT title FROM chat_sessions WHERE id = ?').get(id)
  if (firstMsg === 1 && (!sessionRow.title || sessionRow.title === '新对话')) {
    const autoTitle = content.replace(/\s+/g, ' ').trim().slice(0, 30) || '新对话'
    db.prepare('UPDATE chat_sessions SET title = ? WHERE id = ?').run(autoTitle, id)
  }

  // 3. 历史：真实 user/assistant 消息（已压缩的部分不再重复发送）
  // 条数上限只是压缩降级时的熔断，正常由 token 阈值压缩兜底
  const history = db
    .prepare(
      `SELECT role, content FROM chat_messages
       WHERE session_id = ? AND id > ? AND id < ?
       ORDER BY id DESC LIMIT 60`
    )
    .all(id, compressed.untilId, userInfo.lastInsertRowid)
    .reverse()
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: String(m.content || '') }))

  // 4. 稳定块 / 事实 / 记忆块 / 压缩摘要
  const displayName = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.user.id)?.display_name || '用户'
  const factsBlock = buildFactsBlock(req.user.id)
  const memoryBlock = buildMemoryBlock(req.user.id)
  const summaryBlock = compressed.summary ? `【本次对话的早期摘要】\n${compressed.summary}` : ''

  // 5. 调模型：稳定前缀 → facts → 记忆 → 压缩摘要 → 历史 → 临时提示 → 本轮
  const messages = buildChatMessages({
    personaPrompt: getDefaultSystemPrompt(),
    displayName,
    factsBlock,
    memoryBlock,
    summaryBlock,
    history,
    noticeBlock: proposalNotice,
    userMessage: content,
    refs
  })

  // 本轮提议收集器：工具执行时 assistant 消息还没落库，先记 id，稍后回填 message_id
  const run = { proposalIds: [], reportCount: 0 }

  try {
    const result = await runWithTools(messages, { userId: req.user.id, sessionId: id, run })

    // 6. 存 assistant 回复（模型只提议时可能没有正文，给一句兜底）
    const assistantText = result.content || (run.proposalIds.length ? '我整理了几条建议，等你确认。' : '')
    const assistantInfo = db
      .prepare(
        'INSERT INTO chat_messages (session_id, role, content, refs, prompt_tokens, prompt_chars, created_at) VALUES (?, ?, ?, NULL, ?, ?, ?)'
      )
      .run(id, 'assistant', assistantText, result.lastPromptTokens, result.lastPromptChars, nowIso())

    // 7. 把本轮提议绑定到这条 assistant 消息
    if (run.proposalIds.length) {
      const placeholders = run.proposalIds.map(() => '?').join(',')
      db.prepare(
        `UPDATE chat_proposals SET message_id = ?
         WHERE session_id = ? AND user_id = ? AND id IN (${placeholders})`
      ).run(assistantInfo.lastInsertRowid, id, req.user.id, ...run.proposalIds)
    }

    // 8. 返回
    const assistantMsg = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(assistantInfo.lastInsertRowid)
    const proposals = run.proposalIds.length
      ? db
          .prepare(`SELECT * FROM chat_proposals WHERE id IN (${run.proposalIds.map(() => '?').join(',')}) ORDER BY id ASC`)
          .all(...run.proposalIds)
          .map(proposalView)
      : []
    res.status(201).json({
      userMessage: db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(userInfo.lastInsertRowid),
      assistantMessage: messageView(assistantMsg, proposals),
      usage: result.usage
    })
  } catch (err) {
    // 调用失败：本轮未绑定的提议直接清掉，避免孤儿
    if (run.proposalIds.length) {
      db.prepare(`DELETE FROM chat_proposals WHERE id IN (${run.proposalIds.map(() => '?').join(',')})`).run(...run.proposalIds)
    }
    console.error('[chat] 调用失败:', err.message)
    res.status(500).json({ error: 'AI 暂时不可用，请稍后再试' })
  }
})

export default router
