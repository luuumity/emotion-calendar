import * as webpush from 'web-push'
import { db } from './db.js'

const PUBLIC_KEY = process.env.VAPID_PUBLIC_KEY || ''
const PRIVATE_KEY = process.env.VAPID_PRIVATE_KEY || ''
const SUBJECT = process.env.VAPID_SUBJECT || 'mailto:admin@emotion.cinnamon.xin'

export const pushConfigured = Boolean(PUBLIC_KEY && PRIVATE_KEY)

if (pushConfigured) {
  webpush.setVapidDetails(SUBJECT, PUBLIC_KEY, PRIVATE_KEY)
} else {
  console.warn('[push] 未配置 VAPID 密钥，提醒功能不可用')
}

export function publicKey() {
  return PUBLIC_KEY
}

/** 给某个用户的所有设备推送，返回成功数与清理掉的失效订阅数。 */
export async function sendToUser(userId, payload) {
  if (!pushConfigured) return { sent: 0, removed: 0 }
  const subs = db.prepare('SELECT * FROM push_subscriptions WHERE user_id = ?').all(userId)
  let sent = 0
  let removed = 0

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        { endpoint: sub.endpoint, keys: { p256dh: sub.p256dh, auth: sub.auth } },
        JSON.stringify(payload)
      )
      db.prepare('UPDATE push_subscriptions SET last_ok_at = ?, fail_count = 0 WHERE id = ?').run(
        new Date().toISOString(),
        sub.id
      )
      sent += 1
    } catch (err) {
      const status = err?.statusCode
      if (status === 404 || status === 410) {
        // 凭证已被系统撤销，删掉这条订阅
        db.prepare('DELETE FROM push_subscriptions WHERE id = ?').run(sub.id)
        removed += 1
      } else {
        db.prepare('UPDATE push_subscriptions SET fail_count = fail_count + 1 WHERE id = ?').run(sub.id)
        console.error(`[push] 发送失败 status=${status}`, err?.body || err?.message)
      }
    }
  }

  return { sent, removed }
}

/** 用用户时区算出「今天」和「当前时分」。时区非法时退回上海。 */
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

async function tick() {
  if (!pushConfigured) return
  const now = new Date()
  const users = db.prepare('SELECT * FROM users WHERE reminder_enabled = 1').all()

  for (const user of users) {
    const local = localParts(now, user.timezone || 'Asia/Shanghai')
    if (local.time !== user.reminder_time) continue
    if (user.last_reminded_on === local.date) continue
    if (db.prepare('SELECT 1 FROM records WHERE user_id = ? AND day = ?').get(user.id, local.date)) continue
    if (!db.prepare('SELECT 1 FROM push_subscriptions WHERE user_id = ?').get(user.id)) continue

    // 先记账再发送，避免同一分钟内重试导致重复提醒
    db.prepare('UPDATE users SET last_reminded_on = ? WHERE id = ?').run(local.date, user.id)
    const result = await sendToUser(user.id, {
      title: '今天还没有投球',
      body: '花三秒，记下今天的颜色吧。',
      url: `/day/${local.date}`,
      tag: 'daily-reminder'
    })
    console.log(`[push] 提醒 user=${user.id} date=${local.date} sent=${result.sent} removed=${result.removed}`)
  }
}

export function startReminderScheduler() {
  if (!pushConfigured) return
  const timer = setInterval(() => {
    tick().catch((err) => console.error('[push] 定时检查失败', err))
  }, 60_000)
  timer.unref()
  console.log('[push] 提醒调度已启动（每分钟检查）')
}
