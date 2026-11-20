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

  const listRef = useRef<HTMLDivElement>(null)

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

  async function deleteSession(id: number) {
    if (!confirm('删除这个对话？（不可恢复）')) return
    try {
      await api.deleteChatSession(id)
      const next = sessions.filter((s) => s.id !== id)
      setSessions(next)
      if (activeId === id) {
        const fallback = next[0]?.id ?? null
        setActiveId(fallback)
        if (fallback) {
          const res = await api.chatMessages(fallback)
          setMessages(res.messages)
        } else {
          setMessages([])
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败')
    }
  }

  // 初始加载
  useEffect(() => {
    ;(async () => {
      const list = await loadSessions()
      if (list.length > 0) {
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
      // 更新 session 列表里的 messageCount 和顺序
      setSessions((prev) => {
        return prev
          .map((s) => (s.id === activeId ? { ...s, messageCount: s.messageCount + 1, updatedAt: new Date().toISOString() } : s))
          .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt))
      })
    } catch (e) {
      setError(e instanceof Error ? e.message : '发送失败')
      // 移除假的 user 消息
      setMessages((prev) => prev.filter((m) => m.id !== optimisticUser.id))
    } finally {
      setSending(false)
    }
  }

  const activeSession = useMemo(() => sessions.find((s) => s.id === activeId) || null, [sessions, activeId])

  function onKeyDown(e: React.KeyboardEvent<HTMLTextAreaElement>) {
    if (e.key === 'Enter' && !e.shiftKey) {
      e.preventDefault()
      send()
    }
  }

  return (
    <div className="page chat-page">
      <div className="page-head">
        <div>
          <h1>聊一聊</h1>
          <p className="sub">和懂你的 Persona Agent 聊聊吧——它读过你的情绪日记、标签和过往分析。</p>
        </div>
        <button
          type="button"
          className="ghost-btn small chat-sidebar-toggle"
          onClick={() => setSidebarOpen((v) => !v)}
          aria-label="切换会话列表"
        >
          {sidebarOpen ? '收起' : '会话'}
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      <div className="chat-layout">
        <aside className={'chat-session-list ' + (sidebarOpen ? 'open' : '')}>
          <div className="chat-session-head">
            <span className="chat-session-title">历史会话</span>
            <button type="button" className="icon-btn small" onClick={createAndSelect} title="新建对话">+</button>
          </div>

          <button type="button" className={'chat-session-new ' + (activeId === null ? 'active' : '')} onClick={createAndSelect}>
            ＋ 开启新对话
          </button>

          <div className="chat-sessions-scroll">
            {sessions.length === 0 ? (
              <p className="list-empty">还没有会话，点上面按钮开一个吧。</p>
            ) : (
              sessions.map((s) => (
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
                    <span>{s.messageCount} 条 · {formatTime(s.updatedAt)}</span>
                  </div>
                  <button
                    type="button"
                    className="chat-session-del"
                    onClick={(e) => {
                      e.stopPropagation()
                      deleteSession(s.id)
                    }}
                    title="删除"
                  >
                    ✕
                  </button>
                </div>
              ))
            )}
          </div>
        </aside>

        <main className="chat-window">
          {!activeSession ? (
            <div className="chat-empty">
              <h3>开始第一段对话</h3>
              <p>点左上角「＋」或者「开启新对话」，就可以和 Persona Agent 聊天了。</p>
              <button type="button" className="primary-btn" onClick={createAndSelect}>
                开启新对话
              </button>
            </div>
          ) : (
            <>
              <header className="chat-window-head">
                <strong>{activeSession.title}</strong>
                <span>{activeSession.messageCount} 条消息</span>
              </header>

              <div className="chat-messages" ref={listRef}>
                {messages.length === 0 && !sending && (
                  <div className="chat-empty-inline">
                    给 Persona Agent 写点什么吧。它会参考你的情绪记录和 facts 来回应你。
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
                  placeholder="说点什么…（Enter 发送，Shift+Enter 换行）"
                  value={input}
                  disabled={sending}
                  onChange={(e) => setInput(e.target.value)}
                  onKeyDown={onKeyDown}
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
