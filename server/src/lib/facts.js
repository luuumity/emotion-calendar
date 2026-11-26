// 长期记忆（facts）的容量计算与注入。
// 产品约定：上限内全量注入，不再提供 get_facts 检索；满了只阻止新增，不自动删除。

import { db } from '../db.js'

export const FACT_MAX_COUNT = 100
export const FACT_MAX_TOTAL_CHARS = 8000
export const FACT_MAX_CONTENT_CHARS = 500
// 老数据超过产品上限时的展示安全阈值：先保证能看到，再提示用户整理。
export const FACT_INJECT_SAFETY_CHARS = 12000

export function factUsage(userId) {
  const rows = db.prepare('SELECT content FROM facts WHERE user_id = ?').all(userId)
  let charCount = 0
  for (const row of rows) charCount += String(row.content || '').length
  return {
    count: rows.length,
    charCount,
    countLimit: FACT_MAX_COUNT,
    charLimit: FACT_MAX_TOTAL_CHARS
  }
}

function countFullHint() {
  return `长期记忆已满（最多 ${FACT_MAX_COUNT} 条），请先在「设置 → 长期记忆」合并或删除一些。`
}

function charsFullHint(extra = '') {
  return `长期记忆字数已满（最多 ${FACT_MAX_TOTAL_CHARS} 字${extra}），请先精简或删除一些。`
}

export function checkFactAdd(userId, content) {
  const usage = factUsage(userId)
  if (usage.count >= FACT_MAX_COUNT) {
    return { ok: false, reason: 'facts_full', hint: countFullHint(), usage }
  }
  if (usage.charCount + String(content || '').length > FACT_MAX_TOTAL_CHARS) {
    return { ok: false, reason: 'facts_full', hint: charsFullHint(`，当前 ${usage.charCount} 字`), usage }
  }
  return { ok: true, usage }
}

// 允许在已经超限的老数据上做“变短”的修改，只阻止继续变长。
export function checkFactUpdate(userId, oldContent, nextContent) {
  const usage = factUsage(userId)
  const nextChars = usage.charCount - String(oldContent || '').length + String(nextContent || '').length
  if (nextChars > FACT_MAX_TOTAL_CHARS && nextChars > usage.charCount) {
    return { ok: false, reason: 'facts_full', hint: charsFullHint(`，当前 ${usage.charCount} 字`), usage }
  }
  return { ok: true, usage }
}

export function buildFactsBlock(userId) {
  const rows = db
    .prepare('SELECT content FROM facts WHERE user_id = ? ORDER BY pinned DESC, updated_at DESC, id DESC')
    .all(userId)
  if (!rows.length) return ''

  const lines = []
  let used = 0
  let omitted = 0
  for (const row of rows) {
    const content = String(row.content || '')
    if (used + content.length > FACT_INJECT_SAFETY_CHARS) {
      omitted += 1
      continue
    }
    used += content.length
    lines.push(`- ${content}`)
  }

  lines.unshift(`【关于用户的稳定事实】（共 ${rows.length} 条）`)
  if (omitted) {
    lines.push(`（另有 ${omitted} 条因超出展示安全上限未列出，请提醒用户在「设置 → 长期记忆」整理。）`)
  }
  return lines.join('\n')
}
