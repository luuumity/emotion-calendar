import { useEffect, useState } from 'react'
import { Link } from 'react-router-dom'
import { api, ApiError, type UsageKind, type UsageSummary } from '../lib/api'

const KIND_LABEL: Record<UsageKind, string> = {
  chat: '聊一聊',
  single: '单人报告',
  couple: '双人报告'
}

function formatTokens(value: number) {
  if (value >= 10000) return `${(value / 10000).toFixed(1)} 万`
  return value.toLocaleString('zh-CN')
}

function formatRate(rate: number | null) {
  if (rate === null || Number.isNaN(rate)) return '—'
  return `${Math.round(rate * 100)}%`
}

type Range = 'month' | '30d'

export function UsagePage() {
  const [range, setRange] = useState<Range>('month')
  const [data, setData] = useState<UsageSummary | null>(null)
  const [error, setError] = useState('')
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let alive = true
    setLoading(true)
    setError('')
    api
      .usageSummary(range)
      .then((result) => {
        if (alive) setData(result)
      })
      .catch((err) => {
        if (alive) setError(err instanceof ApiError ? err.message : '加载失败，请稍后再试')
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [range])

  const maxTokens = data ? Math.max(1, ...data.kinds.map((item) => item.tokens)) : 1

  return (
    <div className="page settings-page usage-page">
      <Link to="/settings" className="back-link">
        ← 返回设置
      </Link>

      <section className="page-head">
        <div>
          <h1>AI 用量</h1>
          <p className="sub">「聊一聊」和 AI 报告共同消耗的 token。这里只统计用量，费用以官方账单为准。</p>
        </div>
      </section>

      <div className="usage-range" role="tablist" aria-label="统计区间">
        <button
          type="button"
          role="tab"
          aria-selected={range === 'month'}
          className={range === 'month' ? 'chip active' : 'chip'}
          onClick={() => setRange('month')}
        >
          本月
        </button>
        <button
          type="button"
          role="tab"
          aria-selected={range === '30d'}
          className={range === '30d' ? 'chip active' : 'chip'}
          onClick={() => setRange('30d')}
        >
          近 30 天
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {loading && !data ? (
        <p className="settings-note">正在统计…</p>
      ) : data ? (
        <>
          <section className="card usage-card">
            <div className="usage-total">
              <span>总 token</span>
              <strong>{formatTokens(data.totals.tokens)}</strong>
            </div>
            <div className="usage-split">
              <div>
                <span>输入</span>
                <b>{formatTokens(data.totals.input)}</b>
              </div>
              <div>
                <span>输出</span>
                <b>{formatTokens(data.totals.output)}</b>
              </div>
              <div>
                <span>缓存命中率</span>
                <b>{formatRate(data.totals.hitRate)}</b>
              </div>
            </div>
            <p className="usage-note">
              {data.totals.calls} 次调用 · 统计自 {data.startDate}
            </p>
          </section>

          {data.totals.calls === 0 ? (
            <p className="settings-note">这段时间还没有 AI 调用记录。</p>
          ) : (
            <ul className="usage-kinds">
              {data.kinds.map((item) => (
                <li key={item.kind} className="usage-kind">
                  <div className="usage-kind-head">
                    <span>{KIND_LABEL[item.kind]}</span>
                    <b>{formatTokens(item.tokens)}</b>
                  </div>
                  <div className="usage-bar" aria-hidden="true">
                    <span style={{ width: `${(item.tokens / maxTokens) * 100}%` }} />
                  </div>
                  <p className="usage-kind-meta">
                    输入 {formatTokens(item.input)} · 输出 {formatTokens(item.output)} · 命中{' '}
                    {formatRate(item.hitRate)} · {item.calls} 次
                  </p>
                </li>
              ))}
            </ul>
          )}

          <p className="usage-footnote">
            输入 token 包含每轮重新发送的对话历史，因此会明显大于聊天正文；缓存命中部分通常更便宜。
            {data.trackedFrom ? ` 明细统计自 ${data.trackedFrom}。` : ''}
          </p>
        </>
      ) : null}
    </div>
  )
}
