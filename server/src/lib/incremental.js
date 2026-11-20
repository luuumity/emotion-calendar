// 双人报告增量水位管理
// couple_memory 表：couple_key 主键，一行一对人，存 covered_until + summary + updated_at
// covered_until = 上次增量分析覆盖到的日期（YYYY-MM-DD），下次从 covered_until+1 开始取新记录

import { db } from '../db.js'

const SELECT_MEMORY = db.prepare('SELECT * FROM couple_memory WHERE couple_key = ?')
const UPSERT_MEMORY = db.prepare(
  `INSERT INTO couple_memory (couple_key, summary, covered_until, updated_at)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(couple_key) DO UPDATE SET summary = excluded.summary, covered_until = excluded.covered_until, updated_at = excluded.updated_at`
)

/**
 * 计算 couple_key：按 id 升序拼接，A|B 和 B|A 得到同一个值。
 */
export function makeCoupleKey(idA, idB) {
  const a = Number(idA)
  const b = Number(idB)
  if (Number.isNaN(a) || Number.isNaN(b)) return null
  return a < b ? `${a}|${b}` : `${b}|${a}`
}

/**
 * 验证当前用户在 couple_key 里。
 */
export function isInCouple(coupleKey, userId) {
  if (!coupleKey) return false
  const [id1, id2] = coupleKey.split('|').map(Number)
  return id1 === userId || id2 === userId
}

/**
 * 读取或初始化这对人的增量记忆。
 * 没记录时 covered_until=''(空字符串)，表示"还没跑过，取全部"。
 */
export function getOrInitCoupleMemory(coupleKey) {
  let row = SELECT_MEMORY.get(coupleKey)
  if (!row) {
    row = { couple_key: coupleKey, summary: '', covered_until: '', updated_at: '' }
  }
  return row
}

/**
 * 根据 covered_until 算出"增量起点"。
 * 没跑过 → 返回 null（调用方应该取全部记录）。
 * 跑过 → 返回 covered_until 的下一天（YYYY-MM-DD）。
 */
export function computeIncrementStart(coupleMemory) {
  if (!coupleMemory || !coupleMemory.covered_until) return null
  const base = new Date(coupleMemory.covered_until + 'T00:00:00Z')
  base.setUTCDate(base.getUTCDate() + 1)
  return base.toISOString().slice(0, 10)
}

/**
 * 写回增量记忆：更新 covered_until 和 summary。
 */
export function updateCoupleMemory(coupleKey, coveredUntil, summary) {
  const now = new Date().toISOString()
  UPSERT_MEMORY.run(coupleKey, summary || '', coveredUntil || '', now)
}
