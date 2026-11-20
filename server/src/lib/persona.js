// Persona 序列化 / 反序列化
// Persona 状态三部分：system prompt（固定）+ facts（持久）+ 对话历史摘要（滑动窗口）
// 单人/问答/双人场景都复用同一个序列化函数，只在"给 AI 喂什么数据"上不同。
// 双人场景在调用 serializePersona 之前已经用 privacy.cropForCouple() 把数据裁好了。

const SYSTEM_PROMPT_DEFAULT = `你是一个情感陪伴 AI，帮助用户理解自己的情绪模式、识别关系中的沟通模式，并提供温和、非评判的反馈。
你相信情绪日志是自我觉察的第一步骤，无论分数高低都值得被看见。
语气：温和、耐心、有洞察力，但不替代专业心理咨询。
隐私：用户告诉你的私密内容，只有你和用户知道。不要在对谈中假设或臆测对方（如果涉及双人分析）的私密想法。`

/**
 * 序列化 persona 状态为一份 prompt 块（字符串），供上层 prompt 模板拼接。
 *
 * @param {object} opts
 * @param {string} opts.displayName 用户昵称（用于 prompt 里称呼）
 * @param {string} [opts.systemPrompt] 可选覆盖默认 system prompt
 * @param {Array} [opts.facts] facts 全量（自己的，或双人场景下已裁剪的）
 * @param {Array} [opts.tags] AI 标签（已裁剪的）
 * @param {Array} [opts.recentChats] 最近 N 轮对话（role + content），滑动窗口
 * @param {Array} [opts.singleInsights] 单人历史报告摘要
 * @returns {string}
 */
export function serializePersona(opts) {
  const {
    displayName,
    systemPrompt = SYSTEM_PROMPT_DEFAULT,
    facts = [],
    tags = [],
    recentChats = [],
    singleInsights = []
  } = opts

  const lines = []
  lines.push(`===== ${displayName} 的 Persona =====`)
  lines.push(``)
  lines.push(`【系统人格】`)
  lines.push(systemPrompt)
  lines.push(``)

  if (facts.length) {
    lines.push(`【关于 ${displayName} 的稳定事实（按置信度排序）】`)
    const sorted = [...facts].sort((a, b) => (b.confidence || 3) - (a.confidence || 3))
    for (const f of sorted) {
      const conf = '★'.repeat(f.confidence || 3)
      lines.push(`- [${conf}] ${f.content}`)
    }
    lines.push(``)
  }

  if (tags.length) {
    lines.push(`【附着在具体情绪记录上的 AI 洞察】`)
    for (const t of tags) {
      const typeLabel = { insight: '洞察', suggestion: '建议', pattern: '模式', correction: '修正' }[t.tag_type] || t.tag_type
      const day = t.record_day ? `（${t.record_day}）` : ''
      lines.push(`- ${typeLabel}${day}: ${t.content}`)
    }
    lines.push(``)
  }

  if (singleInsights.length) {
    lines.push(`【${displayName} 过往自我分析摘要】`)
    for (const ins of singleInsights.slice(-3)) {
      lines.push(`- ${ins.periodStart} ~ ${ins.periodEnd}: ${ins.summary || ins.content?.slice(0, 200) || '(无)'} `)
    }
    lines.push(``)
  }

  if (recentChats.length) {
    lines.push(`【${displayName} 最近对话片段】`)
    for (const m of recentChats.slice(-10)) {
      const role = m.role === 'assistant' ? 'AI' : displayName
      lines.push(`${role}: ${m.content.slice(0, 300)}`)
    }
    lines.push(``)
  }

  return lines.join('\n')
}

export function getDefaultSystemPrompt() {
  return SYSTEM_PROMPT_DEFAULT
}
