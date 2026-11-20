// 日常问答 prompt 模板（P0）
// 结构：稳定人格/规则 → facts → 记忆块 → 真实历史 → 本轮消息
// 只有最后一条每轮必变，其余按变化频率从低到高排列，便于命中前缀缓存。

export function buildChatMessages({
  personaPrompt,
  displayName,
  factsBlock = '',
  memoryBlock = '',
  history = [],
  userMessage,
  refs = []
}) {
  const messages = []

  messages.push({
    role: 'system',
    content: `${personaPrompt}

===== 对话规则 =====
你在和 ${displayName} 对话。
语气：简短、温暖、像朋友一样，一次回答控制在 200 字以内。
只依据上下文和你读到的内容回答，不要编造未出现的事实；不知道就说不知道。
涉及双方关系时，明确区分"你观察到的"和"对方的内心想法"，不要臆测。
你可以读取用户消息中的链接来判断其内容；读不到时如实说明。
不要做心理诊断，也不替用户给关系下结论。`
  })

  if (factsBlock) messages.push({ role: 'system', content: factsBlock })
  if (memoryBlock) messages.push({ role: 'system', content: memoryBlock })

  for (const m of history) {
    messages.push({ role: m.role, content: m.content })
  }

  const extra = []
  if (refs.length) {
    extra.push(
      '用户引用了以下内容：\n' +
        refs.map((r) => `- ${r.type === 'insight' ? '报告' : '记录'} ${r.id}: ${r.content?.slice(0, 150) || ''}`).join('\n')
    )
  }
  messages.push({ role: 'user', content: extra.length ? `${extra.join('\n\n')}\n\n${userMessage}` : userMessage })

  return messages
}
