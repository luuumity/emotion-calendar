// 定时单人报告：服务进程内每小时扫描一次。
// 周报处理「上一个完整周」，月报处理「上一个完整月」。
// 生成成功才推送；失败每小时重试，同一周期每类报告最多 3 次。

import { db } from '../db.js'
import { hasDeepSeekKey } from './llm.js'
import { sendToUser } from '../push.js'
import {
  generateSingleInsightSync,
  getSingleColdStartInfo,
  findExistingSingleInsight
} from './single-insight.js'

const MAX_FAILURES = 3

let running = false

function localParts(now, timeZone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone,
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
      hourCycle: 'h23'
    })
    const parts = Object.fromEntries(fmt.formatToParts(now).map((p) => [p.type, p.value]))
    return {
      date: `${parts.year}-${parts.month}-${parts.day}`,
      time: `${parts.hour}:${parts.minute}`
    }
  } catch {
    return localParts(now, 'Asia/Shanghai')
  }
}

function addDays(day, delta) {
  const d = new Date(`${day}T00:00:00Z`)
  d.setUTCDate(d.getUTCDate() + delta)
  return d.toISOString().slice(0, 10)
}

function weekStart(day) {
  const d = new Date(`${day}T00:00:00Z`)
  const dow = d.getUTCDay() || 7
  d.setUTCDate(d.getUTCDate() - (dow - 1))
  return d.toISOString().slice(0, 10)
}

function lastMonthRange(day) {
  const d = new Date(`${day}T00:00:00Z`)
  const year = d.getUTCFullYear()
  const month = d.getUTCMonth()
  const start = new Date(Date.UTC(year, month - 1, 1))
  const end = new Date(Date.UTC(year, month, 0))
  return { start: start.toISOString().slice(0, 10), end: end.toISOString().slice(0, 10) }
}

/** 本地时间是否已过周一 02:00（周日及之后都算）。 */
function canRunWeeklyNow(local) {
  const monday = weekStart(local.date)
  if (local.date > monday) return true
  return local.time >= '02:00'
}

/** 每月 1 日 03:00 之后运行；错过的日期随时补跑。 */
function canRunMonthlyNow(local) {
  if (local.date.slice(8) !== '01') return true
  return local.time >= '03:00'
}

function localDateOf(iso, timeZone) {
  if (!iso) return ''
  try {
    return localParts(new Date(iso), timeZone).date
  } catch {
    return ''
  }
}

const FAILURE_COLUMNS = {
  weekly: { key: 'auto_insight_fail_week', count: 'auto_insight_fail_count' },
  monthly: { key: 'auto_insight_fail_key_monthly', count: 'auto_insight_fail_count_monthly' }
}

function resetFailures(userId, cadence) {
  const cols = FAILURE_COLUMNS[cadence]
  db.prepare(`UPDATE users SET ${cols.key} = ?, ${cols.count} = 0 WHERE id = ?`).run('', userId)
}

function recordFailure(user, cadence, periodKey) {
  const cols = FAILURE_COLUMNS[cadence]
  const samePeriod = user[cols.key] === periodKey
  const next = (samePeriod ? user[cols.count] : 0) + 1
  db.prepare(`UPDATE users SET ${cols.key} = ?, ${cols.count} = ? WHERE id = ?`).run(periodKey, next, user.id)
  return next
}

function periodCounts(userId, start, end) {
  return db
    .prepare(
      'SELECT COUNT(*) AS balls, COUNT(DISTINCT day) AS days FROM records WHERE user_id = ? AND day BETWEEN ? AND ?'
    )
    .get(userId, start, end)
}

/** 该周期是否已被某份冷启动全量报告完整覆盖。 */
function coldCoversPeriod(userId, start, end) {
  return Boolean(
    db
      .prepare(
        `SELECT 1 FROM insights
         WHERE scope = 'single' AND user_id = ? AND kind = 'cold'
           AND period_start <= ? AND period_end >= ?
         LIMIT 1`
      )
      .get(userId, start, end)
  )
}


async function pushReport(userId, cadence, kind) {
  const isMonthly = cadence === 'monthly'
  const periodName = isMonthly ? '上月' : '上周'
  const payload =
    kind === 'cold'
      ? {
          title: '你的首份情绪报告已生成',
          body: '从第一条记录到今天，点开看看。',
          url: '/insights',
          tag: 'cold-insight'
        }
      : kind === 'updated'
        ? {
            title: `${periodName}完整报告已更新`,
            body: '之前的半程报告已经补全。',
            url: '/insights',
            tag: `${cadence}-insight`
          }
        : {
            title: `${periodName}的情绪报告已生成`,
            body: isMonthly ? '点开看看这一个月里的情绪走线。' : '点开看看这一周的情绪走线。',
            url: '/insights',
            tag: `${cadence}-insight`
          }
  try {
    const result = await sendToUser(userId, payload)
    console.log(`[insights] 推送 user=${userId} cadence=${cadence} kind=${kind} sent=${result.sent} removed=${result.removed}`)
  } catch (err) {
    console.error(`[insights] 推送失败 user=${userId}:`, err.message)
  }
}

const CADENCES = {
  weekly: {
    label: '周报',
    ready: canRunWeeklyNow,
    range: (local) => {
      const currentMonday = weekStart(local.date)
      return { start: addDays(currentMonday, -7), end: addDays(currentMonday, -1) }
    },
    allowed: (counts) => counts.balls >= 3
  },
  monthly: {
    label: '月报',
    ready: canRunMonthlyNow,
    range: (local) => lastMonthRange(local.date),
    allowed: (counts) => counts.days >= 8 && counts.balls >= 10
  }
}

async function generateColdStart(user, now) {
  const cold = getSingleColdStartInfo(user.id)
  if (!cold.needed || !cold.hasRecords) return
  if (cold.recordCount < 3) return

  const failureKey = cold.start || 'cold'
  if (user.auto_insight_fail_week === failureKey && user.auto_insight_fail_count >= MAX_FAILURES) return

  try {
    const result = await generateSingleInsightSync({
      userId: user.id,
      nowIso: now.toISOString(),
      origin: 'auto',
      periodType: 'manual'
    })
    resetFailures(user.id, 'weekly')
    resetFailures(user.id, 'monthly')
    if (result.action === 'created' || result.action === 'updated') {
      await pushReport(user.id, 'weekly', 'cold')
    }
    console.log(
      `[insights] 自动冷启动 user=${user.id} action=${result.action} cold=${result.coldStart}`
    )
  } catch (err) {
    if (err.code === 'GENERATION_IN_PROGRESS') {
      console.log(`[insights] 自动冷启动跳过 user=${user.id}：已有生成任务`)
      return
    }
    const failures = recordFailure(user, 'weekly', failureKey)
    console.error(
      `[insights] 自动冷启动失败 user=${user.id} attempt=${failures}/${MAX_FAILURES}:`,
      err.message
    )
  }
}

async function runCadence(user, now, cadence) {
  const cfg = CADENCES[cadence]
  const timezone = user.timezone || 'Asia/Shanghai'
  const local = localParts(now, timezone)
  if (!cfg.ready(local)) return

  const { start, end } = cfg.range(local)
  if (coldCoversPeriod(user.id, start, end)) {
    console.log(`[insights] 冷启动已覆盖 ${start}..${end}，跳过${cfg.label} user=${user.id}`)
    return
  }
  const cols = FAILURE_COLUMNS[cadence]
  if (user[cols.key] === start && user[cols.count] >= MAX_FAILURES) return

  const counts = periodCounts(user.id, start, end)
  if (!cfg.allowed(counts)) return

  const generate = async (options, kind) => {
    try {
      const result = await generateSingleInsightSync({
        userId: user.id,
        nowIso: now.toISOString(),
        origin: 'auto',
        ...options
      })
      resetFailures(user.id, cadence)
      if (result.action === 'created' || result.action === 'updated') {
        await pushReport(user.id, cadence, kind)
      }
      console.log(
        `[insights] 自动${cfg.label} user=${user.id} period=${start}..${end} action=${result.action} cold=${result.coldStart}`
      )
    } catch (err) {
      if (err.code === 'GENERATION_IN_PROGRESS') {
        console.log(`[insights] 自动${cfg.label}跳过 user=${user.id}：已有生成任务`)
        return
      }
      const failures = recordFailure(user, cadence, start)
      console.error(
        `[insights] 自动${cfg.label}失败 user=${user.id} period=${start}..${end} attempt=${failures}/${MAX_FAILURES}:`,
        err.message
      )
    }
  }

  const periodType = cadence === 'weekly' ? 'week' : 'month'
  const existing = findExistingSingleInsight(user.id, periodType, start, end)
  if (existing) {
    // 周期结束后生成的完整报告直接跳过；周期结束前生成的半程报告原地覆盖
    if (localDateOf(existing.generated_at, timezone) > end) return
    await generate(
      {
        periodType,
        customStart: start,
        customEnd: end,
        force: true
      },
      'updated'
    )
    return
  }

  await generate(
    {
      periodType,
      customStart: start,
      customEnd: end
    },
    'new'
  )
}

async function runForUser(user, now) {
  const cold = getSingleColdStartInfo(user.id)
  if (!cold.hasRecords) return

  // 冷启动只生成一份全量报告，本轮不再生成周报/月报，避免第一次开启就出多份
  if (cold.needed) {
    await generateColdStart(user, now)
    return
  }

  if (user.auto_insight_enabled === 1) {
    await runCadence(user, now, 'weekly')
  }
  if (user.auto_insight_monthly === 1) {
    await runCadence(user, now, 'monthly')
  }
}

/** 单次扫描。导出便于测试与手动触发。 */
export async function tickInsights({ now = new Date() } = {}) {
  if (running) return
  running = true
  try {
    if (!hasDeepSeekKey()) return
    const users = db
      .prepare(
        `SELECT id, timezone,
                auto_insight_enabled, auto_insight_monthly,
                auto_insight_fail_week, auto_insight_fail_count,
                auto_insight_fail_key_monthly, auto_insight_fail_count_monthly
         FROM users
         WHERE auto_insight_enabled = 1 OR auto_insight_monthly = 1`
      )
      .all()
    for (const user of users) {
      try {
        await runForUser(user, now)
      } catch (err) {
        console.error(`[insights] 扫描用户失败 user=${user.id}:`, err.message)
      }
    }
  } finally {
    running = false
  }
}

export function startInsightScheduler() {
  const run = () => {
    tickInsights().catch((err) => console.error('[insights] 定时扫描失败:', err))
  }
  // 启动时先扫一次，补上重启期间错过的完整周期
  run()
  const timer = setInterval(run, 60 * 60 * 1000)
  timer.unref()
  console.log('[insights] 定时单人报告调度已启动（每小时检查）')
}
