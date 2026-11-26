// Facts CRUD
// 用户自己的稳定事实，完全可控。置信度 1-5，couple_visible 默认 0。

import { Router } from 'express'
import { db } from '../db.js'
import { requireUser } from '../auth.js'
import { checkFactAdd, checkFactUpdate, FACT_MAX_CONTENT_CHARS } from '../lib/facts.js'

const router = Router()
router.use(requireUser)

const SELECT = 'id, content, confidence, source, source_ref_id, couple_visible, pinned, created_at, updated_at'
const SELECT_ALL = db.prepare(`SELECT ${SELECT} FROM facts WHERE user_id = ? ORDER BY pinned DESC, confidence DESC, id DESC`)
const SELECT_ONE = db.prepare(`SELECT ${SELECT} FROM facts WHERE id = ? AND user_id = ?`)
const INSERT = db.prepare(
  `INSERT INTO facts (user_id, content, confidence, source, source_ref_id, couple_visible, pinned, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`
)
const UPDATE = db.prepare(
  `UPDATE facts SET content = ?, confidence = ?, source = ?, source_ref_id = ?, couple_visible = ?, pinned = ?, updated_at = ?
   WHERE id = ? AND user_id = ?`
)
const REMOVE = db.prepare('DELETE FROM facts WHERE id = ? AND user_id = ?')

const CONFIDENCE_RE = /^[1-5]$/

function toContent(input) {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed || trimmed.length > FACT_MAX_CONTENT_CHARS) return null
  return trimmed
}

function toConfidence(input) {
  const n = Number(input)
  return CONFIDENCE_RE.test(String(n)) ? n : null
}

function toSource(input) {
  if (input === 'agent_extracted' || input === 'report_derived') return input
  return 'user'
}

function toInt(input, fallback = null) {
  const n = Number(input)
  return Number.isInteger(n) ? n : fallback
}

function toFlag(input) {
  return input ? 1 : 0
}

function view(row) {
  if (!row) return null
  return {
    id: row.id,
    content: row.content,
    confidence: row.confidence,
    source: row.source,
    sourceRefId: row.source_ref_id,
    coupleVisible: Boolean(row.couple_visible),
    pinned: Boolean(row.pinned),
    createdAt: row.created_at,
    updatedAt: row.updated_at
  }
}

router.get('/', (req, res) => {
  res.json({ facts: SELECT_ALL.all(req.user.id).map(view) })
})

router.post('/', (req, res) => {
  const content = toContent(req.body?.content)
  if (!content) return res.status(400).json({ error: `事实内容需为 1-${FACT_MAX_CONTENT_CHARS} 字的文本` })

  const confidence = toConfidence(req.body?.confidence) ?? 3
  const source = toSource(req.body?.source)
  const sourceRefId = toInt(req.body?.sourceRefId)
  const coupleVisible = toFlag(req.body?.coupleVisible)
  const pinned = toFlag(req.body?.pinned)
  const now = new Date().toISOString()

  // 查重：同用户已存在完全相同内容的，返回 409
  const dup = db.prepare('SELECT id FROM facts WHERE user_id = ? AND content = ?').get(req.user.id, content)
  if (dup) return res.status(409).json({ error: '已存在相同内容的事实', existingId: dup.id })

  const quota = checkFactAdd(req.user.id, content)
  if (!quota.ok) return res.status(409).json({ error: quota.hint, usage: quota.usage })

  const info = INSERT.run(req.user.id, content, confidence, source, sourceRefId, coupleVisible, pinned, now, now)
  res.status(201).json({ fact: view(SELECT_ONE.get(info.lastInsertRowid, req.user.id)) })
})

router.put('/:id', (req, res) => {
  const id = toInt(req.params.id)
  if (!id) return res.status(400).json({ error: '无效的事实编号' })
  const row = SELECT_ONE.get(id, req.user.id)
  if (!row) return res.status(404).json({ error: '没有找到这条事实' })

  let content = row.content
  if (req.body?.content !== undefined) {
    const next = toContent(req.body.content)
    if (!next) return res.status(400).json({ error: `内容需为 1-${FACT_MAX_CONTENT_CHARS} 字的文本，并去掉首尾空白` })
    content = next
  }

  let confidence = row.confidence
  if (req.body?.confidence !== undefined) {
    const next = toConfidence(req.body.confidence)
    if (!next) return res.status(400).json({ error: '置信度需为 1-5 的整数' })
    confidence = next
  }

  if (content !== row.content) {
    const quota = checkFactUpdate(req.user.id, row.content, content)
    if (!quota.ok) return res.status(409).json({ error: quota.hint, usage: quota.usage })
  }

  const source = req.body?.source !== undefined ? toSource(req.body.source) : row.source
  const sourceRefId = req.body?.sourceRefId !== undefined ? toInt(req.body.sourceRefId) : row.source_ref_id
  const coupleVisible = req.body?.coupleVisible !== undefined ? toFlag(req.body.coupleVisible) : row.couple_visible
  const pinned = req.body?.pinned !== undefined ? toFlag(req.body.pinned) : row.pinned
  const now = new Date().toISOString()

  UPDATE.run(content, confidence, source, sourceRefId, coupleVisible, pinned, now, id, req.user.id)
  res.json({ fact: view(SELECT_ONE.get(id, req.user.id)) })
})

router.delete('/:id', (req, res) => {
  const id = toInt(req.params.id)
  if (!id) return res.status(400).json({ error: '无效的事实编号' })
  const info = REMOVE.run(id, req.user.id)
  if (info.changes === 0) return res.status(404).json({ error: '没有找到这条事实' })
  res.json({ ok: true })
})

// 切换 couple_visible（快捷接口，不用 PUT 整条）
router.post('/:id/toggle-visibility', (req, res) => {
  const id = toInt(req.params.id)
  if (!id) return res.status(400).json({ error: '无效的事实编号' })
  const row = SELECT_ONE.get(id, req.user.id)
  if (!row) return res.status(404).json({ error: '没有找到这条事实' })
  const next = row.couple_visible ? 0 : 1
  const now = new Date().toISOString()
  db.prepare('UPDATE facts SET couple_visible = ?, updated_at = ? WHERE id = ? AND user_id = ?').run(next, now, id, req.user.id)
  res.json({ fact: view(SELECT_ONE.get(id, req.user.id)) })
})

export default router
