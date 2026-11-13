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

function sortById(records: RecordItem[]) {
  return records.slice().sort((a, b) => a.id - b.id)
}

export function DayPage() {
  const params = useParams()
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const date = DATE_RE.test(params.date || '') && !Number.isNaN(parseDay(params.date || '').getTime()) ? (params.date as string) : todayString()
  const asId = searchParams.get('as') ? Number(searchParams.get('as')) : null
  const today = todayString()

  const [granted, setGranted] = useState<Granted[]>([])
  const [records, setRecords] = useState<RecordItem[]>([])
  const [selectedId, setSelectedId] = useState<number | null>(null)
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
    setSelectedId(null)
    setError('')

    const load = async () => {
      try {
        if (asId == null) {
          const res = await api.listRecords(date, date)
          if (!alive) return
          setRecords(sortById(res.records))
          setScope(null)
          setOwnerName('')
        } else {
          const res = await api.personRecords(asId, date, date)
          if (!alive) return
          setRecords(sortById(res.records))
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
  }, [asId, date])

  const selected = records.find((r) => r.id === selectedId) || null
  const selectedNote = selected?.note
  const average = records.length
    ? Math.round(records.reduce((sum, r) => sum + r.score, 0) / records.length)
    : null

  useEffect(() => {
    setNoteDraft(selectedNote ?? '')
    setDirty(false)
    setSaveState('idle')
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, selectedNote, asId])

  useEffect(() => {
    if (!dirty || !editable || !selected) return undefined
    const timer = setTimeout(() => {
      void saveNote(noteDraft)
    }, 900)
    return () => clearTimeout(timer)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [noteDraft, dirty, editable, selected?.id])

  useEffect(() => {
    if (!toast) return undefined
    const timer = setTimeout(() => setToast(''), 2200)
    return () => clearTimeout(timer)
  }, [toast])

  const isFuture = date > today
  const canEdit = editable && !isFuture

  const balls: GachaBall[] = useMemo(
    () => records.map((r, index) => ({ id: r.id, score: r.score, index: index + 1 })),
    [records]
  )
  const stageKey = `${date}-${asId ?? 'me'}`

  function goDay(offset: number) {
    const d = parseDay(date)
    d.setDate(d.getDate() + offset)
    const next = toDayString(d)
    if (next > today) return
    navigate(`/day/${next}${asId ? `?as=${asId}` : ''}`)
  }

  function replaceRecord(record: RecordItem) {
    setRecords((prev) => sortById(prev.map((r) => (r.id === record.id ? record : r))))
  }

  async function applyScore(score: number) {
    if (!canEdit) return
    setSaveState('saving')

    if (selected) {
      try {
        const res = await api.updateRecord(selected.id, { score })
        replaceRecord(res.record)
        setSaveState('saved')
        setToast(`第 ${balls.find((b) => b.id === selected.id)?.index ?? ''} 颗改成 ${score} 分 · ${scoreLabel(score)}`)
      } catch (err) {
        setSaveState('error')
        setToast(errorMessage(err))
      }
      return
    }

    try {
      const res = await api.createRecord(date, score)
      setRecords((prev) => sortById([...prev, res.record]))
      setSelectedId(res.record.id)
      setSaveState('saved')
      setToast(`已投进一颗 ${score} 分 · ${scoreLabel(score)}`)
    } catch (err) {
      setSaveState('error')
      setToast(errorMessage(err))
    }
  }

  async function saveNote(text: string) {
    if (!canEdit || !selected) return
    setSaveState('saving')
    try {
      const res = await api.updateRecord(selected.id, { note: text })
      replaceRecord(res.record)
      setDirty(false)
      setSaveState('saved')
    } catch (err) {
      setSaveState('error')
      setToast(errorMessage(err))
    }
  }

  function handleSelect(nextId: number | null) {
    // 切换选中前先把没保存的理由写掉，避免因为取消选中而丢失输入。
    if (nextId !== selectedId && dirty && editable && selected) void saveNote(noteDraft)
    setSelectedId(nextId)
  }

  async function handleDelete() {
    if (!canEdit || !selected) return
    const index = balls.find((b) => b.id === selected.id)?.index ?? ''
    if (!window.confirm(`确定要删掉第 ${index} 颗扭蛋吗？`)) return
    try {
      await api.deleteRecord(selected.id)
      setRecords((prev) => prev.filter((r) => r.id !== selected.id))
      setSelectedId(null)
      setNoteDraft('')
      setSaveState('idle')
      setToast('这颗扭蛋已删除')
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
  const selectedIndex = selected ? balls.find((b) => b.id === selected.id)?.index ?? null : null

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
                {meta.label} · {records.length} 颗扭蛋{average != null ? ` · 平均 ${average} 分` : ''}
              </p>
            </div>
            <span className={editable ? 'status-dot editable' : 'status-dot readonly'}>
              {editable ? '可记录' : '只读'}
            </span>
          </div>

          <div ref={machineRef} className={drag?.over ? 'machine-wrap drop-active' : 'machine-wrap'}>
            <GachaMachine stageKey={stageKey} balls={balls} selectedId={selectedId} onSelect={handleSelect} />
            {drag?.over && <div className="drop-hint">{selected ? '松手，改成这个分数' : '松手，投进扭蛋机'}</div>}
          </div>

          {canEdit ? (
            <SwatchRail
              selectedScore={selected?.score ?? null}
              onDragStart={startDrag}
              title={selected ? `拖动色块修改第 ${selectedIndex} 颗` : '拖动色块投进扭蛋机'}
              hint={selected ? '点空白处取消选中，再投新的' : '或直接点一下'}
            />
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
                <span className="record-kicker">
                  {editable ? '我这一天的感受' : `${machineOwner} 的感受`}
                </span>
                <h2>{Number(date.slice(8, 10))} 日</h2>
              </div>
              {selected ? (
                <span
                  className="score-chip"
                  style={{
                    background: scoreSoftColor(selected.score, 0.16),
                    color: scoreColor(selected.score)
                  }}
                >
                  {selected.score}
                  <small>分</small>
                </span>
              ) : average != null ? (
                <span className="score-chip muted">均值 {average}</span>
              ) : (
                <span className="score-chip muted">未记录</span>
              )}
            </div>

            {selected ? (
              <>
                <div className="score-hero">
                  <div className="capsule-preview" style={{ background: scoreColor(selected.score) }}>
                    <span style={{ color: isDark(selected.score) ? '#fffaf2' : '#2f2a25' }}>{scoreLabel(selected.score)}</span>
                  </div>
                  <div className="score-meta">
                    <strong>{scoreLabel(selected.score)}</strong>
                    <span>
                      第 {selectedIndex} 颗 · 强度 {selected.score} / 100
                    </span>
                  </div>
                </div>

                <div className="note-block">
                  <div className="note-head">
                    <span>这一颗的理由</span>
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
                        placeholder="这一颗为什么是这个颜色？写给自己看，也可以授权给对方看。"
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
                    <div className="note-readonly">{selected.note?.trim() ? selected.note : '这一颗 TA 没有写下理由。'}</div>
                  )}
                </div>

                {editable && (
                  <div className="record-actions">
                    <button type="button" className="ghost-btn danger small" onClick={handleDelete}>
                      删除这一颗
                    </button>
                  </div>
                )}
              </>
            ) : records.length > 0 ? (
              <div className="record-empty">
                <p>
                  这一天有 {records.length} 颗扭蛋，平均 {average} 分。
                  {editable ? '点一下任意一颗，看当时的分数和理由。' : '点一下任意一颗，看看 TA 当时的感受。'}
                </p>
                <span className="empty-arrow">↖ 点击扭蛋可以选中</span>
              </div>
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
              <li>从红色到绿色，挑一个最接近此刻感受的颜色。</li>
              <li>拖进扭蛋机，同一天可以投很多颗，月视图取平均。</li>
              <li>点开任意一颗，补上当时的理由；再拖色块就能改这一颗。</li>
              <li>点一下空白处取消选中，就能继续投新的。</li>
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
