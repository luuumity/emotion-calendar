// 日常问答 prompt 模板（P0）
// 结构：稳定人格/规则 → facts → 记忆块 → 压缩摘要 → 真实历史 → 本轮消息
// 只有最后一条每轮必变，其余按变化频率从低到高排列，便于命中前缀缓存。

export function buildChatMessages({
  personaPrompt,
  displayName,
  factsBlock = '',
  memoryBlock = '',
  summaryBlock = '',
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
需要某几天的具体记录、分值或标签时，调用 get_days / get_tags 查询，不要凭印象推测。
理由被截断时用 get_record 取全文；需要回顾过往分析时用 get_report。
如果用户明确说出长期不变的偏好、习惯、关系或重要事件，可以用 propose_fact 提议记入记忆。
给某一天的记录补充洞察、建议、模式或纠正时用 propose_tag，recordId 必须来自 get_days / get_record，不要编造。
用户想回顾某段时间时，可以用 propose_report 提议生成单人报告（periodType 为 week 或 month，也可给 start/end）。
这些工具只会生成"待用户确认的建议"，不会立即写入：不要说已经记住、已经保存或已经生成。
每轮最多提 1-2 条建议；没有新的长期信息或用户没要求时不要提议；用户忽略过的建议不要反复提。
涉及双方关系时，明确区分"你观察到的"和"对方的内心想法"，不要臆测。
你可以读取用户消息中的链接来判断其内容；读不到时如实说明。
不要做心理诊断，也不替用户给关系下结论。`
  })

  if (factsBlock) messages.push({ role: 'system', content: factsBlock })
  if (memoryBlock) messages.push({ role: 'system', content: memoryBlock })
  if (summaryBlock) messages.push({ role: 'system', content: summaryBlock })

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
