// Agent 写入提议的确认 / 拒绝
// 模型只创建 chat_proposals；这里才真正写 facts / record_tags。
// 报告提议不在这里调模型：确认后返回参数，由前端调用现有生成接口。

import { Router } from 'express'
import { db } from '../db.js'
import { requireUser } from '../auth.js'

const router = Router()
router.use(requireUser)

const TAG_TYPES = ['insight', 'suggestion', 'pattern', 'correction']
const DAY_RE = /^\d{4}-\d{2}-\d{2}$/

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

function isValidDay(s) {
  if (!DAY_RE.test(s)) return false
  const d = new Date(`${s}T00:00:00Z`)
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s
}

function shanghaiToday() {
  return new Date(Date.now() + 8 * 3600 * 1000).toISOString().slice(0, 10)
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
    finalPayload: row.final_payload ? parsePayload({ payload: row.final_payload }) : null,
    edited: Boolean(row.edited),
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

function acceptFact(row, coupleVisible, override) {
  const payload = parsePayload(row) || {}
  const baseContent = typeof payload.content === 'string' ? payload.content.trim() : ''
  const content =
    override && override.content !== undefined
      ? typeof override.content === 'string'
        ? override.content.trim()
        : ''
      : baseContent
  if (!content || content.length > 500) return { error: '事实内容需为 1-500 字', status: 400 }

  const baseConfidence = Number(payload.confidence)
  const baseConf = Number.isInteger(baseConfidence) && baseConfidence >= 1 && baseConfidence <= 5 ? baseConfidence : 3
  const inputConfidence =
    override && override.confidence !== undefined ? Number(override.confidence) : baseConf
  const conf = Number.isInteger(inputConfidence) && inputConfidence >= 1 && inputConfidence <= 5 ? inputConfidence : baseConf
  const edited = content !== baseContent || conf !== baseConf ? 1 : 0
  const finalPayload = JSON.stringify({ ...payload, content, confidence: conf })
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
      .prepare(
        `UPDATE chat_proposals
         SET status = 'accepted', couple_visible = ?, result_ref_id = ?, final_payload = ?, edited = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(coupleVisible, factRow.id, finalPayload, edited, now, row.id)
    if (!changed.changes) return { error: '这条提议已经处理过了', status: 409 }
    return { fact: factView(factRow) }
  })()
}

function acceptTag(row, coupleVisible, override) {
  const payload = parsePayload(row) || {}
  const recordId = toInt(payload?.recordId)
  const tagType = TAG_TYPES.includes(payload?.tagType) ? payload.tagType : null
  const baseContent = typeof payload.content === 'string' ? payload.content.trim() : ''
  const content =
    override && override.content !== undefined
      ? typeof override.content === 'string'
        ? override.content.trim()
        : ''
      : baseContent
  if (!recordId || !tagType || !content || content.length > 500) {
    return { error: '标签内容需为 1-500 字', status: 400 }
  }

  const record = db.prepare('SELECT id FROM records WHERE id = ? AND user_id = ?').get(recordId, row.user_id)
  if (!record) {
    // 记录已经不在了，这条提议没有意义，直接清掉
    db.prepare('DELETE FROM chat_proposals WHERE id = ?').run(row.id)
    return { error: '这条记录已经不在了，建议已失效', status: 404 }
  }

  const dup = db
    .prepare('SELECT id FROM record_tags WHERE record_id = ? AND tag_type = ? AND content = ?')
    .get(recordId, tagType, content)
  if (dup) return { error: '这条记录已经有相同内容的标签了', status: 409 }

  const edited = content !== baseContent ? 1 : 0
  const finalPayload = JSON.stringify({ ...payload, content })
  const now = nowIso()

  return db.transaction(() => {
    const info = db
      .prepare(
        `INSERT INTO record_tags (record_id, user_id, tag_type, content, source, source_ref_message_id, couple_visible, created_at)
         VALUES (?, ?, ?, ?, 'agent', ?, ?, ?)`
      )
      .run(recordId, row.user_id, tagType, content, row.message_id, coupleVisible, now)
    const changed = db
      .prepare(
        `UPDATE chat_proposals
         SET status = 'accepted', couple_visible = ?, result_ref_id = ?, final_payload = ?, edited = ?, decided_at = ?
         WHERE id = ? AND status = 'pending'`
      )
      .run(coupleVisible, info.lastInsertRowid, finalPayload, edited, now, row.id)
    if (!changed.changes) return { error: '这条提议已经处理过了', status: 409 }
    return { tag: tagView(db.prepare('SELECT * FROM record_tags WHERE id = ?').get(info.lastInsertRowid)) }
  })()
}

function recordView(row) {
  return {
    id: row.id,
    day: row.day,
    score: row.score,
    note: row.note,
    originalScore: row.original_score,
    adjustedAt: row.adjusted_at
  }
}

function toScore(input) {
  // 只接受数字或纯数字字符串；null / '' / 布尔 / 数组不能悄悄变成 0
  let score = null
  if (typeof input === 'number') score = input
  else if (typeof input === 'string' && /^\d+$/.test(input.trim())) score = Number(input.trim())
  return Number.isInteger(score) && score >= 0 && score <= 100 ? score : null
}

function acceptRecord(row, override) {
  const payload = parsePayload(row) || {}
  const day = String(override?.day !== undefined ? override.day : payload.day || '')
  if (!isValidDay(day)) return { error: '日期格式应为 YYYY-MM-DD', status: 400 }
  if (day > shanghaiToday()) return { error: '日期不能晚于今天', status: 400 }

  const score = toScore(override?.score !== undefined ? override.score : payload.score)
  if (score === null) return { error: '分值需为 0-100 的整数', status: 400 }

  const rawNote = override?.note !== undefined ? override.note : payload.note
  if (rawNote !== undefined && rawNote !== null && typeof rawNote !== 'string') {
    return { error: '理由需为文本', status: 400 }
  }
  const note = typeof rawNote === 'string' ? rawNote.trim() : ''
  if (note.length > 2000) return { error: '理由不能超过 2000 字', status: 400 }

  const baseDay = String(payload.day || '')
  const baseScore = Number(payload.score)
  const baseNote = typeof payload.note === 'string' ? payload.note.trim() : ''
  const edited = day !== baseDay || score !== baseScore || note !== baseNote ? 1 : 0
  const finalPayload = JSON.stringify({ ...payload, day, score, note })
  const now = nowIso()

  return db.transaction(() => {
    const current = db.prepare('SELECT status FROM chat_proposals WHERE id = ?').get(row.id)
    if (!current || current.status !== 'pending') {
      return { error: '这条提议已经处理过了', status: 409 }
    }

    const info = db
      .prepare(
        `INSERT INTO records (user_id, day, score, note, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)`
      )
      .run(row.user_id, day, score, note, now, now)
    db.prepare(
      `UPDATE chat_proposals
       SET status = 'accepted', result_ref_id = ?, final_payload = ?, edited = ?, decided_at = ?
       WHERE id = ? AND status = 'pending'`
    ).run(info.lastInsertRowid, finalPayload, edited, now, row.id)
    return { record: recordView(db.prepare('SELECT * FROM records WHERE id = ?').get(info.lastInsertRowid)) }
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
  const override = req.body?.payload && typeof req.body.payload === 'object' ? req.body.payload : null
  let result
  if (row.kind === 'fact') result = acceptFact(row, coupleVisible, override)
  else if (row.kind === 'tag') result = acceptTag(row, coupleVisible, override)
  else if (row.kind === 'record') result = acceptRecord(row, override)
  else if (row.kind === 'report') result = acceptReport(row)
  else result = { error: '暂不支持这类提议', status: 400 }

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
