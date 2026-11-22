// 标签提议的目标球信息按绝对 recordId 现查，避免「当天第几颗」和分值快照过期。
// 记录已删除时保留创建时的快照，并标记 recordMissing。

import { db } from '../db.js'

const recordStmt = db.prepare('SELECT id, day, score FROM records WHERE id = ? AND user_id = ?')
const indexStmt = db.prepare('SELECT COUNT(*) AS c FROM records WHERE user_id = ? AND day = ? AND id <= ?')
const tagStmt = db.prepare('SELECT id, tag_type, content, source FROM record_tags WHERE record_id = ? AND user_id = ?')

export function withLiveTagTarget(row, payload) {
  if (!payload || row.kind !== 'tag') return payload
  const recordId = Number(payload.recordId)
  if (!Number.isInteger(recordId) || recordId <= 0) return payload

  const record = recordStmt.get(recordId, row.user_id)
  if (!record) return { ...payload, recordMissing: true }

  const recordIndex = indexStmt.get(row.user_id, record.day, record.id).c
  const current = tagStmt.get(recordId, row.user_id)
  return {
    ...payload,
    recordDay: record.day,
    recordIndex,
    recordScore: record.score,
    recordMissing: false,
    existingTag: current
      ? { id: current.id, tagType: current.tag_type, content: current.content, source: current.source }
      : null
  }
}
