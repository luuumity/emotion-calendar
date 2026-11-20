import { useEffect, useMemo, useRef, useState } from 'react'
import type { PointerEvent as ReactPointerEvent } from 'react'
import { Link, useNavigate, useParams, useSearchParams } from 'react-router-dom'
import { api, ApiError, type Granted, type RecordItem, type RecordTag } from '../lib/api'
import { GachaMachine, type GachaBall } from '../components/GachaMachine'
import { SwatchRail } from '../components/ScoreBits'
import { isDark, scoreColor, scoreLabel, scoreSoftColor } from '../lib/colors'
import { formatDateLong, monthMeta, parseDay, todayString, toDayString } from '../lib/date'
import { errorMessage } from '../context/AuthContext'

const DATE_RE = /^\d{4}-\d{2}-\d{2}$/

type DragState =
  | { kind: 'create'; score: number; x: number; y: number; over: boolean }
  | { kind: 'delete'; id: number; score: number; index: number; x: number; y: number; over: boolean; source: 'ball' }

type DragSession = { kind: 'create'; score: number; startX: number; startY: number; moved: boolean }

function sortById(records: RecordItem[]) {
  return records.slice().sort((a, b) => a.id - b.id)
}

function labelForTag(type: RecordTag['tagType']) {
  switch (type) {
    case 'insight': return '洞察'
    case 'suggestion': return '建议'
    case 'pattern': return '模式'
    case 'correction': return '修正'
    default: return type
  }
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
  const [scoreEditing, setScoreEditing] = useState(false)
  const [scoreDraft, setScoreDraft] = useState(0)
  const [scoreSaving, setScoreSaving] = useState(false)
  const [tags, setTags] = useState<RecordTag[]>([])
  const [tagsLoading, setTagsLoading] = useState(false)
  const machineRef = useRef<HTMLDivElement | null>(null)
  const dragRef = useRef<DragSession | null>(null)
  const ballDragRef = useRef<GachaBall | null>(null)
  const deleteZoneRef = useRef<HTMLDivElement | null>(null)
  const noteCardRef = useRef<HTMLElement | null>(null)
  const draftRef = useRef(noteDraft)
  const selectedNoteRef = useRef<string | undefined>(undefined)
  const saveChainRef = useRef<Promise<void>>(Promise.resolve())
  const lastSavedRef = useRef<{ id: number; text: string } | null>(null)

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

  draftRef.current = noteDraft
  selectedNoteRef.current = selectedNote

  useEffect(() => {
    // 只在切换扭蛋时用服务器内容重置草稿，避免保存回包覆盖正在输入的文字
    setNoteDraft(selectedNoteRef.current ?? '')
    setDirty(false)
    setSaveState('idle')
    setScoreEditing(false)
    if (selected) setScoreDraft(selected.score)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selected?.id, asId])

  // 选中扭蛋后拉 AI 标签
  useEffect(() => {
    let alive = true
    async function load() {
      if (!selected) {
        setTags([])
        setTagsLoading(false)
        return
      }
      setTagsLoading(true)
      try {
        const res = await api.tagsOfRecord(selected.id)
        if (alive) setTags(res.tags)
      } catch {
        if (alive) setTags([])
      } finally {
        if (alive) setTagsLoading(false)
      }
    }
    void load()
    return () => {
      alive = false
    }
  }, [selected?.id])

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

  // 切到后台 / 关闭页面时兜底保存，避免手机切换应用时丢掉没失焦的文字
  useEffect(() => {
    const flush = () => {
      if (dirty && editable && selected && canEdit) void saveNote(noteDraft)
    }
    const onVisibility = () => {
      if (document.visibilityState === 'hidden') flush()
    }
    const onPageHide = () => {
      if (!dirty || !editable || !selected || !canEdit) return
      void api.updateRecord(selected.id, { note: noteDraft }, { keepalive: true }).catch(() => {})
    }
    document.addEventListener('visibilitychange', onVisibility)
    window.addEventListener('pagehide', onPageHide)
    return () => {
      document.removeEventListener('visibilitychange', onVisibility)
      window.removeEventListener('pagehide', onPageHide)
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [dirty, editable, selected, noteDraft, canEdit])

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

  async function createBall(score: number) {
    if (!canEdit) return
    try {
      const res = await api.createRecord(date, score)
      setRecords((prev) => sortById([...prev, res.record]))
      handleSelect(res.record.id)
      setToast(`已投进一颗 ${score} 分 · ${scoreLabel(score)}，可以写理由了`)
      // 手机上把理由框带到视野里，避免用户往下滑时误触机器底座
      window.setTimeout(() => {
        noteCardRef.current?.scrollIntoView({ behavior: 'smooth', block: 'nearest' })
      }, 80)
    } catch (err) {
      setToast(errorMessage(err))
    }
  }

  async function saveNote(text: string) {
    if (!canEdit || !selected) return
    const recordId = selected.id
    if (lastSavedRef.current?.id === recordId && lastSavedRef.current.text === text) {
      setDirty(false)
      return
    }
    // 串行保存：保证最后一次输入最后落库，不会被旧请求覆盖
    saveChainRef.current = saveChainRef.current.then(async () => {
      setSaveState('saving')
      try {
        const res = await api.updateRecord(recordId, { note: text })
        replaceRecord(res.record)
        lastSavedRef.current = { id: recordId, text }
        if (draftRef.current === text) {
          setDirty(false)
          setSaveState('saved')
        } else {
          // 保存期间又继续输入了，草稿保持“未保存”，下次失焦再存
          setSaveState('idle')
        }
      } catch (err) {
        setSaveState('error')
        setToast(errorMessage(err))
      }
    })
  }

  function handleSelect(nextId: number | null) {
    // 切换选中前先把没保存的理由写掉，避免因为取消选中而丢失输入。
    if (nextId !== selectedId && dirty && editable && selected) void saveNote(noteDraft)
    setSelectedId(nextId)
  }

  async function deleteBall(id: number) {
    if (!canEdit) return
    const index = balls.find((b) => b.id === id)?.index
    try {
      await api.deleteRecord(id)
      setRecords((prev) => prev.filter((r) => r.id !== id))
      if (selectedId === id) {
        setSelectedId(null)
        setNoteDraft('')
        setDirty(false)
        setSaveState('idle')
      }
      setToast(index ? `第 ${index} 颗已删除` : '这颗扭蛋已删除')
    } catch (err) {
      setToast(errorMessage(err))
    }
  }

  async function handleDelete() {
    if (!canEdit || !selected) return
    const index = balls.find((b) => b.id === selected.id)?.index ?? ''
    if (!window.confirm(`确定要删掉第 ${index} 颗扭蛋吗？`)) return
    await deleteBall(selected.id)
  }

  async function saveScore() {
    if (!canEdit || !selected || !scoreEditing) return
    const nextScore = Math.max(0, Math.min(100, Math.round(scoreDraft)))
    if (nextScore === selected.score) {
      setScoreEditing(false)
      return
    }
    setScoreSaving(true)
    try {
      const res = await api.updateRecord(selected.id, { score: nextScore })
      replaceRecord(res.record)
      setScoreEditing(false)
      setToast(`分值已调整为 ${nextScore}`)
    } catch (err) {
      setToast(errorMessage(err))
    } finally {
      setScoreSaving(false)
    }
  }

  async function removeTag(tagId: number) {
    try {
      await api.deleteTag(tagId)
      setTags((prev) => prev.filter((t) => t.id !== tagId))
    } catch {
      setToast('删除标签失败')
    }
  }

  function isOverMachine(x: number, y: number) {
    const el = machineRef.current
    if (!el) return false
    const rect = el.getBoundingClientRect()
    return x >= rect.left && x <= rect.right && y >= rect.top && y <= rect.bottom
  }

  function isOverDeleteZone(x: number, y: number) {
    const el = deleteZoneRef.current
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
    setDrag({
      kind: 'create',
      score: state.score,
      x: event.clientX,
      y: event.clientY,
      over: isOverMachine(event.clientX, event.clientY)
    })
  }

  function handlePointerUp(event: PointerEvent) {
    const state = dragRef.current
    if (!state) return
    const over = isOverMachine(event.clientX, event.clientY)
    const tapped = !state.moved
    endDrag()
    if (over || tapped) {
      // 点击和拖进扭蛋机都只负责新建，不会改到已选中的扭蛋
      void createBall(state.score)
    }
  }

  function startDrag(score: number, event: ReactPointerEvent) {
    if (!canEdit) return
    dragRef.current = { kind: 'create', score, startX: event.clientX, startY: event.clientY, moved: false }
    setDrag({ kind: 'create', score, x: event.clientX, y: event.clientY, over: isOverMachine(event.clientX, event.clientY) })
    window.addEventListener('pointermove', handlePointerMove)
    window.addEventListener('pointerup', handlePointerUp)
  }

  function startBallDrag(ball: GachaBall, x: number, y: number) {
    if (!canEdit) return
    ballDragRef.current = ball
    if (selectedId !== ball.id) handleSelect(ball.id)
    setDrag({ kind: 'delete', ...ball, x, y, over: false, source: 'ball' })
  }

  function moveBallDrag(x: number, y: number) {
    const ball = ballDragRef.current
    if (!ball) return
    setDrag({ kind: 'delete', ...ball, x, y, over: isOverDeleteZone(x, y), source: 'ball' })
  }

  function endBallDrag(x: number, y: number) {
    const ball = ballDragRef.current
    ballDragRef.current = null
    if (!ball) return
    const over = isOverDeleteZone(x, y)
    setDrag(null)
    if (over) void deleteBall(ball.id)
  }

  function cancelBallDrag() {
    ballDragRef.current = null
    setDrag(null)
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

          <div ref={machineRef} className={drag?.kind === 'create' && drag.over ? 'machine-wrap drop-active' : 'machine-wrap'}>
            <GachaMachine
              stageKey={stageKey}
              balls={balls}
              selectedId={selectedId}
              onSelect={handleSelect}
              canDelete={canEdit}
              draggingId={drag?.kind === 'delete' ? drag.id : null}
              onBallDragStart={startBallDrag}
              onBallDragMove={moveBallDrag}
              onBallDragEnd={endBallDrag}
              onBallDragCancel={cancelBallDrag}
            />
            {drag?.kind === 'create' && drag.over && <div className="drop-hint">松手，投进新的扭蛋</div>}
          </div>

          {canEdit ? (
            <SwatchRail
              onDragStart={startDrag}
              title="点一下，或拖进扭蛋机"
              hint="分值可以随时调整"
            />
          ) : (
            <div className="readonly-strip">
              {isFuture ? '还没到这一天，不能记录。' : `这是 ${machineOwner} 的扭蛋机，只能看，不能改。`}
            </div>
          )}
        </section>

        <aside className="day-side">
          <section className="card record-card" ref={noteCardRef}>
            <div className="record-head">
              <div>
                <span className="record-kicker">
                  {editable ? '我这一天的感受' : `${machineOwner} 的感受`}
                </span>
                <h2>{Number(date.slice(8, 10))} 日</h2>
              </div>
              {selected ? (
                <div className="record-head-right">
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
                  {canEdit && !scoreEditing && (
                    <button
                      type="button"
                      className="ghost-btn small record-edit-score"
                      onClick={() => {
                        setScoreDraft(selected.score)
                        setScoreEditing(true)
                      }}
                    >
                      改
                    </button>
                  )}
                  {selected.adjustedAt && (
                    <span className="record-adjusted-tag">已调过</span>
                  )}
                </div>
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

                {/* 分值编辑器 */}
                {scoreEditing && canEdit && (
                  <div className="score-editor">
                    <div className="score-editor-row">
                      <input
                        type="range"
                        min={0}
                        max={100}
                        value={scoreDraft}
                        onChange={(e) => setScoreDraft(Number(e.target.value))}
                        className="score-slider"
                      />
                      <input
                        type="number"
                        min={0}
                        max={100}
                        value={scoreDraft}
                        onChange={(e) => setScoreDraft(Math.max(0, Math.min(100, Number(e.target.value) || 0)))}
                        className="score-number"
                      />
                    </div>
                    <div className="score-editor-row">
                      <button type="button" className="ghost-btn small" onClick={() => setScoreDraft((v) => Math.max(0, v - 10))}>
                        -10
                      </button>
                      <button type="button" className="ghost-btn small" onClick={() => setScoreDraft((v) => Math.max(0, v - 1))}>
                        -1
                      </button>
                      <button type="button" className="ghost-btn small" onClick={() => setScoreDraft((v) => Math.min(100, v + 1))}>
                        +1
                      </button>
                      <button type="button" className="ghost-btn small" onClick={() => setScoreDraft((v) => Math.min(100, v + 10))}>
                        +10
                      </button>
                      <span className="score-editor-hint">
                        原分值 {selected.originalScore ?? selected.score} → {scoreDraft}
                      </span>
                    </div>
                    <div className="score-editor-row">
                      <button
                        type="button"
                        className="ghost-btn small"
                        onClick={() => {
                          setScoreEditing(false)
                          setScoreDraft(selected.score)
                        }}
                        disabled={scoreSaving}
                      >
                        取消
                      </button>
                      <button
                        type="button"
                        className="primary-btn"
                        onClick={saveScore}
                        disabled={scoreSaving || scoreDraft === selected.score}
                      >
                        {scoreSaving ? '保存中…' : '保存分值'}
                      </button>
                    </div>
                  </div>
                )}

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

                {/* AI 标签（只在看自己的记录时展示，标签是私有的） */}
                {asId == null && (
                <div className="tags-block">
                  <div className="tags-head">
                    <span>AI 洞察</span>
                    {tagsLoading && <span className="tags-loading">加载中…</span>}
                  </div>
                  {!tagsLoading && tags.length === 0 && (
                    <p className="tags-empty">还没有标签。生成单人报告或让 Agent 分析后，这里会出现相关的洞察、建议和模式。</p>
                  )}
                  {!tagsLoading && tags.length > 0 && (
                    <div className="tags-list">
                      {tags.map((t) => (
                        <div key={t.id} className={'tag-pill tag-' + t.tagType}>
                          <span className="tag-pill-label">{labelForTag(t.tagType)}</span>
                          <span className="tag-pill-content">{t.content}</span>
                          {canEdit && t.source === 'agent' && (
                            <button
                              type="button"
                              className="tag-pill-remove"
                              onClick={() => removeTag(t.id)}
                              title="删除这条标签"
                            >
                              ✕
                            </button>
                          )}
                        </div>
                      ))}
                    </div>
                  )}
                </div>
                )}

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
                    ? '这一天还没有扭蛋。挑一个颜色，点一下或拖进扭蛋机。'
                    : `${machineOwner} 这一天还没有记录。`}
                </p>
                {editable && <span className="empty-arrow">↗ 点一下色块，或拖进去</span>}
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
              <li>点一下或拖进扭蛋机，同一天可以投很多颗，月视图取平均。</li>
              <li>新建后会自动打开理由框，补上当时的理由；点开任意一颗也能改理由。</li>
              <li>分值可以随时调整：点击分值旁的「改」即可改；理由随时可写。</li>
              <li>手机长按、电脑按住画布里的扭蛋，拖到下方红区松手即可快速删除。</li>
            </ol>
          </section>
        </aside>
      </div>

      {loading && <div className="loading-hint">正在装填扭蛋机…</div>}
      {toast && <div className="toast">{toast}</div>}
      {drag?.kind === 'delete' && (
        <div ref={deleteZoneRef} className={drag.over ? 'delete-zone over' : 'delete-zone'}>
          <span>松手删除</span>
          <small>
            第 {drag.index} 颗 · {drag.score} 分
          </small>
        </div>
      )}
      {drag && (
        <div
          className={drag.over ? 'drag-ghost over' : 'drag-ghost'}
          style={{ left: drag.x, top: drag.y, background: scoreColor(drag.score) }}
        >
          {drag.kind === 'create' ? drag.score : drag.index}
        </div>
      )}
    </div>
  )
}
