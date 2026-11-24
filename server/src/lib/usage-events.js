// 用量流水：每次生成完成写一条，独立于会话/报告，删除内容不影响历史用量。
// 只记 token，不记金额。写入失败不阻断主流程。

import { db } from '../db.js'

/**
 * @param {object} input
 * @param {number} input.userId
 * @param {'chat'|'single'|'couple'} input.kind
 * @param {number|null} [input.sourceId] 消息 / 报告的 id，仅用于排查
 * @param {string|null} [input.dedupeKey] 幂等键；报告重新生成时传 null，按次追加
 * @param {string} [input.model]
 * @param {object} [input.usage] DeepSeek 累计 usage
 * @param {string} [input.createdAt]
 */
export function recordUsageEvent({
  userId,
  kind,
  sourceId = null,
  dedupeKey = null,
  model = '',
  usage = {},
  createdAt = new Date().toISOString()
}) {
  const input = usage.prompt_tokens || 0
  const output = usage.completion_tokens || 0
  if (!input && !output) return

  try {
    db.prepare(
      `INSERT OR IGNORE INTO usage_events
        (user_id, kind, source_id, dedupe_key, model, input_tokens, output_tokens, hit_tokens, miss_tokens, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`
    ).run(
      userId,
      kind,
      sourceId,
      dedupeKey,
      model || '',
      input,
      output,
      usage.prompt_cache_hit_tokens || 0,
      usage.prompt_cache_miss_tokens || 0,
      createdAt
    )
  } catch (err) {
    console.error('[usage] 记账失败:', err.message)
  }
}
