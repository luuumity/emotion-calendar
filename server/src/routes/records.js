import { Router } from 'express'
import { db } from '../db.js'
import { requireUser } from '../auth.js'

const router = Router()
router.use(requireUser)

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const NOTE_LIMIT = 2000

function toDate(day) {
  return DAY_RE.test(String(day || '')) ? String(day) : null
}

router.get('/', (req, res) => {
  const from = toDate(req.query.from)
  const to = toDate(req.query.to)
  if (!from || !to) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' })

  const rows = db
    .prepare('SELECT day, score, note, updated_at FROM records WHERE user_id = ? AND day BETWEEN ? AND ? ORDER BY day')
    .all(req.user.id, from, to)

  res.json({ records: rows.map((r) => ({ day: r.day, score: r.score, note: r.note, updatedAt: r.updated_at })) })
})

router.put('/:day', (req, res) => {
  const day = toDate(req.params.day)
  if (!day) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' })

  const score = Number(req.body?.score)
  if (!Number.isInteger(score) || score < 0 || score > 100) {
    return res.status(400).json({ error: '感受值需为 0-100 的整数' })
  }

  const note = typeof req.body?.note === 'string' ? req.body.note.slice(0, NOTE_LIMIT) : undefined
  const now = new Date().toISOString()

  if (note === undefined) {
    db.prepare(
      `INSERT INTO records (user_id, day, score, note, updated_at) VALUES (?, ?, ?, '', ?)
       ON CONFLICT(user_id, day) DO UPDATE SET score = excluded.score, updated_at = excluded.updated_at`
    ).run(req.user.id, day, score, now)
  } else {
    db.prepare(
      `INSERT INTO records (user_id, day, score, note, updated_at) VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(user_id, day) DO UPDATE SET score = excluded.score, note = excluded.note, updated_at = excluded.updated_at`
    ).run(req.user.id, day, score, note, now)
  }

  const saved = db.prepare('SELECT day, score, note, updated_at FROM records WHERE user_id = ? AND day = ?').get(req.user.id, day)
  res.json({ record: { day: saved.day, score: saved.score, note: saved.note, updatedAt: saved.updated_at } })
})

router.delete('/:day', (req, res) => {
  const day = toDate(req.params.day)
  if (!day) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' })
  db.prepare('DELETE FROM records WHERE user_id = ? AND day = ?').run(req.user.id, day)
  res.json({ ok: true })
})

export default router
