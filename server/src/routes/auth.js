import { Router } from 'express'
import bcrypt from 'bcryptjs'
import { db } from '../db.js'
import { setSessionCookie, clearSessionCookie, publicUser, requireUser } from '../auth.js'

const router = Router()

router.post('/register', (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  const displayName = String(req.body?.displayName || '').trim()

  if (!/^[a-z0-9_]{3,20}$/.test(username)) {
    return res.status(400).json({ error: '用户名需为 3-20 位字母、数字或下划线' })
  }
  if (password.length < 6) {
    return res.status(400).json({ error: '密码至少 6 位' })
  }
  if (displayName.length < 1 || displayName.length > 20) {
    return res.status(400).json({ error: '昵称需为 1-20 个字符' })
  }

  const exists = db.prepare('SELECT id FROM users WHERE username = ?').get(username)
  if (exists) return res.status(409).json({ error: '这个用户名已经被占用了' })

  const passwordHash = bcrypt.hashSync(password, 10)
  const info = db
    .prepare('INSERT INTO users (username, display_name, password_hash, created_at) VALUES (?, ?, ?, ?)')
    .run(username, displayName, passwordHash, new Date().toISOString())

  const user = db.prepare('SELECT * FROM users WHERE id = ?').get(info.lastInsertRowid)
  setSessionCookie(res, user)
  res.json({ user: publicUser(user) })
})

router.post('/login', (req, res) => {
  const username = String(req.body?.username || '').trim().toLowerCase()
  const password = String(req.body?.password || '')
  const user = db.prepare('SELECT * FROM users WHERE username = ?').get(username)
  if (!user || !bcrypt.compareSync(password, user.password_hash)) {
    return res.status(401).json({ error: '用户名或密码不对' })
  }
  setSessionCookie(res, user)
  res.json({ user: publicUser(user) })
})

router.post('/logout', (_req, res) => {
  clearSessionCookie(res)
  res.json({ ok: true })
})

router.get('/me', requireUser, (req, res) => {
  res.json({ user: publicUser(req.user) })
})

export default router
