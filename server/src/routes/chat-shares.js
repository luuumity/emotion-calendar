// 会话分享：把会话消息快照成一条独立记录，公开链接只读访问。
// 快照只保留 role/content，不包含 proposal、refs、facts 等内部状态。

import crypto from 'node:crypto'
import { Router } from 'express'
import { db } from '../db.js'
import { requireUser } from '../auth.js'

const router = Router()
router.use(requireUser)

// 单次分享的内容上限，防止超大会话撑爆响应
const MAX_MESSAGES = 300
const MAX_CHARS = 200000

function nowIso() {
  return new Date().toISOString()
}

function sessionBelongsToUser(sessionId, userId) {
  return !!db.prepare('SELECT id FROM chat_sessions WHERE id = ? AND user_id = ?').get(sessionId, userId)
}

function activeShareOfSession(sessionId) {
  return db
    .prepare('SELECT * FROM chat_shares WHERE session_id = ? AND revoked = 0 ORDER BY id DESC LIMIT 1')
    .get(sessionId)
}

function messageCountOf(row) {
  try {
    const list = JSON.parse(row.messages)
    return Array.isArray(list) ? list.length : 0
  } catch {
    return 0
  }
}

function messageIdsOf(row) {
  try {
    const list = JSON.parse(row.messages)
    return Array.isArray(list) ? list.map((item) => item.id).filter((id) => Number.isInteger(id)) : []
  } catch {
    return []
  }
}

function shareView(row) {
  if (!row) return null
  return {
    id: row.id,
    token: row.token,
    sessionId: row.session_id,
    title: row.title,
    revoked: Boolean(row.revoked),
    viewCount: row.view_count,
    messageCount: messageCountOf(row),
    messageIds: messageIdsOf(row),
    createdAt: row.created_at
  }
}

/** 取当前会话的分享（没有则 share 为 null），用于弹窗先查后建。 */
router.get('/sessions/:id/share', (req, res) => {
  const sessionId = Number(req.params.id)
  if (!Number.isInteger(sessionId) || sessionId <= 0) return res.status(400).json({ error: '无效的会话编号' })
  if (!sessionBelongsToUser(sessionId, req.user.id)) return res.status(404).json({ error: '没有找到这个会话' })
  res.json({ share: shareView(activeShareOfSession(sessionId)) })
})

/**
 * 创建分享。已存在未撤销的分享时直接复用，避免同一会话堆积多条链接。
 * 可选 messageIds：只分享指定消息（为后续“勾选消息分享”预留）。
 */
router.post('/sessions/:id/share', (req, res) => {
  const sessionId = Number(req.params.id)
  if (!Number.isInteger(sessionId) || sessionId <= 0) return res.status(400).json({ error: '无效的会话编号' })
  if (!sessionBelongsToUser(sessionId, req.user.id)) return res.status(404).json({ error: '没有找到这个会话' })

  const existing = activeShareOfSession(sessionId)
  if (existing) return res.json({ share: shareView(existing), reused: true })

  const wanted = Array.isArray(req.body?.messageIds)
    ? new Set(req.body.messageIds.map(Number).filter((n) => Number.isInteger(n) && n > 0))
    : null

  const rows = db
    .prepare(
      `SELECT id, role, content FROM chat_messages
       WHERE session_id = ? AND role IN ('user', 'assistant')
       ORDER BY created_at ASC, id ASC`
    )
    .all(sessionId)

  const picked = wanted ? rows.filter((row) => wanted.has(row.id)) : rows
  if (!picked.length) return res.status(400).json({ error: '这个会话还没有可分享的内容' })
  if (picked.length > MAX_MESSAGES) {
    return res.status(400).json({ error: `会话消息太多（超过 ${MAX_MESSAGES} 条），暂不支持分享` })
  }

  const messages = picked.map((row) => ({ id: row.id, role: row.role, content: row.content }))
  const chars = messages.reduce((sum, m) => sum + m.content.length, 0)
  if (chars > MAX_CHARS) {
    return res.status(400).json({ error: '会话内容太长，暂不支持分享' })
  }

  const session = db.prepare('SELECT title FROM chat_sessions WHERE id = ?').get(sessionId)
  const token = crypto.randomBytes(16).toString('base64url')
  const createdAt = nowIso()

  const info = db
    .prepare(
      `INSERT INTO chat_shares (token, owner_id, session_id, title, messages, revoked, view_count, created_at)
       VALUES (?, ?, ?, ?, ?, 0, 0, ?)`
    )
    .run(token, req.user.id, sessionId, session?.title || '一段对话', JSON.stringify(messages), createdAt)

  const row = db.prepare('SELECT * FROM chat_shares WHERE id = ?').get(info.lastInsertRowid)
  console.log(`[share] 创建会话分享 user=${req.user.id} session=${sessionId} messages=${messages.length}`)
  res.json({ share: shareView(row), reused: false })
})

/** 撤销分享：只标记，不删除快照，便于排查与统计。 */
router.delete('/shares/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id) || id <= 0) return res.status(400).json({ error: '无效的分享编号' })
  const row = db.prepare('SELECT id FROM chat_shares WHERE id = ? AND owner_id = ?').get(id, req.user.id)
  if (!row) return res.status(404).json({ error: '没有找到这个分享' })
  db.prepare('UPDATE chat_shares SET revoked = 1 WHERE id = ?').run(id)
  res.json({ ok: true })
})

export default router
