import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, type AccessInfo, type Share } from '../lib/api'
import { errorMessage } from '../context/AuthContext'

function formatWhen(iso: string) {
  try {
    return new Date(iso).toLocaleDateString('zh-CN', { month: 'numeric', day: 'numeric' })
  } catch {
    return ''
  }
}

export function AccessPage() {
  const [info, setInfo] = useState<AccessInfo>({ mine: [], granted: [] })
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [notice, setNotice] = useState('')
  const [scope, setScope] = useState<'colors' | 'full'>('colors')
  const [label, setLabel] = useState('')
  const [creating, setCreating] = useState(false)
  const [newShare, setNewShare] = useState<Share | null>(null)
  const [tokenInput, setTokenInput] = useState('')
  const [redeeming, setRedeeming] = useState(false)
  const [copied, setCopied] = useState('')

  const refresh = () => {
    setLoading(true)
    api
      .access()
      .then(setInfo)
      .catch((err) => setError(errorMessage(err)))
      .finally(() => setLoading(false))
  }

  useEffect(refresh, [])

  const copy = async (text: string) => {
    try {
      await navigator.clipboard.writeText(text)
      setCopied(text)
      setTimeout(() => setCopied(''), 1600)
    } catch {
      setNotice(`复制失败，请手动选择：${text}`)
    }
  }

  const createShare = async () => {
    setCreating(true)
    setError('')
    try {
      const res = await api.createShare(scope, label.trim())
      setNewShare(res.share)
      setLabel('')
      refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setCreating(false)
    }
  }

  const revoke = async (share: Share) => {
    if (!window.confirm('撤销后，已经兑换凭证的人也会立即失去查看权限。确定吗？')) return
    try {
      await api.revokeShare(share.id)
      setInfo((prev) => ({
        ...prev,
        mine: prev.mine.map((item) => (item.id === share.id ? { ...item, revoked: true } : item))
      }))
      setNotice('这份授权已经撤销。')
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  const redeem = async () => {
    if (!tokenInput.trim()) return
    setRedeeming(true)
    setError('')
    setNotice('')
    try {
      const res = await api.redeem(tokenInput.trim())
      setNotice(`已获得 ${res.granted.displayName} 的只读授权。`)
      setTokenInput('')
      refresh()
    } catch (err) {
      setError(errorMessage(err))
    } finally {
      setRedeeming(false)
    }
  }

  const removeGrant = async (ownerId: number, name: string) => {
    if (!window.confirm(`确定不再查看 ${name} 的记录吗？`)) return
    try {
      await api.removeGrant(ownerId)
      setInfo((prev) => ({ ...prev, granted: prev.granted.filter((g) => g.id !== ownerId) }))
      setNotice('已移除这份查看权限。')
    } catch (err) {
      setError(errorMessage(err))
    }
  }

  return (
    <div className="page access-page">
      <section className="page-head">
        <div>
          <h1>授权管理</h1>
          <p className="sub">
            默认谁也不能看你的记录。生成一张凭证给对方，由你决定对方能看到颜色，还是连理由一起看到。只读，不能改。
          </p>
        </div>
      </section>

      {error && <div className="banner error">{error}</div>}
      {notice && <div className="banner success">{notice}</div>}

      <div className="access-grid">
        <section className="card">
          <div className="card-head">
            <h2>我授权给别人</h2>
            <span className="pill">我是记录的主人</span>
          </div>

          <div className="form-row">
            <label className="field-label">对方能看到什么</label>
            <div className="scope-options">
              <button
                type="button"
                className={scope === 'colors' ? 'scope-option active' : 'scope-option'}
                onClick={() => setScope('colors')}
              >
                <strong>仅颜色</strong>
                <span>能看到每天的分数、颜色和同感指数，看不到理由。</span>
              </button>
              <button
                type="button"
                className={scope === 'full' ? 'scope-option active' : 'scope-option'}
                onClick={() => setScope('full')}
              >
                <strong>颜色 + 理由</strong>
                <span>对方能读到你写的文字，但仍然不能编辑。</span>
              </button>
            </div>
          </div>

          <div className="form-row">
            <label className="field-label" htmlFor="share-label">
              备注（可选）
            </label>
            <div className="inline-form">
              <input
                id="share-label"
                value={label}
                maxLength={30}
                placeholder="比如：给对象、给咨询师"
                onChange={(event) => setLabel(event.target.value)}
              />
              <button type="button" className="primary-btn" onClick={createShare} disabled={creating}>
                {creating ? '生成中…' : '生成凭证'}
              </button>
            </div>
          </div>

          {newShare && (
            <div className="token-result">
              <span className="token-label">把这张凭证发给对方</span>
              <div className="token-box">
                <code>{newShare.token}</code>
                <button type="button" className="ghost-btn small" onClick={() => copy(newShare.token)}>
                  {copied === newShare.token ? '已复制' : '复制'}
                </button>
              </div>
              <span className="token-hint">
                {newShare.scope === 'full' ? '对方可以看颜色和理由' : '对方只能看颜色'} · 对方注册登录后输入凭证即可
              </span>
            </div>
          )}

          <div className="share-list">
            {info.mine.length === 0 && !loading && <div className="list-empty">还没有生成过凭证。</div>}
            {info.mine.map((share) => (
              <div key={share.id} className={share.revoked ? 'share-item revoked' : 'share-item'}>
                <div className="share-main">
                  <div className="share-line">
                    <strong>{share.label || '未命名授权'}</strong>
                    <span className={share.scope === 'full' ? 'tag full' : 'tag'}>
                      {share.scope === 'full' ? '颜色 + 理由' : '仅颜色'}
                    </span>
                    {share.revoked && <span className="tag muted">已撤销</span>}
                  </div>
                  <div className="share-token">
                    <code>{share.token}</code>
                    {!share.revoked && (
                      <button type="button" className="link-btn" onClick={() => copy(share.token)}>
                        {copied === share.token ? '已复制' : '复制'}
                      </button>
                    )}
                  </div>
                  <div className="share-meta">
                    {share.viewers.length > 0
                      ? `已兑换：${share.viewers.map((v) => v.displayName).join('、')}`
                      : '还没有人兑换'}
                    <span className="dot">·</span>
                    创建于 {formatWhen(share.createdAt)}
                  </div>
                </div>
                {!share.revoked && (
                  <button type="button" className="ghost-btn danger small" onClick={() => revoke(share)}>
                    撤销
                  </button>
                )}
              </div>
            ))}
          </div>
        </section>

        <section className="card">
          <div className="card-head">
            <h2>别人授权给我</h2>
            <span className="pill">只读访问</span>
          </div>

          <div className="form-row">
            <label className="field-label" htmlFor="token-input">
              输入对方给你的凭证
            </label>
            <div className="inline-form">
              <input
                id="token-input"
                value={tokenInput}
                placeholder="例如 9212-FDEE-1719-E0FC"
                onChange={(event) => setTokenInput(event.target.value)}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') void redeem()
                }}
              />
              <button type="button" className="primary-btn" onClick={redeem} disabled={redeeming}>
                {redeeming ? '兑换中…' : '兑换'}
              </button>
            </div>
            <span className="field-hint">兑换后，你可以在月视图和日视图里切换到对方的记录，但无法编辑。</span>
          </div>

          <div className="grant-list">
            {info.granted.length === 0 && !loading && (
              <div className="list-empty">还没有查看任何人的记录。拿到凭证后在这里兑换。</div>
            )}
            {info.granted.map((grant) => (
              <div key={grant.id} className="grant-item">
                <span className="avatar">{grant.displayName.slice(0, 1)}</span>
                <div className="grant-main">
                  <strong>{grant.displayName}</strong>
                  <span>
                    {grant.scope === 'full' ? '颜色 + 理由' : '仅颜色'} · 自 {formatWhen(grant.since)}
                  </span>
                </div>
                <div className="grant-actions">
                  <Link to={`/?person=${grant.id}`} className="ghost-btn small">
                    查看
                  </Link>
                  <button
                    type="button"
                    className="link-btn danger"
                    onClick={() => removeGrant(grant.id, grant.displayName)}
                  >
                    移除
                  </button>
                </div>
              </div>
            ))}
          </div>

          <div className="privacy-note">
            <h3>权限是怎么运作的</h3>
            <ul>
              <li>只有你生成凭证，对方才能看到你的数据；没有凭证就是完全隔离的。</li>
              <li>凭证可以随时撤销，撤销后立即生效。</li>
              <li>对方永远不能修改你的记录，也不能看到你未授权的内容。</li>
            </ul>
          </div>
        </section>
      </div>
    </div>
  )
}
