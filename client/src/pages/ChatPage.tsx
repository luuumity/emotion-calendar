import { useEffect, useMemo, useRef, useState } from 'react'
import { useNavigate } from 'react-router-dom'
import { api, type ChatSession, type ChatMessage, type ChatProposal } from '../lib/api'

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
  const navigate = useNavigate()
  const [sessions, setSessions] = useState<ChatSession[]>([])
  const [activeId, setActiveId] = useState<number | null>(null)
  const [messages, setMessages] = useState<ChatMessage[]>([])
  const [sending, setSending] = useState(false)
  const [input, setInput] = useState('')
  const [sidebarOpen, setSidebarOpen] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const [hint, setHint] = useState<string | null>(null)
  const [pendingDeleteId, setPendingDeleteId] = useState<number | null>(null)

  const listRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  const hintTimer = useRef<number | null>(null)

  function flashHint(message: string) {
    setHint(message)
    if (hintTimer.current) window.clearTimeout(hintTimer.current)
    hintTimer.current = window.setTimeout(() => setHint(null), 1600)
  }

  useEffect(() => {
    return () => {
      if (hintTimer.current) window.clearTimeout(hintTimer.current)
    }
  }, [])

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
      flashHint('已在新会话中')
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

  async function deleteSession(id: number, e?: React.MouseEvent) {
    e?.stopPropagation?.()
    setPendingDeleteId(null)
    try {
      await api.deleteChatSession(id)
      const next = sessions.filter((s) => s.id !== id)
      setSessions(next)
      if (activeId === id) {
        const fallback = next[0]?.id ?? null
        if (fallback) {
          await selectSession(fallback)
        } else {
          setActiveId(null)
          setMessages([])
        }
      }
    } catch (e) {
      setError(e instanceof Error ? e.message : '删除失败')
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

  // 输入框随内容自动增高（最多 160px）
  useEffect(() => {
    const el = inputRef.current
    if (!el) return
    el.style.height = 'auto'
    el.style.height = Math.min(el.scrollHeight, 160) + 'px'
  }, [input])

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
    // 未确认的提议会随这条新消息作废，先在本地同步状态
    setMessages((prev) =>
      prev.map((m) =>
        m.proposals?.length
          ? { ...m, proposals: m.proposals.map((p) => (p.status === 'pending' ? { ...p, status: 'expired' } : p)) }
          : m
      )
    )
    setInput('')

    try {
      const res = await api.sendChatMessage(activeId, { content })
      // 用真实的 userMessage 替换乐观版本，追加 assistant
      setMessages((prev) => {
        const replaced = prev.map((m) => (m.id === optimisticUser.id ? res.userMessage : m))
        return [...replaced, res.assistantMessage]
      })
      // 首次发消息后后端会自动生成标题、messageCount 也会变，直接以服务端为准
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
      <div className="page-head chat-head">
        <h1 className="chat-title-inline">聊一聊</h1>
        <div className="chat-toolbar">
          <button
            type="button"
            className="ghost-btn small chat-sidebar-toggle"
            onClick={() => setSidebarOpen((v) => !v)}
            aria-label="切换会话列表"
          >
            {sidebarOpen ? '收起' : '会话列表'}
          </button>
          <button
            type="button"
            className="ghost-btn small chat-new-btn"
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
        <aside className={'chat-session-list ' + (sidebarOpen ? 'open' : '')}>
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
                  {pendingDeleteId === s.id ? (
                    <div className="chat-session-confirm" onClick={(e) => e.stopPropagation()}>
                      <button
                        type="button"
                        className="chat-session-confirm-yes"
                        onClick={(e) => deleteSession(s.id, e)}
                      >
                        删除
                      </button>
                      <button
                        type="button"
                        className="chat-session-confirm-no"
                        onClick={(e) => {
                          e.stopPropagation()
                          setPendingDeleteId(null)
                        }}
                      >
                        取消
                      </button>
                    </div>
                  ) : (
                    <button
                      type="button"
                      className="chat-session-del"
                      title="删除这个对话"
                      aria-label="删除这个对话"
                      onClick={(e) => {
                        e.stopPropagation()
                        setPendingDeleteId(s.id)
                      }}
                    >
                      🗑
                    </button>
                  )}
                </div>
              ))
            )}
          </div>

          <button type="button" className="chat-memory-link" onClick={() => navigate('/settings?tab=memory')}>
            <span>长期记忆</span>
            <span aria-hidden>→</span>
          </button>
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
                    跟懂你的 Persona Agent 聊一聊，它读过你的情绪日记、标签和过往分析。
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
                  ref={inputRef}
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
  const proposals = message.proposals || []
  return (
    <>
      <div className={'chat-bubble ' + (isUser ? 'user' : 'assistant')}>
        {message.content.split('\n').map((line, i) => (
          <p key={i}>{line || '\u00A0'}</p>
        ))}
        <span className="chat-bubble-time">{formatTime(message.createdAt)}</span>
      </div>
      {proposals.length > 0 && (
        <div className="chat-proposals">
          {proposals.map((p) => (
            <ProposalCard key={p.id} proposal={p} />
          ))}
        </div>
      )}
    </>
  )
}

const KIND_LABEL: Record<ChatProposal['kind'], string> = { fact: '记忆', tag: '标签', report: '报告', record: '记录' }
const TAG_TYPE_LABEL: Record<string, string> = {
  insight: '洞察',
  suggestion: '建议',
  pattern: '模式',
  correction: '纠正'
}

function proposalText(item: ChatProposal) {
  const p = item.finalPayload || item.payload
  if (item.kind === 'report') {
    const range = p?.start && p?.end ? `${p.start} ~ ${p.end}` : p?.periodType === 'month' ? '本月' : '本周'
    return `生成一份单人报告（${range}）`
  }
  if (item.kind === 'record') {
    const score = p?.score != null ? `${p.score} 分` : ''
    return `${p?.day || ''} ${score} ${p?.note || ''}`.trim()
  }
  return p?.content || ''
}

function ProposalCard({ proposal }: { proposal: ChatProposal }) {
  const [item, setItem] = useState(proposal)
  const [visible, setVisible] = useState(proposal.coupleVisible)
  const [draft, setDraft] = useState((proposal.finalPayload || proposal.payload)?.content || '')
  const [busy, setBusy] = useState(false)
  const [note, setNote] = useState<string | null>(null)
  const navigate = useNavigate()
  const pending = item.status === 'pending'
  const p = item.finalPayload || item.payload
  const editable = pending && (item.kind === 'fact' || item.kind === 'tag')

  async function accept() {
    if (busy) return
    if (editable && !draft.trim()) {
      setNote('内容不能为空')
      return
    }
    setBusy(true)
    setNote(null)
    try {
      const res = await api.acceptProposal(item.id, visible, editable ? { content: draft.trim() } : undefined)
      setItem(res.proposal)
      if (res.action) {
        setNote('正在生成报告…')
        try {
          await api.generateSingleInsight({
            periodType: res.action.periodType,
            start: res.action.start || undefined,
            end: res.action.end || undefined
          })
          navigate('/insights')
        } catch {
          setNote('已采纳，但生成失败，去报告页手动重试。')
        }
      }
    } catch (e) {
      setNote(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  async function reject() {
    if (busy) return
    setBusy(true)
    setNote(null)
    try {
      const res = await api.rejectProposal(item.id)
      setItem(res.proposal)
    } catch (e) {
      setNote(e instanceof Error ? e.message : '操作失败')
    } finally {
      setBusy(false)
    }
  }

  return (
    <div className={'chat-proposal ' + item.status}>
      <div className="chat-proposal-head">
        <span className="chat-proposal-kind">{KIND_LABEL[item.kind]}</span>
        {item.kind === 'tag' && p?.tagType && (
          <span className="chat-proposal-day">
            {p.recordDay ? `${p.recordDay} · ` : ''}
            {TAG_TYPE_LABEL[p.tagType] || p.tagType}
          </span>
        )}
      </div>
      {editable ? (
        <textarea
          className="chat-proposal-edit"
          value={draft}
          maxLength={500}
          rows={2}
          onChange={(e) => setDraft(e.target.value)}
        />
      ) : (
        <p className="chat-proposal-body">{proposalText(item)}</p>
      )}
      {pending && (item.kind === 'fact' || item.kind === 'tag') && (
        <label className="chat-proposal-toggle">
          <input type="checkbox" checked={visible} onChange={(e) => setVisible(e.target.checked)} />
          对另一半可见
        </label>
      )}
      {pending ? (
        <div className="chat-proposal-actions">
          <button type="button" className="primary-btn" onClick={accept} disabled={busy}>
            {busy ? '处理中…' : '采纳'}
          </button>
          <button type="button" className="ghost-btn small" onClick={reject} disabled={busy}>
            忽略
          </button>
        </div>
      ) : (
        <span className="chat-proposal-status">
          {item.status === 'accepted'
            ? item.kind === 'report'
              ? '已采纳'
              : `已保存（${item.coupleVisible ? '对另一半可见' : '仅自己可见'}${item.edited ? ' · 已修改' : ''}）`
            : item.status === 'expired'
              ? '已作废（你继续了新对话）'
              : '已忽略'}
        </span>
      )}
      {note && <span className="chat-proposal-note">{note}</span>}
    </div>
  )
}
