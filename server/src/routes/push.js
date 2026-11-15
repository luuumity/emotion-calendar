import { Router } from 'express'
import { db } from '../db.js'
import { requireUser } from '../auth.js'
import { pushConfigured, publicKey, sendToUser } from '../push.js'

const router = Router()

router.get('/key', (_req, res) => {
  if (!pushConfigured) return res.status(503).json({ error: '提醒功能尚未配置' })
  res.json({ publicKey: publicKey() })
})

router.get('/status', requireUser, (req, res) => {
  const row = db.prepare('SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?').get(req.user.id)
  res.json({
    configured: pushConfigured,
    subscriptions: row.n,
    reminderEnabled: !!req.user.reminder_enabled,
    reminderTime: req.user.reminder_time || '21:00',
    timezone: req.user.timezone || 'Asia/Shanghai'
  })
})

router.post('/subscribe', requireUser, (req, res) => {
  if (!pushConfigured) return res.status(503).json({ error: '提醒功能尚未配置' })

  const sub = req.body?.subscription
  const endpoint = String(sub?.endpoint || '')
  const p256dh = String(sub?.keys?.p256dh || '')
  const auth = String(sub?.keys?.auth || '')
  if (!endpoint.startsWith('https://') || !p256dh || !auth) {
    return res.status(400).json({ error: '订阅信息不完整' })
  }

  const timezone = typeof req.body?.timezone === 'string' && req.body.timezone ? req.body.timezone : 'Asia/Shanghai'
  db.prepare(
    `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, created_at)
     VALUES (?, ?, ?, ?, ?)
     ON CONFLICT(endpoint) DO UPDATE SET
       user_id = excluded.user_id, p256dh = excluded.p256dh, auth = excluded.auth`
  ).run(req.user.id, endpoint, p256dh, auth, new Date().toISOString())
  db.prepare('UPDATE users SET timezone = ? WHERE id = ?').run(timezone, req.user.id)

  res.json({ ok: true })
})

router.post('/unsubscribe', requireUser, (req, res) => {
  const endpoint = String(req.body?.endpoint || '')
  if (endpoint) {
    db.prepare('DELETE FROM push_subscriptions WHERE endpoint = ? AND user_id = ?').run(endpoint, req.user.id)
  }
  res.json({ ok: true })
})

router.post('/settings', requireUser, (req, res) => {
  const enabled = req.body?.enabled ? 1 : 0
  const time = String(req.body?.time || '21:00')
  if (!/^([01]\d|2[0-3]):[0-5]\d$/.test(time)) {
    return res.status(400).json({ error: '提醒时间格式不对' })
  }
  const timezone =
    typeof req.body?.timezone === 'string' && req.body.timezone ? req.body.timezone : req.user.timezone

  db.prepare('UPDATE users SET reminder_enabled = ?, reminder_time = ?, timezone = ? WHERE id = ?').run(
    enabled,
    time,
    timezone,
    req.user.id
  )

  res.json({ ok: true, enabled: !!enabled, time, timezone })
})

router.post('/test', requireUser, async (req, res) => {
  if (!pushConfigured) return res.status(503).json({ error: '提醒功能尚未配置' })
  const result = await sendToUser(req.user.id, {
    title: '测试提醒',
    body: '看到这条通知，说明提醒能正常送达。',
    url: '/settings',
    tag: 'test'
  })
  if (!result.sent) return res.status(400).json({ error: '这台设备还没有订阅成功' })
  res.json({ ok: true, ...result })
})

export default router
