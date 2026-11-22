// 情绪分值 → 七档文字
// 与客户端 client/src/lib/colors.ts 的 scoreLabel 保持一致：
// 0–15 很糟 / 16–32 有点低落 / 33–48 偏凉 / 49–58 一般 / 59–72 还不错 / 73–87 挺开心 / 88–100 很幸福
//
// 约定：
// - 单颗球用 describeScore / describeRecordScore，输出「档位（分值）」
// - 平均分等统计值用 describeApproxScore，靠近档位边界时说「介于…之间」，避免把小数硬贴成某一档
// - 一段区间用 describeRange，同档、相邻档、跨多档分别描述
// - 空值 / 非法值统一返回「未记录」，不参与统计

const BAND_DEFS = [
  { max: 15, label: '很糟' },
  { max: 32, label: '有点低落' },
  { max: 48, label: '偏凉' },
  { max: 58, label: '一般' },
  { max: 72, label: '还不错' },
  { max: 87, label: '挺开心' },
  { max: 100, label: '很幸福' }
]

export const SCORE_BANDS = BAND_DEFS.map((band, index) => ({
  ...band,
  min: index === 0 ? 0 : BAND_DEFS[index - 1].max + 1,
  index
}))

function toScore(value) {
  if (value === null || value === undefined || value === '') return null
  const n = Number(value)
  if (!Number.isFinite(n)) return null
  return Math.min(100, Math.max(0, n))
}

function formatValue(value) {
  return Number.isInteger(value) ? String(value) : String(Math.round(value * 10) / 10)
}

export function scoreLabel(score) {
  const n = toScore(score)
  if (n === null) return '未记录'
  for (const band of SCORE_BANDS) {
    if (n <= band.max) return band.label
  }
  return SCORE_BANDS[SCORE_BANDS.length - 1].label
}

export function bandOf(score) {
  const n = toScore(score)
  if (n === null) return null
  for (const band of SCORE_BANDS) {
    if (n <= band.max) return band
  }
  return SCORE_BANDS[SCORE_BANDS.length - 1]
}

/** 单颗球：挺开心（82） */
export function describeScore(score) {
  const n = toScore(score)
  if (n === null) return '未记录'
  return `${scoreLabel(n)}（${formatValue(n)}）`
}

/** 单颗球，带调整前分值：挺开心（82，原为 66，于 11-20 调整） */
export function describeRecordScore(score, originalScore, adjustedAt) {
  const n = toScore(score)
  if (n === null) return '未记录'
  const original = toScore(originalScore)
  if (original === null) return describeScore(n)
  const adjusted = adjustedAt ? `，于 ${String(adjustedAt).slice(0, 10)} 调整` : ''
  return `${scoreLabel(n)}（${formatValue(n)}，原为 ${formatValue(original)}${adjusted}）`
}

/**
 * 统计值：平均分、日均分这类可能带小数的值。
 * 距档位边界不超过 tolerance 时，不硬贴标签，改用区间描述。
 */
export function describeApproxScore(score, tolerance = 3) {
  const n = toScore(score)
  if (n === null) return '未记录'
  const band = bandOf(n)
  const prev = SCORE_BANDS[band.index - 1]
  const next = SCORE_BANDS[band.index + 1]
  const lowDistance = n - band.min
  const highDistance = band.max - n

  if (lowDistance <= tolerance && highDistance <= tolerance) {
    return `大致在『${band.label}』一带`
  }
  if (highDistance <= tolerance && next) {
    return `介于『${band.label}』和『${next.label}』之间`
  }
  if (lowDistance <= tolerance && prev) {
    return `介于『${prev.label}』和『${band.label}』之间`
  }
  return `大致在『${band.label}』一带`
}

/** 一段区间：同档 / 相邻档 / 跨多档 */
export function describeRange(min, max) {
  let lo = toScore(min)
  let hi = toScore(max)
  if (lo === null || hi === null) return '这段时间没有记录'
  if (lo > hi) [lo, hi] = [hi, lo]

  const from = bandOf(lo)
  const to = bandOf(hi)
  const gap = to.index - from.index
  if (gap === 0) return `基本都在『${from.label}』一带`
  if (gap === 1) return `从『${from.label}』到『${to.label}』`
  return `跨度很大，从『${from.label}』到『${to.label}』`
}

/** 档位分布与整体跨度，供报告输入块使用 */
export function buildScoreSummary(records = []) {
  const list = Array.isArray(records) ? records : []
  const days = new Set()
  const counts = new Array(SCORE_BANDS.length).fill(0)
  let min = null
  let max = null
  let valid = 0

  for (const record of list) {
    const n = toScore(record?.score)
    if (n === null) continue
    valid++
    if (record.day) days.add(record.day)
    if (min === null || n < min) min = n
    if (max === null || n > max) max = n
    const band = bandOf(n)
    counts[band.index]++
  }

  const distribution = SCORE_BANDS.map((band, index) => ({
    label: band.label,
    count: counts[index]
  }))
  const distributionText = distribution
    .filter((item) => item.count > 0)
    .map((item) => `${item.label} ${item.count} 颗`)
    .join('、')

  return {
    balls: list.length,
    validBalls: valid,
    days: days.size,
    min,
    max,
    distribution,
    distributionText: distributionText || '（无有效分值）',
    rangeText: valid ? describeRange(min, max) : '这段时间没有记录'
  }
}

/** 每日档位范围，超过 maxDays 天时返回空串，避免长周期输入过长 */
export function buildDailyBands(records = [], maxDays = 31) {
  const list = Array.isArray(records) ? records : []
  const map = new Map()

  for (const record of list) {
    if (!record?.day) continue
    const n = toScore(record.score)
    if (n === null) continue
    const current = map.get(record.day)
    if (!current) {
      map.set(record.day, { min: n, max: n })
    } else {
      if (n < current.min) current.min = n
      if (n > current.max) current.max = n
    }
  }

  const entries = [...map.entries()].sort((a, b) => a[0].localeCompare(b[0]))
  if (!entries.length || entries.length > maxDays) return ''

  return entries
    .map(([day, range]) => {
      const text = range.min === range.max
        ? scoreLabel(range.min)
        : `${scoreLabel(range.min)}→${scoreLabel(range.max)}`
      return `${day.slice(5)} ${text}`
    })
    .join('；')
}
