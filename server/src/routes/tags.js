// Record Tags CRUD
// 附着在具体记录上的 AI 洞察/建议/模式/修正
// 标签由 agent 提议 → 用户确认后写入；couple_visible 默认关
// 支持批量（一条记录可能有多条标签）

import { Router } from 'express'
import { db } from '../db.js'
import { requireUser } from '../auth.js'

const router = Router()
router.use(requireUser)

const TAG_TYPES = ['insight', 'suggestion', 'pattern', 'correction']
const SOURCES = ['user', 'agent']

const SELECT_ALL_BY_RECORD = db.prepare(
  `SELECT t.*, r.day AS record_day FROM record_tags t
   JOIN records r ON r.id = t.record_id
   WHERE t.user_id = ? AND t.record_id = ?
   ORDER BY t.id DESC`
)
const SELECT_ONE = db.prepare(
  `SELECT t.*, r.day AS record_day FROM record_tags t
   JOIN records r ON r.id = t.record_id
   WHERE t.id = ? AND t.user_id = ?`
)
const INSERT = db.prepare(
  `INSERT INTO record_tags (record_id, user_id, tag_type, content, source, source_ref_message_id, couple_visible, created_at)
   VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
)
const REMOVE = db.prepare('DELETE FROM record_tags WHERE id = ? AND user_id = ?')
const UPDATE_VISIBILITY = db.prepare('UPDATE record_tags SET couple_visible = ? WHERE id = ? AND user_id = ?')

function toInt(input, fallback = null) {
  const n = Number(input)
  return Number.isInteger(n) ? n : fallback
}

function toContent(input) {
  if (typeof input !== 'string') return null
  const trimmed = input.trim()
  if (!trimmed || trimmed.length > 500) return null
  return trimmed
}

function toTagType(input) {
  return TAG_TYPES.includes(input) ? input : null
}

function toSource(input) {
  return SOURCES.includes(input) ? input : 'agent'
}

function toFlag(input) {
  return input ? 1 : 0
}

function view(row) {
  if (!row) return null
  return {
    id: row.id,
    recordId: row.record_id,
    recordDay: row.record_day,
    tagType: row.tag_type,
    content: row.content,
    source: row.source,
    sourceRefMessageId: row.source_ref_message_id,
    coupleVisible: Boolean(row.couple_visible),
    createdAt: row.created_at
  }
}

function recordBelongsToUser(recordId, userId) {
  return !!db.prepare('SELECT id FROM records WHERE id = ? AND user_id = ?').get(recordId, userId)
}

// 列出某条记录的全部 AI 标签
router.get('/of-record/:recordId', (req, res) => {
  const recordId = toInt(req.params.recordId)
  if (!recordId) return res.status(400).json({ error: '无效的扭蛋编号' })
  if (!recordBelongsToUser(recordId, req.user.id)) return res.status(404).json({ error: '没有找到这颗扭蛋' })

  const rows = SELECT_ALL_BY_RECORD.all(req.user.id, recordId)
  res.json({ tags: rows.map(view) })
})

// 新建一条标签（agent 提议或用户手动标记都走这里）
router.post('/', (req, res) => {
  const recordId = toInt(req.body?.recordId)
  const tagType = toTagType(req.body?.tagType)
  const content = toContent(req.body?.content)
  if (!recordId) return res.status(400).json({ error: '无效的扭蛋编号' })
  if (!tagType) return res.status(400).json({ error: '标签类型必须是 insight/suggestion/pattern/correction 之一' })
  if (!content) return res.status(400).json({ error: '标签内容需为 1-500 字的文本' })
  if (!recordBelongsToUser(recordId, req.user.id)) return res.status(404).json({ error: '没有找到这颗扭蛋' })

  const source = toSource(req.body?.source)
  const sourceRefMessageId = toInt(req.body?.sourceRefMessageId)
  const coupleVisible = toFlag(req.body?.coupleVisible)
  const now = new Date().toISOString()

  const info = INSERT.run(recordId, req.user.id, tagType, content, source, sourceRefMessageId, coupleVisible, now)
  res.status(201).json({ tag: view(SELECT_ONE.get(info.lastInsertRowid, req.user.id)) })
})

router.delete('/:id', (req, res) => {
  const id = toInt(req.params.id)
  if (!id) return res.status(400).json({ error: '无效的标签编号' })
  const info = REMOVE.run(id, req.user.id)
  if (info.changes === 0) return res.status(404).json({ error: '没有找到这条标签' })
  res.json({ ok: true })
})

// 切换 couple_visible
router.post('/:id/toggle-visibility', (req, res) => {
  const id = toInt(req.params.id)
  if (!id) return res.status(400).json({ error: '无效的标签编号' })
  const row = SELECT_ONE.get(id, req.user.id)
  if (!row) return res.status(404).json({ error: '没有找到这条标签' })
  const next = row.couple_visible ? 0 : 1
  UPDATE_VISIBILITY.run(next, id, req.user.id)
  res.json({ tag: view(SELECT_ONE.get(id, req.user.id)) })
})

export default router
