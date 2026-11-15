import { useCallback, useEffect, useState } from 'react'
import { api } from '../lib/api'
import { errorMessage, useAuth } from '../context/AuthContext'
import {
  ensureSubscribed,
  isIOS,
  isStandalone,
  permissionState,
  pushSupported,
  removeSubscription
} from '../lib/push'

type Status = {
  configured: boolean
  subscriptions: number
  reminderEnabled: boolean
  reminderTime: string
  timezone: string
}

export function SettingsPage() {
  const { user, refreshUser } = useAuth()
  const [status, setStatus] = useState<Status | null>(null)
  const [time, setTime] = useState(user?.reminderTime || '21:00')
  const [busy, setBusy] = useState(false)
  const [message, setMessage] = useState('')
  const [error, setError] = useState('')

  const timezone = Intl.DateTimeFormat().resolvedOptions().timeZone || 'Asia/Shanghai'
  const supported = pushSupported()
  const needsInstall = isIOS() && !isStandalone()
  const denied = permissionState() === 'denied'

  const load = useCallback(async () => {
    try {
      const res = await api.pushStatus()
      setStatus(res)
      setTime(res.reminderTime)
    } catch (err) {
      setError(errorMessage(err))
    }
  }, [])

  useEffect(() => {
    load()
  }, [load])

  // 已授权且以主屏幕方式打开时，静默续订一次（iOS 会不定期吊销凭证）
  useEffect(() => {
    if (!supported || !isStandalone() || permissionState() !== 'granted') return
    ensureSubscribed()
      .then(() => load())
      .catch(() => undefined)
  }, [supported, load])

  async function enable() {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      if (permissionState() !== 'granted') {
        const result = await Notification.requestPermission()
        if (result !== 'granted') {
          setError('没有拿到通知权限，请到系统设置里允许「情绪日历」发送通知')
          return
        }
      }
      await ensureSubscribed()
      await api.pushSettings(true, time, timezone)
      await Promise.all([load(), refreshUser()])
      setMessage('提醒已开启，到点会在这里的设备上通知你')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function disable() {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await api.pushSettings(false, time, timezone)
      await Promise.all([load(), refreshUser()])
      setMessage('提醒已关闭')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function changeTime(value: string) {
    setTime(value)
    if (!status?.reminderEnabled) return
    try {
      await api.pushSettings(true, value, timezone)
      await Promise.all([load(), refreshUser()])
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  async function test() {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await api.pushTest()
      setMessage('测试通知已发送，稍等一下应该会弹出来')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  async function resetDevice() {
    setBusy(true)
    setError('')
    setMessage('')
    try {
      await removeSubscription()
      await Promise.all([load(), refreshUser()])
      setMessage('已解除这台设备的订阅')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  if (!status) {
    return (
      <div className="page settings-page">
        <div className="card">
          <p className="field-hint">{error || '正在读取提醒设置…'}</p>
        </div>
      </div>
    )
  }

  return (
    <div className="page settings-page">
      <div className="card">
        <div className="card-head">
          <h2>每日提醒</h2>
          <p>到了设定的时间，如果当天还没有投球，就轻轻提醒你一次。</p>
        </div>

        {!status.configured && (
          <p className="settings-note">服务器还没有配置推送密钥，暂时无法开启提醒。</p>
        )}

        {needsInstall && (
          <p className="settings-note">
            在 iPhone 上需要先把这个网页添加到主屏幕：点 Safari 底部「分享」→「添加到主屏幕」，再从主屏幕图标打开本页。
          </p>
        )}

        {denied && (
          <p className="settings-note">
            通知权限被拒绝了。到 设置 → 通知 → 情绪日历 里打开允许通知，再回来开启。
          </p>
        )}

        {!supported && <p className="settings-note">当前浏览器不支持网页推送，换用 Safari 或 Chrome 试试。</p>}

        <div className="settings-row">
          <div>
            <div className="settings-label">开启提醒</div>
            <div className="field-hint">
              {status.reminderEnabled
                ? status.subscriptions > 0
                  ? `已开启 · ${status.subscriptions} 台设备订阅中`
                  : '已开启，但这台设备还没订阅成功'
                : '未开启'}
            </div>
          </div>
          <button
            type="button"
            className={status.reminderEnabled ? 'ghost-btn small danger' : 'ghost-btn small'}
            disabled={busy || !status.configured || needsInstall || denied || !supported}
            onClick={status.reminderEnabled ? disable : enable}
          >
            {status.reminderEnabled ? '关闭' : '开启'}
          </button>
        </div>

        <div className="settings-row">
          <div>
            <div className="settings-label">提醒时间</div>
            <div className="field-hint">按你所在时区（{timezone}）判断今天是否已经投球</div>
          </div>
          <input
            type="time"
            className="settings-time"
            value={time}
            disabled={busy}
            onChange={(event) => changeTime(event.target.value)}
          />
        </div>

        <div className="settings-actions">
          <button type="button" className="ghost-btn small" disabled={busy || !status.reminderEnabled} onClick={test}>
            发送测试通知
          </button>
          <button type="button" className="ghost-btn small" disabled={busy || status.subscriptions === 0} onClick={resetDevice}>
            解除这台设备
          </button>
        </div>

        {message && <p className="settings-ok">{message}</p>}
        {error && <p className="form-error">{error}</p>}
      </div>
    </div>
  )
}
