// 公开分享读取：不需要登录，只按不可猜测的 token 返回只读快照。

import { Router } from 'express'
import { db } from '../db.js'

const router = Router()

const TOKEN_RE = /^[A-Za-z0-9_-]{20,40}$/
const WINDOW_MS = 60 * 1000
const MAX_PER_WINDOW = 120

// 简单的内存限流，防止有人暴力枚举 token。单进程部署，够用。
const hits = new Map()

function rateLimited(ip) {
  const now = Date.now()
  const list = (hits.get(ip) || []).filter((t) => now - t < WINDOW_MS)
  if (list.length >= MAX_PER_WINDOW) {
    hits.set(ip, list)
    return true
  }
  list.push(now)
  hits.set(ip, list)
  if (hits.size > 5000) hits.clear()
  return false
}

router.get('/shares/:token', (req, res) => {
  res.setHeader('X-Robots-Tag', 'noindex, nofollow')
  const token = String(req.params.token || '')
  if (!TOKEN_RE.test(token)) return res.status(404).json({ error: '分享不存在或已失效' })
  if (rateLimited(req.ip || 'unknown')) return res.status(429).json({ error: '访问太频繁，稍后再试' })

  const row = db.prepare('SELECT * FROM chat_shares WHERE token = ? AND revoked = 0').get(token)
  if (!row) return res.status(404).json({ error: '分享不存在或已失效' })

  let messages = []
  try {
    messages = JSON.parse(row.messages)
  } catch {
    messages = []
  }

  db.prepare('UPDATE chat_shares SET view_count = view_count + 1 WHERE id = ?').run(row.id)

  res.json({
    share: {
      title: row.title,
      messages,
      createdAt: row.created_at,
      viewCount: row.view_count + 1
    }
  })
})

export default router
