// 日常问答 prompt 模板
// 输入：persona 序列化结果 + 用户本轮消息 + 可选的引用（报告 ID / 记录 ID）

export function buildChatMessages({ personaBlock, userMessage, refs = [] }) {
  const system = `${personaBlock}

===== 任务 =====
以 ${refs.length ? '引用的报告和记录' : '你关于 ' + (personaBlock.match(/===== (.+) 的 Persona/)?.[1] || '用户') + ' 的已有了解'} 为基础，温和、有洞察力地回应用户。
如果用户的问题涉及双人关系，请明确区分"你观察到的 ${personaBlock.match(/===== (.+) 的 Persona/)?.[1] || '用户'} 的视角"和"你不知道对方的内心想法"——不要臆测对方。
语气：简短、温暖、像朋友一样，一次回答控制在 200 字以内。

${refs.length ? '以下是用户当前对话引用的内容，请优先参考：\n' + refs.map((r) => `- ${r.type === 'insight' ? '报告' : '记录'} ${r.id}: ${r.content?.slice(0, 150) || ''}`).join('\n') : ''}`

  return [
    { role: 'system', content: system },
    { role: 'user', content: userMessage }
  ]
}
