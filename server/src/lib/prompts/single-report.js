// 单人报告 prompt 模板
// 输入：persona 序列化 + 周期起点/终点 + 周期内记录

export function buildSingleReportMessages({ personaBlock, periodStart, periodEnd, records }) {
  const recordBlock = records.length
    ? records.map((r) => `  - ${r.day}: 分数 ${r.score}${r.note ? `; 理由: ${r.note}` : ''}${r.originalScore !== null && r.originalScore !== undefined ? `（原始分 ${r.originalScore}，${r.adjustedAt ? '于 ' + r.adjustedAt.slice(0, 10) + ' 调整' : ''}）` : ''}`).join('\n')
    : '（本周期没有记录）'

  const system = `${personaBlock}

===== 任务 =====
请基于以下 ${periodStart} ~ ${periodEnd} 的情绪记录，为用户生成一份自我洞察报告。

结构（用中文，标题加粗，200-400 字）：
1. **整体倾向**：平均分数、波动程度、是上升/下降/平稳
2. **可能的模式**：什么情境下分数偏低/偏高（如果有理由，尽量关联）
3. **温和的提示**：你观察到但用户可能没注意到的一件小事
4. **下次可以关注**：给一个具体、可操作的小建议（不要是"继续加油"这种空泛话）

要求：
- 不评判，只描述你观察到的
- 如果记录很少（< 3 天），坦诚说"样本还少，我们下次再多一点数据"
- 如果有记录被事后调整过分值，请在分析中把这个调整当作信号（用户自己觉得当时的感受有偏差）

===== ${periodStart} ~ ${periodEnd} 的情绪记录 =====
${recordBlock}`

  return [{ role: 'system', content: system }]
}
