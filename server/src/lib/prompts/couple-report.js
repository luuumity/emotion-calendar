// 阶段一双人报告 prompt 模板 v2
// 输入：A 和 B 两个 persona 块（已按对方授权裁剪过）+ 周期内记录（各自的 + 对方可见的）+ 上次增量 summary
// 语言约定与单人报告一致：情绪强弱优先用七档感受词，分数只作为括号内的辅助信息。

import { describeRecordScore, buildScoreSummary } from '../score-labels.js'

function recordLine(record) {
  return `  - ${record.day}: ${describeRecordScore(record.score, record.originalScore)}${record.note !== undefined ? `; 理由: ${record.note}` : ''}`
}

function summaryLine(name, records) {
  const summary = buildScoreSummary(records)
  if (!summary.balls) return `${name}：本周期没有记录`
  return `${name}：覆盖 ${summary.days} 天，共 ${summary.balls} 颗球；档位分布：${summary.distributionText}；整体跨度：${summary.rangeText}`
}

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
  const aBlock = recordsA.length ? recordsA.map(recordLine).join('\n') : '（本周期无记录）'

  const bBlock = recordsB.length ? recordsB.map(recordLine).join('\n') : '（本周期无记录）'

  const system = `${personaA}

${personaB}

===== 关系上下文 =====
${partnerAName} 和 ${partnerBName} 是一对情侣。你们有互相授权的情绪日志数据。
隐私边界：请明确区分"你知道 ${partnerAName} 视角下发生了什么"和"你不知道 ${partnerBName} 的内心想法"。${partnerBName} 的内心只有 ${partnerBName} 自己知道，所有关于 ${partnerBName} 的推测都必须基于记录里写出来的内容。

${lastSummary ? `===== 上次分析的压缩记忆 =====\n${lastSummary}\n` : ''}
===== 任务 =====
为这对情侣生成一份双人情绪报告。结构（中文，200-500 字）：
1. **这段时间的合拍程度**：同一时段两人的情绪档位是否同向（都偏低、都挺开心），还是一高一低；不要用分数做相关性描述
2. **可能的共振或错位**：有没有某件事（从理由里看）让双方同时情绪受影响？
3. **需要注意的信号**：有没有沟通回避、或一方长期单方面偏低/偏高的模式？
4. **温和的提议**：一件具体的、可以一起做的小事（不要空泛）

要求：
- 不指责任何一方，不做"谁对谁错"的判断
- 情绪强弱优先用七档感受词：很糟、有点低落、偏凉、一般、还不错、挺开心、很幸福
- 分数不是完全不能用，但只作为辅助：只在引用原话、或确需精确对照时出现；不要连续罗列数字、区间或百分比
- 不写平均分、最高分、最低分，改用"多数时候""偶尔""从…到…"这类表达
- 如果某个数据是 colors 档授权（你只能看到档位/颜色，看不到理由），坦诚说"仅从感受档看 ${partnerAName} 在 X 日偏凉，不清楚原因"
- 承认局限：你们只能看到双方写下来的，无法知道没写的
- 理由中可能包含链接：读到内容就结合内容分析，读不到就只依据记录里写下的理由，不要编造链接内容`

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `===== 本周期概览 =====
${summaryLine(partnerAName, recordsA)}
${summaryLine(partnerBName, recordsB)}

===== ${periodStart} ~ ${periodEnd} ${partnerAName} 的记录 =====\n${aBlock}\n\n===== ${periodStart} ~ ${periodEnd} ${partnerBName} 的记录 =====\n${bBlock}`
    }
  ]
}

/**
 * 生成 couple_memory 的压缩记忆：旧记忆 + 本期增量记录 → 新记忆。
 * 和报告分开调用，避免直接把报告开头当记忆。
 */
export function buildCoupleMemoryMessages({
  lastSummary = '',
  periodStart,
  periodEnd,
  partnerAName,
  partnerBName,
  recordsA = [],
  recordsB = []
}) {
  const line = (r) => `  - ${r.day}: ${describeRecordScore(r.score, r.originalScore)}${r.note ? `; 理由: ${r.note}` : ''}`
  const aBlock = recordsA.length ? recordsA.map(line).join('\n') : '（无记录）'
  const bBlock = recordsB.length ? recordsB.map(line).join('\n') : '（无记录）'

  return [
    {
      role: 'system',
      content: '你是情侣情绪日志的记忆整理器。只做客观压缩，不评价、不建议、不编造。只输出记忆正文。'
    },
    {
      role: 'user',
      content: `把下面这段情侣记忆整理成不超过 300 字的摘要。
保留：具体事件、情绪转折、关系变化、已经确认过的结论、尚未解决的事。
情绪强弱优先用档位词（很糟、有点低落、偏凉、一般、还不错、挺开心、很幸福）描述，分数只在确需精确对照时保留。
不要写分数统计表，不要写建议。

${lastSummary ? `【已有记忆】\n${lastSummary}\n\n` : ''}【本期记录 ${periodStart} ~ ${periodEnd}】
${partnerAName}：
${aBlock}

${partnerBName}：
${bBlock}`
    }
  ]
}
