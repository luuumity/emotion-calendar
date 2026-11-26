// 公开分享页：只读展示一段对话快照，不需要登录。
// 仅渲染 role/content；提示词、提议卡片、引用等内部状态不在快照里。

import { useEffect, useState } from 'react'
import { Link, useParams } from 'react-router-dom'
import { api, type PublicChatShare } from '../lib/api'
import { Markdown } from '../components/Markdown'

function formatDay(iso: string) {
  const d = new Date(iso)
  if (Number.isNaN(d.getTime())) return ''
  return d.toLocaleDateString('zh-CN', { year: 'numeric', month: 'long', day: 'numeric' })
}

export function SharePage() {
  const { token = '' } = useParams()
  const [data, setData] = useState<PublicChatShare | null>(null)
  const [error, setError] = useState('')

  useEffect(() => {
    if (!token) {
      setError('链接不完整，请向分享者重新索取')
      return
    }
    let cancelled = false
    api
      .publicShare(token)
      .then((res) => {
        if (!cancelled) setData(res.share)
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : '分享不存在或已失效')
      })
    return () => {
      cancelled = true
    }
  }, [token])

  useEffect(() => {
    if (!data) return
    const previous = document.title
    document.title = `${data.title} · 情绪日历`
    return () => {
      document.title = previous
    }
  }, [data])

  if (error) {
    return (
      <div className="share-page">
        <div className="share-state">
          <h1>链接不可用</h1>
          <p>{error}</p>
          <Link className="primary-btn inline" to="/">
            打开情绪日历
          </Link>
        </div>
      </div>
    )
  }

  if (!data) {
    return (
      <div className="share-page">
        <div className="share-state">
          <p>正在打开分享…</p>
        </div>
      </div>
    )
  }

  return (
    <div className="share-page">
      <header className="share-head">
        <span className="share-brand">情绪日历</span>
        <span className="share-meta">
          {formatDay(data.createdAt)} · {data.messages.length} 条消息
        </span>
      </header>

      <main className="share-body">
        <h1>{data.title}</h1>
        <p className="share-tip">这是一段来自情绪日历的对话分享，只读。</p>

        <div className="share-messages">
          {data.messages.map((m) => (
            <div key={m.id} className={'share-bubble ' + m.role}>
              {m.role === 'user' ? <p>{m.content}</p> : <Markdown content={m.content} />}
            </div>
          ))}
        </div>
      </main>

      <footer className="share-foot">
        <Link to="/">也想记录情绪？打开情绪日历 →</Link>
      </footer>
    </div>
  )
}
