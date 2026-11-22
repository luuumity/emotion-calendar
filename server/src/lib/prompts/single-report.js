// 单人报告 prompt 模板 v2
// 输入：persona 序列化（facts + 历史报告）+ 周期起点/终点 + 周期内记录（含内联标签）
// ID 规则：只有被截断或完全未展示的内容才带 #id，可被 get_record / get_report 回读。

const NOTE_LIMIT = 200
const COLD_NOTE_BUDGET = 20000
const LONG_SPAN_DAYS = 60

const TAG_LABEL = { insight: '洞察', suggestion: '建议', pattern: '模式', correction: '修正' }

function dayDiff(a, b) {
  const ms = new Date(`${b}T00:00:00Z`) - new Date(`${a}T00:00:00Z`)
  return Math.round(ms / 86400000)
}

function oneLine(text) {
  return String(text || '').replace(/\s+/g, ' ').trim()
}

/**
 * 把周期内记录整理成输入块。
 * - 每条记录都保留一行（日期、当天第几颗、分值），一条不删
 * - 理由超过 200 字截断并带 #recordId
 * - 冷启动时理由总预算约 20,000 字，从新到旧分配；超出后更早记录只留日期/分值/#id
 * - 标签贴在理由下、全文展示；记录连理由都未展示时，标签也一并省略
 */
function buildRecordBlock(records, { coldStart }) {
  const rows = records.map((r) => ({
    ...r,
    text: oneLine(r.note)
  }))

  let budget = COLD_NOTE_BUDGET
  const display = new Map()

  for (let i = rows.length - 1; i >= 0; i--) {
    const r = rows[i]
    if (!r.text) {
      display.set(r.id, { reason: '', omitted: false, truncated: false })
      continue
    }
    const shown = r.text.slice(0, NOTE_LIMIT)
    if (coldStart) {
      if (shown.length > budget) {
        display.set(r.id, { reason: '', omitted: true, truncated: false })
      } else {
        budget -= shown.length
        display.set(r.id, { reason: shown, omitted: false, truncated: r.text.length > NOTE_LIMIT })
      }
    } else {
      display.set(r.id, { reason: shown, omitted: false, truncated: r.text.length > NOTE_LIMIT })
    }
  }

  return rows
    .map((r) => {
      const d = display.get(r.id)
      const index = r.indexInDay || r.index_in_day
      const score = r.originalScore !== null && r.originalScore !== undefined
        ? `${r.score} 分（原始分 ${r.originalScore}${r.adjustedAt ? `，于 ${String(r.adjustedAt).slice(0, 10)} 调整` : ''}）`
        : `${r.score} 分`
      let line = `- ${r.day}（当天第 ${index} 颗）：${score}`
      if (d.omitted) return `${line} #${r.id}`
      if (d.reason) {
        line += `\n    理由：${d.reason}${d.truncated ? ` …#${r.id}` : ''}`
      }
      if (r.tag && r.tag.content) {
        const label = TAG_LABEL[r.tag.tagType] || r.tag.tagType
        line += `\n    AI标签（${label}）：${r.tag.content}`
      }
      return line
    })
    .join('\n')
}

function toolRules() {
  return `可回读工具：
- 输入里只有被截断或完全未展示的内容才带 #编号（例如「理由：… #123」「#123」「… #45」）。
- 需要全文时调用 get_record（记录）或 get_report（历史报告），编号就是 # 后面的数字。
- 只在缺失内容可能改变结论时回读；禁止用工具做全量扫描；一轮里并行读取不超过 5 条。
- 不要向用户展示任何编号，也不要在正文里提「记录 123」这类内部标识。`
}

export function buildSingleReportMessages({
  personaBlock,
  periodStart,
  periodEnd,
  records = [],
  coldStart = false,
  isFirst = false
}) {
  const span = dayDiff(periodStart, periodEnd)
  const longSpan = span > LONG_SPAN_DAYS
  const recordBlock = buildRecordBlock(records, { coldStart })

  const firstNote = isFirst ? '\n这是用户的第一份报告；可以在开头用一句话说明这是从哪里开始记录、到哪里为止。\n' : ''

  const outline = longSpan
    ? `结构（用中文，标题加粗，400-600 字）：
1. **长期趋势**：这段时间整体走向，以及最明显的变化
2. **阶段变化**：按时间把这段时间分成 2-3 个阶段，说明各阶段的共同点和差别
3. **当前模式**：用户现在最容易反复出现的模式，尽量关联具体理由
4. **一个具体建议**：给一个现在就能做的小动作，不要空泛`
    : `结构（用中文，标题加粗，200-400 字）：
1. **整体倾向**：平均分数、波动程度、是上升/下降/平稳
2. **可能的模式**：什么情境下分数偏低/偏高（如果有理由，尽量关联）
3. **温和的提示**：你观察到但用户可能没注意到的一件小事
4. **下次可以关注**：给一个具体、可操作的小建议（不要是"继续加油"这种空泛话）`

  const system = `${personaBlock}

===== 任务 =====
请基于用户本周期（${periodStart} ~ ${periodEnd}）的情绪记录，为用户生成一份自我洞察报告。
${firstNote}
${outline}

要求：
- 不评判，只描述你观察到的
- 只依据输入和你实际回读到的内容，不要编造未出现的事实
- 如果记录很少（< 3 天），坦诚说"样本还少，我们下次再多一点数据"
- 如果有记录被事后调整过分值，把这个调整当作信号（用户自己觉得当时的感受有偏差），不要当作测量误差
- 理由中可能包含链接：读到内容就结合内容分析，读不到就只依据用户自己写的理由，不要编造链接内容

${toolRules()}`

  return [
    { role: 'system', content: system },
    {
      role: 'user',
      content: `===== ${periodStart} ~ ${periodEnd} 的情绪记录 =====\n${recordBlock || '（本周期没有记录）'}`
    }
  ]
}
