// 会话压缩：把过长的历史压成滚动摘要
// 策略：未压缩历史的估算 token 超过 HISTORY_TOKEN_LIMIT 时，把最早的一批压进 summary，只保留最近 KEEP_RECENT 条原文
// token 估算用上一次回答的实测 usage 校准（prompt_tokens / prompt_chars），无数据时退回中文字符比 1.5
// 失败降级：压缩调用失败就退回「只截断不摘要」，不影响本轮对话

import { db } from '../db.js'
import { callDeepSeek, hasDeepSeekKey } from './llm.js'

const HISTORY_TOKEN_LIMIT = 1500  // 未压缩历史的估算 token 上限
const MAX_PENDING = 24            // 兜底：超短消息堆积时也能触发
const KEEP_RECENT = 6             // 压缩后保留的最近原文条数
const SUMMARY_LIMIT = 1200
const DEFAULT_TOKENS_PER_CHAR = 1 / 1.5

function charsOf(row) {
  return String(row.content || '').length
}

/** 用上一次回答的实测 usage 估算 tokens/char，异常时退回默认值 */
function calibrateRatio(sessionId) {
  const last = db
    .prepare(
      `SELECT prompt_tokens, prompt_chars FROM chat_messages
       WHERE session_id = ? AND role = 'assistant' AND prompt_tokens > 0 AND prompt_chars > 0
       ORDER BY id DESC LIMIT 1`
    )
    .get(sessionId)
  if (!last) return DEFAULT_TOKENS_PER_CHAR
  const ratio = last.prompt_tokens / last.prompt_chars
  if (!Number.isFinite(ratio)) return DEFAULT_TOKENS_PER_CHAR
  return Math.min(1.2, Math.max(0.3, ratio))
}

function transcriptOf(rows) {
  return rows
    .map((m) => {
      const who = m.role === 'user' ? '用户' : '我'
      const text = String(m.content || '').replace(/\s+/g, ' ').slice(0, 400)
      return `${who}：${text}`
    })
    .join('\n')
}

/**
 * 确保会话历史已压缩到合理长度。
 * 必须在写入本轮 user 消息之前调用，否则本轮会被误压进摘要。
 * @returns {Promise<{summary: string, untilId: number, degraded?: boolean}>}
 */
export async function ensureCompressed(sessionId) {
  const row = db
    .prepare('SELECT summary, summary_until_id FROM chat_sessions WHERE id = ?')
    .get(sessionId)
  if (!row) return { summary: '', untilId: 0 }

  const summary = row.summary || ''
  const untilId = row.summary_until_id || 0

  const pending = db
    .prepare(
      `SELECT id, role, content FROM chat_messages
       WHERE session_id = ? AND id > ? AND role IN ('user', 'assistant')
       ORDER BY id ASC`
    )
    .all(sessionId, untilId)

  const pendingChars = pending.reduce((n, m) => n + charsOf(m), 0)
  const ratio = calibrateRatio(sessionId)
  const pendingTokens = Math.round(pendingChars * ratio)
  if (pendingTokens <= HISTORY_TOKEN_LIMIT && pending.length <= MAX_PENDING) {
    return { summary, untilId }
  }
  // 条数不足以切出旧轮次时先不压，等历史继续增长
  if (pending.length <= KEEP_RECENT) return { summary, untilId }
  // 没有 key 时不让占位文本变成摘要
  if (!hasDeepSeekKey()) return { summary, untilId, degraded: true }

  const cut = pending.slice(0, pending.length - KEEP_RECENT)
  const cutUntil = cut[cut.length - 1].id

  const prompt = `把下面这段对话压缩成摘要，不超过 300 字。
保留：用户提到的具体事件、情绪、关系与困扰、已经讨论过的结论、尚未解决的问题。
不要评价，不要编造，不要加入对话里没有的信息。只输出摘要正文。

${summary ? `【已有摘要】\n${summary}\n\n` : ''}【新增对话】\n${transcriptOf(cut)}`

  try {
    const result = await callDeepSeek(
      [
        { role: 'system', content: '你是一个对话记忆整理器，只做客观压缩，不提供建议。' },
        { role: 'user', content: prompt }
      ],
      { tools: false, temperature: 0.2 }
    )
    const next = String(result.content || '').trim().slice(0, SUMMARY_LIMIT)
    if (!next) throw new Error('摘要为空')

    // 条件更新：并发请求时不会把已推进的水位写回去
    const info = db
      .prepare('UPDATE chat_sessions SET summary = ?, summary_until_id = ? WHERE id = ? AND summary_until_id = ?')
      .run(next, cutUntil, sessionId, untilId)

    if (!info.changes) {
      const fresh = db
        .prepare('SELECT summary, summary_until_id FROM chat_sessions WHERE id = ?')
        .get(sessionId)
      return { summary: fresh?.summary || '', untilId: fresh?.summary_until_id || 0 }
    }

    return { summary: next, untilId: cutUntil }
  } catch (err) {
    console.error('[compress] 压缩失败，降级为截断:', err.message)
    return { summary, untilId, degraded: true }
  }
}
