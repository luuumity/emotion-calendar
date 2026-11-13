import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, ApiError, type Granted, type RecordItem } from '../lib/api'
import { GachaMachine, type GachaBall } from '../components/GachaMachine'
import { SwatchRail } from '../components/ScoreBits'
import { isDark, scoreColor, scoreLabel, scoreSoftColor } from '../lib/colors'
import { formatDateLong, monthMeta, parseDay, todayString, toDayString } from '../lib/date'
import { errorMessage } from '../context/AuthContext'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

type DragState = { score: number; x: number; y: number; over: boolean }

export function DayPage() {
  const params = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const date = DATE_RE.test(params.date || '') && !Number.isNaN(parseDay(params.date || '').getTime()) ? (params.date as string) : todayString()
  const asId = searchParams.get('as') ? Number(searchParams.get('as')) : null
  const today = todayString()

  const [granted, setGranted] = useState<Granted[]>([])
  const [records, setRecords] = useState<RecordItem[]>([])
  const [scope, setScope] = useState<'colors' | 'full' | null>(null)
  const [ownerName, setOwnerName] = useState('')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const [noteDraft, setNoteDraft] = useState('')
  const [dirty, setDirty] = useState(false)
  const [saveState, setSaveState] = useState<'idle' | 'saving' | 'saved' | 'error'>('idle')
  const [toast, setToast] = useState('')
  const [drag, setDrag] = useState<DragState | null>(null)
  const machineRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<{ score: number; startX: number; startY: number; moved: boolean } | null>(null)

  const meta = useMemo(() => {
    const d = parseDay(date)
    return monthMeta(d.getFullYear(), d.getMonth())
  }, [date])

  const editable = asId == null
  const machineOwner = asId == null ? '我' : ownerName || 'TA'

  useEffect(() => {
    let alive = true
    api
      .access()
      .then((info) => {
        if (alive) setGranted(info.granted)
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    setRecords([])
    setError('')

    const load = async () => {
      try {
        if (asId == null) {
          const res = await api.listRecords(meta.from, meta.to)
          if (!alive) return
          setRecords(res.records)
          setScope(null)
          setOwnerName('')
        } else {
          const res = await api.personRecords(asId, meta.from, meta.to)
          if (!alive) return
          setRecords(res.records)
          setScope(res.scope)
          setOwnerName(res.owner.displayName)
        }
      } catch (err) {
        if (!alive) return
        setRecords([])
        setScope(null)
        setError(err instanceof ApiError && err.status === 403 ? '你还没有查看这个人的授权。' : errorMessage(err))
      } finally {
        if (alive) setLoading(false)
      }
    }

    void load()

    return () => {
      alive = false
    }
  }, [asId, meta.from, meta.to])

  const record = records.find((r) => r.day === date) || null
  const recordNote = record?.note

  useEffect(() => {
    setNoteDraft(recordNote ?? '')
    setDirty(false)
    setSaveState('idle')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [record?.day, recordNote, asId])

  useEffect(() => {
    if (!dirty || !editable || !record) return undefined
    const timer = setTimeout(() => {
      void saveNote(noteDraft)
    }, 900)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteDraft, dirty, editable, record?.day])

  useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(() => setToast(''), 2200)
    return () => clearTimeout(timer)
  }, [toast])

  const isFuture = date > today
  const canEdit = editable && !isFuture

  const balls: GachaBall[] = useMemo(() => records.map((r) => ({ day: r.day, score: r.score })), [records])
  const monthKey = `${meta.year}-${meta.month}-${asId ?? 'me'}`

  function goDay(offset: number) {
    const d = parseDay(date)
    d.setDate(d.getDate() + offset)
    const next = toDayString(d)
    if (next > today) return
    navigate(`/day/${next}${asId ? `?as=${asId}` : ''}`)
  }

  async function applyScore(score: number) {
    if (!canEdit) return
    const optimistic: RecordItem = { day: date, score, note: noteDraft || record?.note || '' }
    setRecords((prev) => {
      const others = prev.filter((r) => r.day !== date)
      return [...others, optimistic].sort((a, b) => a.day.localeCompare(b.day))
    })
    setSaveState('saving')
    try {
      const res = await api.saveRecord(date, score, noteDraft)
      setRecords((prev) => {
        const others = prev.filter((r) => r.day !== date)
        return [...others, res.record].sort((a, b) => a.day.localeCompare(b.day))
      })
      setSaveState('saved')
      setToast(`已记录 ${score} 分 · ${scoreLabel(score)}`)
    } catch (err) {
      setSaveState('error')
      setToast(errorMessage(err))
    }
  }

  async function saveNote(text: string) {
    if (!canEdit || !record) return
    setSaveState('saving')
    try {
      const res = await api.saveRecord(date, record.score, text)
      setRecords((prev) => {
        const others = prev.filter((r) => r.day !== date)
        return [...others, res.record].sort((a, b) => a.day.localeCompare(b.day))
      })
      setDirty(false)
      setSaveState('saved')
    } catch (err) {
      setSaveState('error')
      setToast(errorMessage(err))
    }
  }

  async function handleDelete() {
    if (!canEdit || !record) return
    if (!window.confirm('确定要删掉这一天的记录吗？')) return
    try {
      await api.deleteRecord(date)
      setRecords((prev) => prev.filter((r) => r.day !== date))
      setNoteDraft('')
      setSaveState('idle')
      setToast('这一天的记录已删除')
    } catch (err) {
      setToast(errorMessage(err))
    }
  }

  function isOverMachine(x: number, y: number) {
    const el = machineRef.current
    if (!el) return false
    const rect = el.getBoundingClientRect()
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  }

  function endDrag() {
    dragRef.current = null
    setDrag(null)
    window.removeEventListener('pointermove', handlePointerMove)
    window.removeEventListener('pointerup', handlePointerUp)
  }

  function handlePointerMove(event: PointerEvent) {
    const state = dragRef.current
    if (!state) return
    if (Math.hypot(event.clientX - state.startX, event.clientY - state.startY) > 6) state.moved = true
    setDrag({ score: state.score, x: event.clientX, y: event.clientY, over: isOverMachine(event.clientX, event.clientY) })
  }

  function handlePointerUp(event: PointerEvent) {
    const state = dragRef.current
    if (!state) return
    const over = isOverMachine(event.clientX, event.clientY)
    const shouldApply = over || !state.moved
    endDrag()
    if (shouldApply) void applyScore(state.score)
  }

  function startDrag(score: number, event: ReactPointerEvent) {
    if (!canEdit) return
    dragRef.current = { score, startX: event.clientX, startY: event.clientY, moved: false }
    setDrag({ score, x: event.clientX, y: event.clientY, over: isOverMachine(event.clientX, event.clientY) })
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
  }

  useEffect(() => {
    return () => {
      window.removeEventListener('pointermove', handlePointerMove)
      window.removeEventListener('pointerup', handlePointerUp)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  function switchPerson(nextId: number | null) {
    navigate(`/day/${date}${nextId ? `?as=${nextId}` : ''}`)
  }

  const showNote = asId == null || scope === 'full'
  const doneDays = records.length

  return (
    <div className="page day-page">
      <div className="day-toolbar">
        <Link to="/" className="back-link">
          ← 月视图
        </Link>

        <div className="day-nav">
          <button type="button" className="icon-btn small" onClick={() => goDay(-1)} aria-label="前一天">
            ‹
          </button>
          <div className="day-title">
            <strong>{formatDateLong(date)}</strong>
            {date === today && <span className="pill today-pill">今天</span>}
          </div>
          <button
            type="button"
            className="icon-btn small"
            onClick={() => goDay(1)}
            aria-label="后一天"
            disabled={date >= today}
          >
            ›
          </button>
        </div>

        {granted.length > 0 && (
          <div className="person-switch compact">
            <button type="button" className={asId == null ? 'chip active' : 'chip'} onClick={() => switchPerson(null)}>
              我
            </button>
            {granted.map((person) => (
              <button
                key={person.id}
                type="button"
                className={asId === person.id ? 'chip active' : 'chip'}
                onClick={() => switchPerson(person.id)}
              >
                {person.displayName}
              </button>
            ))}
          </div>
        )}
      </div>

      {error && <div className="banner error">{error}</div>}
      {isFuture && <div className="banner info">这一天还没到，先去看看今天吧。</div>}

      <div className="day-layout">
        <section className="card machine-card">
          <div className="card-head">
            <div>
              <h2>{machineOwner === '我' ? '我的扭蛋机' : `${machineOwner} 的扭蛋机`}</h2>
              <p className="machine-sub">
                {meta.label} · {doneDays} 颗扭蛋
              </p>
            </div>
            <span className={editable ? 'status-dot editable' : 'status-dot readonly'}>
              {editable ? '可记录' : '只读'}
            </span>
          </div>

          <div ref={machineRef} className={drag?.over ? 'machine-wrap drop-active' : 'machine-wrap'}>
            <GachaMachine
              monthKey={monthKey}
              balls={balls}
              selectedDay={date}
              onSelectDay={(day) => {
                if (day === date) return
                navigate(`/day/${day}${asId ? `?as=${asId}` : ''}`)
              }}
            />
            {drag?.over && <div className="drop-hint">松手，投进这一天</div>}
          </div>

          {canEdit ? (
            <SwatchRail selectedScore={record?.score ?? null} onDragStart={startDrag} />
          ) : (
            <div className="readonly-strip">
              {isFuture ? '还没到这一天，不能记录。' : `这是 ${machineOwner} 的扭蛋机，只能看，不能改。`}
            </div>
          )}
        </section>

        <aside className="day-side">
          <section className="card record-card">
            <div className="record-head">
              <div>
                <span className="record-kicker">{editable ? '我这一天的感受' : `${machineOwner} 的感受`}</span>
                <h2>{Number(date.slice(8, 10))} 日</h2>
              </div>
              {record ? (
                <span
                  className="score-chip"
                  style={{
                    background: scoreSoftColor(record.score, 0.16),
                    color: scoreColor(record.score)
                  }}
                >
                  {record.score}
                  <small>分</small>
                </span>
              ) : (
                <span className="score-chip muted">未记录</span>
              )}
            </div>

            {record ? (
              <>
                <div className="score-hero">
                  <div className="capsule-preview" style={{ background: scoreColor(record.score) }}>
                    <span style={{ color: isDark(record.score) ? '#fffaf2' : '#2f2a25' }}>{scoreLabel(record.score)}</span>
                  </div>
                  <div className="score-meta">
                    <strong>{scoreLabel(record.score)}</strong>
                    <span>强度 {record.score} / 100</span>
                  </div>
                </div>

                <div className="note-block">
                  <div className="note-head">
                    <span>当时的理由</span>
                    {editable && (
                      <span className={`save-state ${saveState}`}>
                        {saveState === 'saving' ? '保存中…' : saveState === 'saved' ? '已保存' : saveState === 'error' ? '保存失败' : ''}
                      </span>
                    )}
                  </div>

                  {!showNote ? (
                    <div className="note-locked">TA 只授权了颜色，理由没有开放。</div>
                  ) : editable ? (
                    <>
                      <textarea
                        className="note-input"
                        value={noteDraft}
                        maxLength={2000}
                        placeholder="当时为什么是这个颜色？写给自己看，也可以授权给对方看。"
                        onChange={(event) => {
                          setNoteDraft(event.target.value)
                          setDirty(true)
                        }}
                        onBlur={() => {
                          if (dirty) void saveNote(noteDraft)
                        }}
                      />
                      <div className="note-foot">
                        <span>{noteDraft.length} / 2000</span>
                        <button
                          type="button"
                          className="ghost-btn small"
                          onClick={() => void saveNote(noteDraft)}
                          disabled={!dirty}
                        >
                          保存
                        </button>
                      </div>
                    </>
                  ) : (
                    <div className="note-readonly">{record.note?.trim() ? record.note : '这一天 TA 没有写下理由。'}</div>
                  )}
                </div>

                {editable && (
                  <div className="record-actions">
                    <button type="button" className="ghost-btn danger small" onClick={handleDelete}>
                      删除这一天
                    </button>
                  </div>
                )}
              </>
            ) : (
              <div className="record-empty">
                <p>
                  {editable
                    ? '这一天还没有扭蛋。挑一个颜色，拖进扭蛋机里。'
                    : `${machineOwner} 这一天还没有记录。`}
                </p>
                {editable && <span className="empty-arrow">↗ 试试拖动色块</span>}
              </div>
            )}
          </section>

          <section className="card privacy-card">
            <h3>关于隐私</h3>
            <p>
              颜色和理由默认只有你自己能看到。对方必须拿到你生成的凭证，才能以只读方式查看；你随时可以在授权管理里撤销。
            </p>
          </section>

          <section className="card tip-card">
            <h3>怎么玩</h3>
            <ol>
              <li>从红色到绿色，挑一个最接近今天感受的颜色。</li>
              <li>拖进扭蛋机，它会和过去的扭蛋撞在一起。</li>
              <li>点开任意一颗扭蛋，补上当时的理由。</li>
            </ol>
          </section>
        </aside>
      </div>

      {loading && <div className="loading-hint">正在装填扭蛋机…</div>}
      {toast && <div className="toast">{toast}</div>}
      {drag && (
        <div
          className={drag.over ? 'drag-ghost over' : 'drag-ghost'}
          style={{ left: drag.x, top: drag.y, background: scoreColor(drag.score) }}
        >
          {drag.score}
        </div>
      )}
    </div>
  )
}
