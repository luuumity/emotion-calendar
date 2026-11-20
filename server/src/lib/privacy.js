// 双人场景隐私裁剪
// 只有 cropForCouple() 一个核心函数：
//   输入：自己的全量数据 + 对方给我的授权 scope（colors/full/none）
//   输出：裁剪后的数据——不给 AI 喂对方看不到的内容
// 注意：这里是"数据喂给 AI 之前裁剪"，和 access.js 里"返回给前端之前裁剪"是两层独立逻辑。

/**
 * 把 facts / record_tags 按 couple_visible 过滤。
 * @param {Array<{...any, couple_visible: 0|1}>} items
 * @returns {Array} 只保留 couple_visible=1 的条目
 */
export function filterCoupleVisible(items) {
  return items.filter((x) => x.couple_visible === 1)
}

/**
 * 把 records 按 scope 裁剪。
 * @param {Array<{id, day, score, note, original_score, adjusted_at}>} records
 * @param {'colors'|'full'|'none'} scope
 * @returns {Array}
 */
export function cropRecordsForCouple(records, scope) {
  if (scope === 'none' || scope === null || scope === undefined) return []
  if (scope === 'colors') {
    return records.map((r) => ({
      id: r.id,
      day: r.day,
      score: r.score,
      hasNote: Boolean(r.note && r.note.trim())
      // note 不给
    }))
  }
  // full：给理由，但未来 is_private 字段存在后要在这里再过滤
  // is_private=1 的理由即使 scope=full 也不给
  return records.map((r) => ({
    id: r.id,
    day: r.day,
    score: r.score,
    note: r.note || '',
    originalScore: r.original_score ?? null,
    adjustedAt: r.adjusted_at ?? null
  }))
}

/**
 * 把 AI 标签按 scope + couple_visible 双重裁剪。
 * colors 档：一个标签都不给（理由相关的洞察都不共享）
 * full 档：只给 couple_visible=1 的
 */
export function cropTagsForCouple(tags, scope) {
  if (scope !== 'full') return []
  return filterCoupleVisible(tags)
}

/**
 * 把单人报告摘要按 scope 裁剪。
 * colors 档：不给（报告摘要里可能涉及具体理由）
 * full 档：给（但只给 summary，不给原文）——当前实现直接给 content 全文，简化处理
 */
export function cropSingleReportForCouple(insights, scope) {
  if (scope !== 'full') return []
  return insights
    .filter((i) => i.scope === 'single')
    .map((i) => ({
      id: i.id,
      periodStart: i.period_start,
      periodEnd: i.period_end,
      summary: i.content.slice(0, 500) // 只给前 500 字，省 token
    }))
}

/**
 * 核心裁剪函数：把"我的数据池"按对方给我的授权裁剪成"可以喂给双人 AI 的版本"。
 * 单人/日常问答场景**不调用这个函数**——persona agent 永远读自己的全部数据。
 *
 * @param {object} myData 全量数据池：{ records, facts, tags, singleInsights }
 * @param {'colors'|'full'|'none'} partnerGrantScope 对方给我的授权档位
 * @returns {object} 裁剪后的数据
 */
export function cropForCouple(myData, partnerGrantScope) {
  const scope = partnerGrantScope || 'none'
  return {
    records: cropRecordsForCouple(myData.records || [], scope),
    facts: filterCoupleVisible(myData.facts || []),
    tags: cropTagsForCouple(myData.tags || [], scope),
    singleInsights: cropSingleReportForCouple(myData.singleInsights || [], scope),
    partnerScope: scope // 方便 prompt 里知道对方给了多少权限
  }
}
