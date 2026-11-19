import { Router } from 'express'
import { db } from '../db.js'
import { requireUser } from '../auth.js'

const router = Router()
router.use(requireUser)

const DAY_RE = /^\d{4}-\d{2}-\d{2}$/
const NOTE_LIMIT = 2000

const SELECT_FIELDS = 'id, day, score, note, created_at, updated_at, original_score, adjusted_at'
const selectOne = db.prepare(`SELECT ${SELECT_FIELDS} FROM records WHERE id = ? AND user_id = ?`)

function toDate(day) {
  return DAY_RE.test(String(day || '')) ? String(day) : null
}

function toScore(input) {
  const score = Number(input)
  return Number.isInteger(score) && score >= 0 && score <= 100 ? score : null
}

function toNote(input) {
  return typeof input === 'string' ? input.slice(0, NOTE_LIMIT) : null
}

function view(row) {
  return {
    id: row.id,
    day: row.day,
    score: row.score,
    note: row.note,
    originalScore: row.original_score,
    adjustedAt: row.adjusted_at,
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

router.get('/', (req, res) => {
  const from = toDate(req.query.from)
  const to = toDate(req.query.to)
  if (!from || !to) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' })

  const rows = db
    .prepare(`SELECT ${SELECT_FIELDS} FROM records WHERE user_id = ? AND day BETWEEN ? AND ? ORDER BY day, id`)
    .all(req.user.id, from, to)

  res.json({ records: rows.map(view) })
})

router.post('/', (req, res) => {
  const day = toDate(req.body?.day)
  if (!day) return res.status(400).json({ error: '日期格式应为 YYYY-MM-DD' })

  const score = toScore(req.body?.score)
  if (score === null) return res.status(400).json({ error: '感受值需为 0-100 的整数' })

  const note = toNote(req.body?.note) ?? ''
  const now = new Date().toISOString()

  const info = db
    .prepare('INSERT INTO records (user_id, day, score, note, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)')
    .run(req.user.id, day, score, note, now, now)

  res.status(201).json({ record: view(selectOne.get(info.lastInsertRowid, req.user.id)) })
})

router.put('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: '无效的扭蛋编号' })

  const existing = selectOne.get(id, req.user.id)
  if (!existing) return res.status(404).json({ error: '没有找到这颗扭蛋' })

  const hasScore = req.body?.score !== undefined
  const hasNote = req.body?.note !== undefined
  if (!hasScore && !hasNote) return res.status(400).json({ error: '没有需要更新的内容' })

  let score = existing.score
  let note = existing.note
  let originalScore = existing.original_score
  let adjustedAt = existing.adjusted_at
  let updatedAt = existing.updated_at
  let changed = false
  const now = new Date().toISOString()

  if (hasScore) {
    const nextScore = toScore(req.body.score)
    if (nextScore === null) return res.status(400).json({ error: '感受值需为 0-100 的整数' })
    if (nextScore !== existing.score) {
      // original_score 只在第一次调整时落库，后续调整只更新时间
      originalScore = existing.original_score ?? existing.score
      score = nextScore
      adjustedAt = now
      updatedAt = now
      changed = true
    }
  }

  if (hasNote) {
    const nextNote = toNote(req.body.note)
    if (nextNote === null) return res.status(400).json({ error: '理由需为文本' })
    if (nextNote !== existing.note) {
      note = nextNote
      updatedAt = now
      changed = true
    }
  }

  if (changed) {
    db.prepare(
      'UPDATE records SET score = ?, note = ?, original_score = ?, adjusted_at = ?, updated_at = ? WHERE id = ? AND user_id = ?'
    ).run(score, note, originalScore, adjustedAt, updatedAt, id, req.user.id)
  }

  res.json({ record: view(selectOne.get(id, req.user.id)) })
})

router.delete('/:id', (req, res) => {
  const id = Number(req.params.id)
  if (!Number.isInteger(id)) return res.status(400).json({ error: '无效的扭蛋编号' })

  const info = db.prepare('DELETE FROM records WHERE id = ? AND user_id = ?').run(id, req.user.id)
  if (info.changes === 0) return res.status(404).json({ error: '没有找到这颗扭蛋' })

  res.json({ ok: true })
})

export default router
