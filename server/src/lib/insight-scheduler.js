// 定时单人周报：服务进程内每小时扫描一次。
// 只处理开启了自动报告的用户的「上一个完整周」；不回头补更早周期。
// 生成成功才推送；失败每小时重试，同一周最多 3 次。

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

/** 本地时间是否已过周一 03:00（周日及之后都算）。 */
function canRunNow(local) {
  const monday = weekStart(local.date)
  if (local.date > monday) return true
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

function resetFailures(userId) {
  db.prepare(
    'UPDATE users SET auto_insight_fail_week = ?, auto_insight_fail_count = 0 WHERE id = ?'
  ).run('', userId)
}

function recordFailure(user, weekKey) {
  const sameWeek = user.auto_insight_fail_week === weekKey
  const next = (sameWeek ? user.auto_insight_fail_count : 0) + 1
  db.prepare('UPDATE users SET auto_insight_fail_week = ?, auto_insight_fail_count = ? WHERE id = ?').run(
    weekKey,
    next,
    user.id
  )
  return next
}

async function pushReport(userId, kind) {
  const payload =
    kind === 'cold'
      ? {
          title: '你的首份情绪报告已生成',
          body: '从第一条记录到今天，点开看看。',
          url: '/insights',
          tag: 'weekly-insight'
        }
      : kind === 'updated'
        ? {
            title: '上周完整报告已更新',
            body: '之前的半周报告已经补全。',
            url: '/insights',
            tag: 'weekly-insight'
          }
        : {
            title: '上周的情绪报告已生成',
            body: '点开看看这一周的情绪走线。',
            url: '/insights',
            tag: 'weekly-insight'
          }
  try {
    const result = await sendToUser(userId, payload)
    console.log(`[insights] 推送 user=${userId} kind=${kind} sent=${result.sent} removed=${result.removed}`)
  } catch (err) {
    console.error(`[insights] 推送失败 user=${userId}:`, err.message)
  }
}

async function runForUser(user, now) {
  const timezone = user.timezone || 'Asia/Shanghai'
  const local = localParts(now, timezone)
  if (!canRunNow(local)) return

  const currentMonday = weekStart(local.date)
  const periodStart = addDays(currentMonday, -7)
  const periodEnd = addDays(currentMonday, -1)

  if (user.auto_insight_fail_week === periodStart && user.auto_insight_fail_count >= MAX_FAILURES) return

  const cold = getSingleColdStartInfo(user.id)
  if (!cold.hasRecords) return

  const generate = async (options, kind) => {
    try {
      const result = await generateSingleInsightSync({ userId: user.id, nowIso: now.toISOString(), ...options })
      resetFailures(user.id)
      if (result.action === 'created' || result.action === 'updated') {
        await pushReport(user.id, kind)
      }
      console.log(
        `[insights] 自动报告 user=${user.id} week=${periodStart}..${periodEnd} action=${result.action} cold=${result.coldStart}`
      )
    } catch (err) {
      const failures = recordFailure(user, periodStart)
      console.error(
        `[insights] 自动报告失败 user=${user.id} week=${periodStart} attempt=${failures}/${MAX_FAILURES}:`,
        err.message
      )
    }
  }

  // 冷启动：还没有任何单人报告，生成「第一条记录 → 今天」的全量报告
  if (cold.needed) {
    if (cold.recordCount < 3) return
    await generate({ periodType: 'manual' }, 'cold')
    return
  }

  const weekCount = db
    .prepare('SELECT COUNT(*) AS c FROM records WHERE user_id = ? AND day BETWEEN ? AND ?')
    .get(user.id, periodStart, periodEnd).c
  if (weekCount < 3) return

  const existing = findExistingSingleInsight(user.id, 'week', periodStart, periodEnd)
  if (existing) {
    // 周期结束后生成的完整报告直接跳过；周期结束前生成的半周报告原地覆盖
    if (localDateOf(existing.generated_at, timezone) > periodEnd) return
    await generate(
      { periodType: 'week', customStart: periodStart, customEnd: periodEnd, force: true },
      'updated'
    )
    return
  }

  await generate({ periodType: 'week', customStart: periodStart, customEnd: periodEnd }, 'new')
}

/** 单次扫描。导出便于测试与手动触发。 */
export async function tickInsights({ now = new Date() } = {}) {
  if (running) return
  running = true
  try {
    if (!hasDeepSeekKey()) return
    const users = db
      .prepare(
        `SELECT id, timezone, auto_insight_fail_week, auto_insight_fail_count
         FROM users WHERE auto_insight_enabled = 1`
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
  // 启动时先扫一次，补上重启期间错过的最近一个完整周
  run()
  const timer = setInterval(run, 60 * 60 * 1000)
  timer.unref()
  console.log('[insights] 定时单人周报调度已启动（每小时检查）')
}
