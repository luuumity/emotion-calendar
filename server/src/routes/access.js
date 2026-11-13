import crypto from 'node:crypto'
import { Router } from 'express'
import { db } from '../db.js'
import { requireUser } from '../auth.js'

const router = Router()
router.use(requireUser)

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

function normalizeToken(input) {
  return String(input || '').toUpperCase().replace(/[^A-Z0-9]/g, '')
}

function makeToken() {
  for (let i = 0; i < 10; i += 1) {
    const token = crypto.randomBytes(8).toString('hex').toUpperCase()
    if (!db.prepare('SELECT id FROM shares WHERE token = ?').get(token)) return token
  }
  throw new Error('生成凭证失败，请重试')
}

function formatToken(token) {
  return token.match(/.{1,4}/g).join('-')
}

function shareView(row) {
  return {
    id: row.id,
    token: formatToken(row.token),
    scope: row.scope,
    label: row.label,
    revoked: Boolean(row.revoked),
    createdAt: row.created_at,
    viewers: row.viewers || []
  }
}

router.get('/', (req, res) => {
  const shares = db
    .prepare('SELECT * FROM shares WHERE owner_id = ? ORDER BY id DESC')
    .all(req.user.id)

  const viewerStmt = db.prepare(
    `SELECT g.viewer_id, g.scope, g.created_at, u.display_name
     FROM grants g JOIN users u ON u.id = g.viewer_id
     WHERE g.share_id = ? ORDER BY g.id`
  )

  const mine = shares.map((share) =>
    shareView({
      ...share,
      viewers: viewerStmt.all(share.id).map((v) => ({
        id: v.viewer_id,
        displayName: v.display_name,
        scope: v.scope,
        acceptedAt: v.created_at
      }))
    })
  )

  const granted = db
    .prepare(
      `SELECT g.owner_id, g.scope, g.created_at, s.revoked, u.display_name, u.username
       FROM grants g
       JOIN shares s ON s.id = g.share_id
       JOIN users u ON u.id = g.owner_id
       WHERE g.viewer_id = ? AND s.revoked = 0
       ORDER BY g.id`
    )
    .all(req.user.id)
    .map((g) => ({
      id: g.owner_id,
      displayName: g.display_name,
      username: g.username,
      scope: g.scope,
      since: g.created_at
    }))

  res.json({ mine, granted })
})

router.post('/shares', (req, res) => {
  const scope = req.body?.scope === 'full' ? 'full' : 'colors'
  const label = String(req.body?.label || '').trim().slice(0, 30)
  const token = makeToken()
  const createdAt = new Date().toISOString()

  db.prepare('INSERT INTO shares (owner_id, token, scope, label, created_at) VALUES (?, ?, ?, ?, ?)').run(
    req.user.id,
    token,
    scope,
    label,
    createdAt
  )

  const share = db.prepare('SELECT * FROM shares WHERE token = ?').get(token)
  res.status(201).json({ share: shareView(share) })
})

router.post('/redeem', (req, res) => {
  const token = normalizeToken(req.body?.token)
  if (token.length < 8) return res.status(400).json({ error: '请输入完整的授权凭证' })

  const share = db.prepare('SELECT * FROM shares WHERE token = ?').get(token)
  if (!share) return res.status(404).json({ error: '凭证不存在，检查一下有没有输漏' })
  if (share.revoked) return res.status(410).json({ error: '这份授权已经被撤销了' })
  if (share.owner_id === req.user.id) return res.status(400).json({ error: '这是你自己的凭证' })

  const now = new Date().toISOString()
  db.prepare(
    `INSERT INTO grants (share_id, owner_id, viewer_id, scope, created_at) VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(owner_id, viewer_id) DO UPDATE SET share_id = excluded.share_id, scope = excluded.scope, created_at = excluded.created_at`
  ).run(share.id, share.owner_id, req.user.id, share.scope, now)

  const owner = db.prepare('SELECT id, display_name, username FROM users WHERE id = ?').get(share.owner_id)
  res.json({
    granted: {
      id: owner.id,
      displayName: owner.display_name,
      username: owner.username,
      scope: share.scope,
      since: now
    }
  })
})

router.post('/shares/:id/revoke', (req, res) => {
  const share = db
    .prepare('SELECT * FROM shares WHERE id = ? AND owner_id = ?')
    .get(Number(req.params.id), req.user.id)
  if (!share) return res.status(404).json({ error: '没有找到这份授权' })
  db.prepare('UPDATE shares SET revoked = 1 WHERE id = ?').run(share.id)
  res.json({ ok: true })
})

router.delete('/granted/:ownerId', (req, res) => {
  db.prepare('DELETE FROM grants WHERE viewer_id = ? AND owner_id = ?').run(req.user.id, Number(req.params.ownerId))
  res.json({ ok: true })
})

router.get('/people/:ownerId/records', (req, res) => {
  const ownerId = Number(req.params.ownerId)
  const from = String(req.query.from || '')
  const to = String(req.query.to || '')
  if (!DAY_RE.test(from) || !DAY_RE.test(to)) {
    return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' })
  }

  const grant = db
    .prepare(
      `SELECT g.scope, g.owner_id, s.revoked, u.display_name
       FROM grants g
       JOIN shares s ON s.id = g.share_id
       JOIN users u ON u.id = g.owner_id
       WHERE g.owner_id = ? AND g.viewer_id = ?`
    )
    .get(ownerId, req.user.id)

  if (!grant || grant.revoked) return res.status(403).json({ error: '你没有查看这个人的授权' })

  const rows = db
    .prepare('SELECT id, day, score, note, created_at, updated_at FROM records WHERE user_id = ? AND day BETWEEN ? AND ? ORDER BY day, id')
    .all(ownerId, from, to)

  res.json({
    owner: { id: grant.owner_id, displayName: grant.display_name },
    scope: grant.scope,
    records: rows.map((r) => {
      const base = { id: r.id, day: r.day, score: r.score, createdAt: r.created_at, updatedAt: r.updated_at }
      if (grant.scope === 'full') return { ...base, note: r.note }
      return { ...base, hasNote: Boolean(r.note && r.note.trim()) }
    })
  })
})

export default router
