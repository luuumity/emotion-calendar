import fs from 'node:fs'
import path from 'node:path'
import crypto from 'node:crypto'
import { fileURLToPath } from 'node:url'
import jwt from 'jsonwebtoken'
import { db } from './db.js'

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const secretFile =
  process.env.JWT_SECRET_FILE || path.resolve(__dirname, '../data/jwt-secret.txt')

function loadSecret() {
  if (process.env.JWT_SECRET) return process.env.JWT_SECRET
  fs.mkdirSync(path.dirname(secretFile), { recursive: true })
  if (fs.existsSync(secretFile)) return fs.readFileSync(secretFile, 'utf8').trim()
  const secret = crypto.randomBytes(48).toString('hex')
  fs.writeFileSync(secretFile, secret, { mode: 0o600 })
  return secret
}

const JWT_SECRET = loadSecret()
export const COOKIE_NAME = 'ec_token'
const MAX_AGE_MS = 1000 * 60 * 60 * 24 * 30

export function setSessionCookie(res, user) {
  const token = jwt.sign({ uid: user.id }, JWT_SECRET, { expiresIn: '30d' })
  res.cookie(COOKIE_NAME, token, {
    httpOnly: true,
    sameSite: 'lax',
    secure: process.env.COOKIE_SECURE === '1',
    maxAge: MAX_AGE_MS,
    path: '/'
  })
}

export function clearSessionCookie(res) {
  res.clearCookie(COOKIE_NAME, { path: '/' })
}

export function publicUser(user) {
  return { id: user.id, username: user.username, displayName: user.display_name }
}

export function attachUser(req, _res, next) {
  const token = req.cookies?.[COOKIE_NAME]
  if (token) {
    try {
      const payload = jwt.verify(token, JWT_SECRET)
      const user = db.prepare('SELECT * FROM users WHERE id = ?').get(payload.uid)
      if (user) req.user = user
    } catch {
      // ignore invalid/expired token
    }
  }
  next()
}

export function requireUser(req, res, next) {
  if (!req.user) return res.status(401).json({ error: '请先登录' })
  next()
}
