import { useCallback, useEffect, useState, type FormEvent } from 'react'
import { Link, useSearchParams } from 'react-router-dom'
import { api, type Fact } from '../lib/api'
import { errorMessage, useAuth } from '../context/AuthContext'
import { AccessPanel } from './AccessPage'
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

function ReminderPanel() {
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
      <div className="card">
        <p className="field-hint">{error || '正在读取提醒设置…'}</p>
      </div>
    )
  }

  return (
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
  )
}

function sourceLabel(source: Fact['source']) {
  if (source === 'agent_extracted') return '对话提取'
  if (source === 'report_derived') return '报告提炼'
  return '你添加'
}

function MemoryItem({
  fact,
  onChange,
  onDelete
}: {
  fact: Fact
  onChange: (next: Fact) => void
  onDelete: (id: number) => void
}) {
  const [editing, setEditing] = useState(false)
  const [text, setText] = useState(fact.content)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  async function patch(next: { content?: string; pinned?: boolean; coupleVisible?: boolean }) {
    setBusy(true)
    setError('')
    try {
      const res = await api.updateFact(fact.id, next)
      onChange(res.fact)
      return true
    } catch (err) {
      setError(errorMessage(err))
      return false
    } finally {
      setBusy(false)
    }
  }

  async function save() {
    const content = text.trim()
    if (!content) {
      setError('内容不能为空')
      return
    }
    if (await patch({ content })) setEditing(false)
  }

  async function remove() {
    if (!window.confirm('删除这条长期记忆？')) return
    setBusy(true)
    setError('')
    try {
      await api.deleteFact(fact.id)
      onDelete(fact.id)
    } catch (err) {
      setError(errorMessage(err))
      setBusy(false)
    }
  }

  return (
    <li className={'memory-item' + (fact.pinned ? ' pinned' : '')}>
      <div className="memory-item-head">
        <span className={`memory-source ${fact.source}`}>{sourceLabel(fact.source)}</span>
        {fact.pinned && <span className="memory-pin">置顶</span>}
        <span className="memory-date">{fact.updatedAt.slice(0, 10)}</span>
      </div>

      {editing ? (
        <textarea
          className="memory-edit"
          value={text}
          maxLength={500}
          rows={2}
          autoFocus
          onChange={(e) => setText(e.target.value)}
        />
      ) : (
        <p className="memory-content">{fact.content}</p>
      )}

      <div className="memory-actions">
        {editing ? (
          <>
            <button type="button" className="primary-btn small" onClick={save} disabled={busy}>
              {busy ? '保存中…' : '保存'}
            </button>
            <button
              type="button"
              className="ghost-btn small"
              disabled={busy}
              onClick={() => {
                setEditing(false)
                setText(fact.content)
                setError('')
              }}
            >
              取消
            </button>
          </>
        ) : (
          <>
            <button type="button" className="ghost-btn small" onClick={() => patch({ pinned: !fact.pinned })} disabled={busy}>
              {fact.pinned ? '取消置顶' : '置顶'}
            </button>
            <label className="memory-visible">
              <input
                type="checkbox"
                checked={fact.coupleVisible}
                disabled={busy}
                onChange={() => patch({ coupleVisible: !fact.coupleVisible })}
              />
              对另一半可见
            </label>
            <button type="button" className="ghost-btn small" onClick={() => setEditing(true)} disabled={busy}>
              编辑
            </button>
            <button type="button" className="ghost-btn small danger" onClick={remove} disabled={busy}>
              删除
            </button>
          </>
        )}
      </div>

      {error && <div className="banner error">{error}</div>}
    </li>
  )
}

function MemoryPanel() {
  const [facts, setFacts] = useState<Fact[]>([])
  const [draft, setDraft] = useState('')
  const [loading, setLoading] = useState(true)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')

  useEffect(() => {
    api
      .facts()
      .then((res) => setFacts(res.facts))
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false))
  }, [])

  async function add(e: FormEvent) {
    e.preventDefault()
    const content = draft.trim()
    if (!content) return
    setBusy(true)
    setError('')
    try {
      const res = await api.createFact({ content })
      setFacts((list) => [res.fact, ...list])
      setDraft('')
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setBusy(false)
    }
  }

  function replace(next: Fact) {
    setFacts((list) => list.map((f) => (f.id === next.id ? next : f)))
  }

  const sorted = [...facts].sort((a, b) => Number(b.pinned) - Number(a.pinned) || b.id - a.id)

  return (
    <div>
      <p className="settings-note">
        Agent 在对话中了解到的长期信息会先征求你的确认，确认后才出现在这里。你可以随时修改、置顶、控制是否对另一半可见，或删除。
      </p>

      <form className="memory-add" onSubmit={add}>
        <input
          value={draft}
          maxLength={500}
          placeholder="添加一条，例如：不喜欢香菜"
          onChange={(e) => setDraft(e.target.value)}
        />
        <button type="submit" className="primary-btn" disabled={busy || !draft.trim()}>
          {busy ? '添加中…' : '添加'}
        </button>
      </form>

      {error && <div className="banner error">{error}</div>}

      {loading ? (
        <p className="settings-note">加载中…</p>
      ) : sorted.length ? (
        <ul className="memory-list">
          {sorted.map((f) => (
            <MemoryItem key={f.id} fact={f} onChange={replace} onDelete={(id) => setFacts((list) => list.filter((x) => x.id !== id))} />
          ))}
        </ul>
      ) : (
        <p className="settings-note">还没有长期记忆。在「聊一聊」里告诉 Agent 一些长期信息，确认后就会出现在这里。</p>
      )}
    </div>
  )
}

export function SettingsPage() {
  const [params, setParams] = useSearchParams()
  const rawTab = params.get('tab')
  const tab = rawTab === 'reminder' || rawTab === 'memory' ? rawTab : 'access'

  return (
    <div className="page settings-page">
      <section className="page-head">
        <div>
          <h1>设置</h1>
          <p className="sub">在这里管理谁能看到你的记录、每天几点提醒你，以及 Agent 记住的长期信息。</p>
        </div>
      </section>

      <Link to="/usage" className="usage-entry">
        <span className="usage-entry-main">
          <span className="usage-entry-title">AI 用量</span>
          <span className="usage-entry-sub">查看 token 消耗与缓存命中率</span>
        </span>
        <span className="usage-entry-arrow" aria-hidden="true">
          ›
        </span>
      </Link>

      <div className="settings-tabs" role="tablist" aria-label="设置分类">
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'access'}
          className={tab === 'access' ? 'settings-tab active' : 'settings-tab'}
          onClick={() => setParams({ tab: 'access' }, { replace: true })}
        >
          授权设置
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'reminder'}
          className={tab === 'reminder' ? 'settings-tab active' : 'settings-tab'}
          onClick={() => setParams({ tab: 'reminder' }, { replace: true })}
        >
          提醒设置
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={tab === 'memory'}
          className={tab === 'memory' ? 'settings-tab active' : 'settings-tab'}
          onClick={() => setParams({ tab: 'memory' }, { replace: true })}
        >
          长期记忆
        </button>
      </div>

      <div className="settings-body">
        {tab === 'access' ? (
          <AccessPanel />
        ) : (
          <div className="settings-narrow">
            {tab === 'reminder' ? <ReminderPanel /> : <MemoryPanel />}
          </div>
        )}
      </div>
    </div>
  )
}
