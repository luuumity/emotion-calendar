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

function messageView(row) {
  if (!row) return null
  let refs = null
  try { refs = row.refs ? JSON.parse(row.refs) : null } catch { refs = null }
  return {
    id: row.id,
    role: row.role,
    content: row.content,
    refs,
    createdAt: row.created_at
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

  const messages = db
    .prepare('SELECT * FROM chat_messages WHERE session_id = ? ORDER BY created_at ASC, id ASC')
    .all(id)
    .map(messageView)

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

  // 0. 压缩：必须在写入本轮消息之前，否则本轮会被误压进摘要
  const compressed = await ensureCompressed(id)

  const now = nowIso()

  // 1. 存 user 消息
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

  // 2. 历史：真实 user/assistant 消息（已压缩的部分不再重复发送，最多 12 条）
  const history = db
    .prepare(
      `SELECT role, content FROM chat_messages
       WHERE session_id = ? AND id > ? AND id < ?
       ORDER BY id DESC LIMIT 12`
    )
    .all(id, compressed.untilId, userInfo.lastInsertRowid)
    .reverse()
    .filter((m) => m.role === 'user' || m.role === 'assistant')
    .map((m) => ({ role: m.role, content: String(m.content || '').slice(0, 800) }))

  // 3. 稳定块 / 事实 / 记忆块 / 压缩摘要
  const displayName = db.prepare('SELECT display_name FROM users WHERE id = ?').get(req.user.id)?.display_name || '用户'
  const factsBlock = buildFactsBlock(req.user.id)
  const memoryBlock = buildMemoryBlock(req.user.id)
  const summaryBlock = compressed.summary ? `【本次对话的早期摘要】\n${compressed.summary}` : ''

  // 4. 调模型：稳定前缀 → facts → 记忆 → 压缩摘要 → 历史 → 本轮
  const messages = buildChatMessages({
    personaPrompt: getDefaultSystemPrompt(),
    displayName,
    factsBlock,
    memoryBlock,
    summaryBlock,
    history,
    userMessage: content,
    refs
  })

  try {
    const result = await callDeepSeek(messages)

    // 5. 存 assistant 回复
    const assistantInfo = db
      .prepare('INSERT INTO chat_messages (session_id, role, content, refs, created_at) VALUES (?, ?, ?, NULL, ?)')
      .run(id, 'assistant', result.content, nowIso())

    // 6. 返回
    const assistantMsg = db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(assistantInfo.lastInsertRowid)
    res.status(201).json({
      userMessage: db.prepare('SELECT * FROM chat_messages WHERE id = ?').get(userInfo.lastInsertRowid),
      assistantMessage: messageView(assistantMsg),
      usage: result.usage
    })
  } catch (err) {
    console.error('[chat] 调用失败:', err.message)
    res.status(500).json({ error: 'AI 暂时不可用，请稍后再试' })
  }
})

export default router
