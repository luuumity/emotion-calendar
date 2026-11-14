import type { RecordItem } from './api'

export type CompatResult = {
  commonDays: number
  alignment: number | null
  avgDiff: number | null
  descriptor: string
  hint: string
  trend: 'up' | 'down' | 'flat' | null
  series: Array<{ day: string; mine: number; theirs: number; diff: number }>
}

export type DayAverage = { day: string; score: number; count: number }

/** 一天可以有多颗扭蛋，按月/按天展示时统一取当天所有扭蛋的平均分。 */
export function dailyAverages(records: RecordItem[]): DayAverage[] {
  const acc = new Map<string, { sum: number; count: number }>()
  for (const record of records) {
    const bucket = acc.get(record.day)
    if (bucket) {
      bucket.sum += record.score
      bucket.count += 1
    } else {
      acc.set(record.day, { sum: record.score, count: 1 })
    }
  }
  return Array.from(acc.entries())
    .map(([day, bucket]) => ({ day, score: bucket.sum / bucket.count, count: bucket.count }))
    .sort((a, b) => a.day.localeCompare(b.day))
}

export function computeCompat(mine: RecordItem[], theirs: RecordItem[]): CompatResult {
  const mineMap = new Map(dailyAverages(mine).map((r) => [r.day, r.score]))
  const series = dailyAverages(theirs)
    .filter((r) => mineMap.has(r.day))
    .map((r) => ({
      day: r.day,
      theirs: r.score,
      mine: mineMap.get(r.day) as number,
      diff: Math.abs((mineMap.get(r.day) as number) - r.score)
    }))
    .sort((a, b) => a.day.localeCompare(b.day))

  const commonDays = series.length
  if (commonDays === 0) {
    return {
      commonDays: 0,
      alignment: null,
      avgDiff: null,
      descriptor: '还没有共同记录',
      hint: '两个人都记录同一天后，才能算出同感指数。',
      trend: null,
      series
    }
  }

  const avgDiff = series.reduce((sum, s) => sum + s.diff, 0) / commonDays
  const alignment = Math.round(100 - avgDiff)

  let descriptor = '需要聊聊'
  if (alignment >= 85) descriptor = '同感默契'
  else if (alignment >= 70) descriptor = '渐入佳境'
  else if (alignment >= 55) descriptor = '慢慢靠近'
  else if (alignment >= 40) descriptor = '温差有点大'

  let trend: CompatResult['trend'] = null
  if (series.length >= 6) {
    const recent = series.slice(-5)
    const previous = series.slice(-10, -5)
    if (previous.length >= 3) {
      const recentAvg = recent.reduce((s, x) => s + x.diff, 0) / recent.length
      const previousAvg = previous.reduce((s, x) => s + x.diff, 0) / previous.length
      const delta = previousAvg - recentAvg
      trend = delta > 3 ? 'up' : delta < -3 ? 'down' : 'flat'
    }
  }

  const hint =
    commonDays < 3
      ? `目前只有 ${commonDays} 天共同记录，样本还太少。`
      : `共同记录 ${commonDays} 天，平均温差 ${avgDiff.toFixed(1)} 分。`

  return { commonDays, alignment, avgDiff, descriptor, hint, trend, series }
}

export function averageScore(records: RecordItem[]): number | null {
  if (!records.length) return null
  return Math.round(records.reduce((sum, r) => sum + r.score, 0) / records.length)
}
