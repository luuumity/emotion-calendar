// Agent 写入提议的确认 / 拒绝
// 模型只创建 chat_proposals；这里才真正写 facts / record_tags。
// 报告提议不在这里调模型：确认后返回参数，由前端调用现有生成接口。

import { Router } from 'express'
import { db } from '../db.js'
import { requireUser } from '../auth.js'

const router = Router()
router.use(requireUser)

const TAG_TYPES = ['insight', 'suggestion', 'pattern', 'correction']

function toInt(input) {
  const n = Number(input)
  return Number.isInteger(n) ? n : null
}

function toFlag(input) {
  return input ? 1 : 0
}

function nowIso() {
  return new Date().toISOString()
}

function parsePayload(row) {
  try {
    return row.payload ? JSON.parse(row.payload) : null
  } catch {
    return null
  }
}

function view(row) {
  return {
    id: row.id,
    kind: row.kind,
    status: row.status,
    payload: parsePayload(row),
    coupleVisible: Boolean(row.couple_visible),
    resultRefId: row.result_ref_id,
    createdAt: row.created_at,
    decidedAt: row.decided_at
  }
}

function factView(row) {
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

function tagView(row) {
  return {
    id: row.id,
    recordId: row.record_id,
    tagType: row.tag_type,
    content: row.content,
    source: row.source,
    sourceRefMessageId: row.source_ref_message_id,
    coupleVisible: Boolean(row.couple_visible),
    createdAt: row.created_at
  }
}

function acceptFact(row, coupleVisible) {
  const payload = parsePayload(row)
  const content = typeof payload?.content === 'string' ? payload.content.trim() : ''
  if (!content || content.length > 500) return { error: '事实内容已失效', status: 400 }

  const confidence = Number(payload.confidence)
  const conf = Number.isInteger(confidence) && confidence >= 1 && confidence <= 5 ? confidence : 3
  const now = nowIso()

  return db.transaction(() => {
    const dup = db.prepare('SELECT * FROM facts WHERE user_id = ? AND content = ?').get(row.user_id, content)
    let factRow = dup
    if (!dup) {
      const info = db
        .prepare(
          `INSERT INTO facts (user_id, content, confidence, source, source_ref_id, couple_visible, pinned, created_at, updated_at)
           VALUES (?, ?, ?, 'agent_extracted', ?, ?, 0, ?, ?)`
        )
        .run(row.user_id, content, conf, row.message_id, coupleVisible, now, now)
      factRow = db.prepare('SELECT * FROM facts WHERE id = ?').get(info.lastInsertRowid)
    }
    const changed = db
      .prepare(`UPDATE chat_proposals SET status = 'accepted', couple_visible = ?, result_ref_id = ?, decided_at = ? WHERE id = ? AND status = 'pending'`)
      .run(coupleVisible, factRow.id, now, row.id)
    if (!changed.changes) return { error: '这条提议已经处理过了', status: 409 }
    return { fact: factView(factRow) }
  })()
}

function acceptTag(row, coupleVisible) {
  const payload = parsePayload(row)
  const recordId = toInt(payload?.recordId)
  const tagType = TAG_TYPES.includes(payload?.tagType) ? payload.tagType : null
  const content = typeof payload?.content === 'string' ? payload.content.trim() : ''
  if (!recordId || !tagType || !content || content.length > 500) {
    return { error: '标签内容已失效', status: 400 }
  }

  const record = db.prepare('SELECT id FROM records WHERE id = ? AND user_id = ?').get(recordId, row.user_id)
  if (!record) {
    // 记录已经不在了，这条提议没有意义，直接清掉
    db.prepare('DELETE FROM chat_proposals WHERE id = ?').run(row.id)
    return { error: '这条记录已经不在了，建议已失效', status: 404 }
  }

  const now = nowIso()
  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO record_tags (record_id, user_id, tag_type, content, source, source_ref_message_id, couple_visible, created_at)
         VALUES (?, ?, ?, ?, 'agent', ?, ?, ?)`
      )
      .run(recordId, row.user_id, tagType, content, row.message_id, coupleVisible, now)
    const changed = db
      .prepare(`UPDATE chat_proposals SET status = 'accepted', couple_visible = ?, result_ref_id = ?, decided_at = ? WHERE id = ? AND status = 'pending'`)
      .run(coupleVisible, info.lastInsertRowid, now, row.id)
    if (!changed.changes) return { error: '这条提议已经处理过了', status: 409 }
    return { tag: tagView(db.prepare('SELECT * FROM record_tags WHERE id = ?').get(info.lastInsertRowid)) }
  })()
}

function acceptReport(row) {
  const payload = parsePayload(row)
  const periodType = payload?.periodType === 'week' ? 'week' : payload?.periodType === 'month' ? 'month' : null
  if (!periodType) return { error: '报告参数已失效', status: 400 }

  const now = nowIso()
  const changed = db
    .prepare(`UPDATE chat_proposals SET status = 'accepted', decided_at = ? WHERE id = ? AND status = 'pending'`)
    .run(now, row.id)
  if (!changed.changes) return { error: '这条提议已经处理过了', status: 409 }

  return {
    action: {
      type: 'generate_insight',
      scope: 'single',
      periodType,
      start: payload.start || null,
      end: payload.end || null
    }
  }
}

router.post('/:id/accept', (req, res) => {
  const id = toInt(req.params.id)
  if (!id) return res.status(400).json({ error: '无效的提议编号' })

  const row = db.prepare('SELECT * FROM chat_proposals WHERE id = ? AND user_id = ?').get(id, req.user.id)
  if (!row) return res.status(404).json({ error: '没有找到这条提议' })
  if (row.status !== 'pending') {
    return res.status(409).json({ error: '这条提议已经处理过了', status: row.status, proposal: view(row) })
  }

  const coupleVisible = toFlag(req.body?.coupleVisible)
  let result
  if (row.kind === 'fact') result = acceptFact(row, coupleVisible)
  else if (row.kind === 'tag') result = acceptTag(row, coupleVisible)
  else result = acceptReport(row)

  if (result.error) return res.status(result.status).json({ error: result.error, proposal: view(row) })

  const updated = db.prepare('SELECT * FROM chat_proposals WHERE id = ?').get(id)
  res.json({ proposal: view(updated), ...result })
})

router.post('/:id/reject', (req, res) => {
  const id = toInt(req.params.id)
  if (!id) return res.status(400).json({ error: '无效的提议编号' })

  const row = db.prepare('SELECT * FROM chat_proposals WHERE id = ? AND user_id = ?').get(id, req.user.id)
  if (!row) return res.status(404).json({ error: '没有找到这条提议' })
  if (row.status !== 'pending') {
    return res.status(409).json({ error: '这条提议已经处理过了', status: row.status, proposal: view(row) })
  }

  db.prepare(`UPDATE chat_proposals SET status = 'rejected', decided_at = ? WHERE id = ? AND status = 'pending'`).run(nowIso(), id)
  const updated = db.prepare('SELECT * FROM chat_proposals WHERE id = ?').get(id)
  res.json({ proposal: view(updated) })
})

export default router
