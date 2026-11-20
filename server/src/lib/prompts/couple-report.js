// 阶段一双人报告 prompt 模板
// 输入：A 和 B 两个 persona 块（已按对方授权裁剪过）+ 周期内记录（各自的 + 对方可见的）+ 上次增量 summary

export function buildCoupleReportMessages({
  personaA,
  personaB,
  partnerAName,
  partnerBName,
  recordsA,
  recordsB,
  periodStart,
  periodEnd,
  lastSummary = ''
}) {
  const aBlock = recordsA.length
    ? recordsA.map((r) => `  - ${r.day}: 分数 ${r.score}${r.note !== undefined ? `; 理由: ${r.note}` : ''}${r.originalScore !== null && r.originalScore !== undefined ? `（原始分 ${r.originalScore}）` : ''}`).join('\n')
    : '（本周期无记录）'

  const bBlock = recordsB.length
    ? recordsB.map((r) => `  - ${r.day}: 分数 ${r.score}${r.note !== undefined ? `; 理由: ${r.note}` : ''}${r.originalScore !== null && r.originalScore !== undefined ? `（原始分 ${r.originalScore}）` : ''}`).join('\n')
    : '（本周期无记录）'

  const system = `${personaA}

${personaB}

===== 关系上下文 =====
${partnerAName} 和 ${partnerBName} 是一对情侣。你们有互相授权的情绪日志数据。
隐私边界：请明确区分"你知道 ${partnerAName} 视角下发生了什么"和"你不知道 ${partnerBName} 的内心想法"。${partnerBName} 的内心只有 ${partnerBName} 自己知道，所有关于 ${partnerBName} 的推测都必须基于记录里写出来的内容。

${lastSummary ? `===== 上次分析的压缩记忆 =====\n${lastSummary}\n` : ''}
===== ${periodStart} ~ ${periodEnd} ${partnerAName} 的记录 =====
${aBlock}

===== ${periodStart} ~ ${periodEnd} ${partnerBName} 的记录 =====
${bBlock}

===== 任务 =====
为这对情侣生成一份双人情绪报告。结构（中文，200-500 字）：
1. **这段时间的合拍程度**：在同一时间段里分数高低的相关性（比如"都在周三低谷"或"方向常常相反"）
2. **可能的共振或错位**：有没有某件事（从理由里看）让双方同时情绪受影响？
3. **需要注意的信号**：有没有沟通回避、或一方长期单方面低/高分的模式？
4. **温和的提议**：一件具体的、可以一起做的小事（不要空泛）

要求：
- 不指责任何一方，不做"谁对谁错"的判断
- 如果某个数据是 colors 档授权（你看到分数但看不到理由），坦诚说"仅从分数看 ${partnerAName} 在 X 日偏低，不清楚原因"
- 承认局限：你们只能看到双方写下来的，无法知道没写的`

  return [{ role: 'system', content: system }]
}
