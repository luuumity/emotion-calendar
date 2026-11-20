import { useEffect, useMemo, useRef, useState } from 'react'
import { api, type ChatSession, type ChatMessage } from '../lib/api'

function formatTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

export function ChatPage() {
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [input, setInput] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)

  const listRef = useRef<HTMLDivElement>(null)
  const sidebarRef = useRef<HTMLElement | null>(null)

  // 侧边栏打开时，点外面自动收起（遮罩）
  useEffect(() => {
    if (!sidebarOpen) return
    function onDocClick(e: MouseEvent) {
      const t = e.target as Node
      if (sidebarRef.current && !sidebarRef.current.contains(t)) {
        const btn = document.querySelector('.chat-sidebar-toggle')
        if (!btn || !btn.contains(t)) {
          setSidebarOpen(false)
        }
      }
    }
    document.addEventListener('mousedown', onDocClick)
    return () => document.removeEventListener('mousedown', onDocClick)
  }, [sidebarOpen])

  async function loadSessions() {
    try {
      const res = await api.chatSessions()
      setSessions(res.sessions)
      return res.sessions
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
      return [] as ChatSession[]
    }
  }

  async function selectSession(id: number | null) {
    setActiveId(id)
    setMessages([])
    setError(null)
    if (!id) return
    try {
      const res = await api.chatMessages(id)
      setMessages(res.messages)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载消息失败')
    }
  }

  async function createAndSelect() {
    // 如果已经有一个还没发过消息的空会话，直接切过去，不重复建
    const existingEmpty = sessions.find((s) => s.messageCount === 0)
    if (existingEmpty) {
      if (existingEmpty.id !== activeId) {
        await selectSession(existingEmpty.id)
      }
      setHint('已在新会话中')
      setTimeout(() => setHint(null), 1600)
      setSidebarOpen(false)
      return
    }
    try {
      const res = await api.createChatSession('新对话')
      setSessions((prev) => [res.session, ...prev])
      setActiveId(res.session.id)
      setMessages([])
      setError(null)
      setSidebarOpen(false)
    } catch (e) {
      setError(e instanceof Error ? e.message : '创建失败')
    }
  }

  // 初始加载：拉列表，如果没有任何 session 就自动建一个空的新会话
  useEffect(() => {
    ;(async () => {
      const list = await loadSessions()
      if (list.length === 0) {
        const res = await api.createChatSession('新对话')
        setSessions([res.session])
        setActiveId(res.session.id)
      } else {
        await selectSession(list[0].id)
      }
    })()
  }, [])

  // 消息滚动到底
  useEffect(() => {
    const el = listRef.current
    if (el) el.scrollTop = el.scrollHeight
  }, [messages, sending])

  async function send() {
    if (!activeId || sending) return
    const content = input.trim()
    if (!content) return
    setSending(true)
    setError(null)

    // 乐观插入 user 消息
    const optimisticUser: ChatMessage = {
      id: Date.now(),
      role: 'user',
      content,
      createdAt: new Date().toISOString()
    }
    setMessages((prev) => [...prev, optimisticUser])
    setInput('')

    try {
      const res = await api.sendChatMessage(activeId, { content })
      // 用真实的 userMessage 替换乐观版本，追加 assistant
      setMessages((prev) => {
        const replaced = prev.map((m) => (m.id === optimisticUser.id ? res.userMessage : m))
        return [...replaced, res.assistantMessage]
      })
      setSessions((prev) => {
        // 如果后端自动更新了 title（第一次发消息），重新拉一下 session 更稳
        const updated = prev.map((s) =>
          s.id === activeId ? { ...s, messageCount: s.messageCount + 1, updatedAt: new Date().toISOString() } : s
        )
        return updated.sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      })
      // 第一次发消息后，后端会自动把 title 设成用户 query；重新拉一下列表拿到新 title
      const latestList = await api.chatSessions()
      setSessions(latestList.sessions)
    } catch (e) {
      setError(e instanceof Error ? e.message : '发送失败')
      // 移除假的 user 消息
      setMessages((prev) => prev.filter((m) => m.id !== optimisticUser.id))
    } finally {
      setSending(false)
    }
  }

  const activeSession = useMemo(() => sessions.find((s) => s.id === activeId) || null, [sessions, activeId])
  const nonEmptySessions = useMemo(() => sessions.filter((s) => s.messageCount > 0), [sessions])

  // 纯按钮触发发送。回车/Shift+回车都换行，符合移动端输入法直觉
  // （之前保留了 Shift+Enter=换行，Enter=发送的桌面规则；现在统一：点按钮才发）

  return (
    <div className="page chat-page">
      <div className="page-head">
        <div className="chat-head-left">
          <button
            type="button"
            className="ghost-btn small chat-sidebar-toggle"
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label="切换会话列表"
          >
            {sidebarOpen ? '收起' : '会话列表'}
          </button>
          <h1 className="chat-title-inline">聊一聊</h1>
        </div>
        <div className="chat-head-right">
          <button
            type="button"
            className="ghost-btn small"
            onClick={createAndSelect}
            title="新建对话"
            aria-label="新建对话"
          >
            ＋ 新对话
          </button>
        </div>
      </div>

      {error && <div className="banner error">{error}</div>}
      {hint && <div className="banner info">{hint}</div>}

      <div className="chat-layout">
        {sidebarOpen && (
          <div className="chat-sidebar-overlay" onClick={() => setSidebarOpen(false)} aria-hidden />
        )}
        <aside ref={sidebarRef} className={'chat-session-list ' + (sidebarOpen ? 'open' : '')}>
          <div className="chat-session-head">
            <span className="chat-session-title">历史会话</span>
          </div>

          <div className="chat-sessions-scroll">
            {nonEmptySessions.length === 0 ? (
              <p className="list-empty">还没有历史会话。</p>
            ) : (
              nonEmptySessions.map((s) => (
                <div
                  key={s.id}
                  className={'chat-session-item ' + (s.id === activeId ? 'active' : '')}
                  onClick={() => {
                    selectSession(s.id)
                    setSidebarOpen(false)
                  }}
                >
                  <div className="chat-session-item-main">
                    <strong>{s.title}</strong>
                    <span>{formatTime(s.updatedAt)}</span>
                  </div>
                </div>
              ))
            )}
          </div>
        </aside>

        <main className="chat-window">
          {!activeSession ? (
            <div className="chat-empty">
              <button type="button" className="primary-btn" onClick={createAndSelect}>
                ＋ 开启新对话
              </button>
              <p>点上面按钮就能和 Persona Agent 聊天了。</p>
            </div>
          ) : (
            <>
              <div className="chat-messages" ref={listRef}>
                {messages.length === 0 && !sending && (
                  <div className="chat-empty-inline">
                    它读过你的情绪日记、标签和过往分析，跟它聊聊吧。
                  </div>
                )}

                {messages.map((m) => (
                  <Bubble key={m.id} message={m} />
                ))}

                {sending && (
                  <div className="chat-bubble assistant loading">
                    <span className="chat-dot" />
                    <span className="chat-dot" />
                    <span className="chat-dot" />
                  </div>
                )}
              </div>

              <footer className="chat-input-area">
                <textarea
                  className="chat-input"
                  rows={1}
                  placeholder="说点什么…"
                  value={input}
                  disabled={sending}
                  onChange={(e) => setInput(e.target.value)}
                />
                <button
                  type="button"
                  className="primary-btn"
                  onClick={send}
                  disabled={sending || !input.trim()}
                >
                  {sending ? '…' : '发送'}
                </button>
              </footer>
            </>
          )}
        </main>
      </div>
    </div>
  )
}

function Bubble({ message }: { message: ChatMessage }) {
  const isUser = message.role === 'user'
  return (
    <div className={'chat-bubble ' + (isUser ? 'user' : 'assistant')}>
      {message.content.split('\n').map((line, i) => (
        <p key={i}>{line || '\u00A0'}</p>
      ))}
      <span className="chat-bubble-time">{formatTime(message.createdAt)}</span>
    </div>
  )
}
