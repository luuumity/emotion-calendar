import { useEffect, useMemo, useState } from 'react'
import { api, type Insight, type AccessInfo, type Granted, type ColdStartInfo } from '../lib/api'
import { Markdown } from '../components/Markdown'

type Tab = 'single' | 'couple'
type PeriodType = 'week' | 'month' | 'manual'

function pad2(n: number) {
  return String(n).padStart(2, '0')
}

function localDay(d = new Date()) {
  return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-${pad2(d.getDate())}`
}

function formatPeriod(insight: Insight) {
  return `${insight.periodStart} ~ ${insight.periodEnd}`
}

function formatTime(iso: string) {
  const d = new Date(iso)
  return d.toLocaleString('zh-CN', {
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit'
  })
}

function summarize(text: string, n = 200) {
  if (!text) return ''
  const t = text.replace(/\s+/g, ' ').trim()
  return t.length > n ? t.slice(0, n) + '…' : t
}

/**
 * 从 access 信息里找出和我有"互惠 full 档"授权的对象
 * 返回 [{ partnerId, partnerName }]
 */
function findReciprocalFull(access: AccessInfo): { partnerId: number; partnerName: string }[] {
  // granted: 对方给我的授权（owner_id = 对方）
  const grantedFull = new Map<number, Granted>()
  for (const g of access.granted) {
    if (g.scope === 'full') grantedFull.set(g.id, g)
  }

  // mine: 我创建的 share → viewers 里我给了谁
  const result: { partnerId: number; partnerName: string }[] = []
  const seen = new Set<number>()
  for (const share of access.mine) {
    for (const v of share.viewers) {
      if (v.scope === 'full' && grantedFull.has(v.id) && !seen.has(v.id)) {
        seen.add(v.id)
        result.push({ partnerId: v.id, partnerName: v.displayName })
      }
    }
  }
  return result
}

/** 所有我给过 full 授权的人（不管对方有没有回给我） */
function findMyFullViewers(access: AccessInfo) {
  const map = new Map<number, string>()
  for (const share of access.mine) {
    for (const v of share.viewers) {
      if (v.scope === 'full') map.set(v.id, v.displayName)
    }
  }
  return map
}

/** 所有给过我 full 授权的人（不管我有没有回给对方） */
function findGrantedFullOwners(access: AccessInfo) {
  const map = new Map<number, string>()
  for (const g of access.granted) {
    if (g.scope === 'full') map.set(g.id, g.displayName)
  }
  return map
}

export function InsightsPage() {
  const [tab, setTab] = useState<Tab>('single')
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [insights, setInsights] = useState<Insight[]>([])
  const [access, setAccess] = useState<AccessInfo | null>(null)
  const [coldStart, setColdStart] = useState<ColdStartInfo | null>(null)
  const [expandedId, setExpandedId] = useState<number | null>(null)
  const [deleting, setDeleting] = useState(false)
  const [coldStartConfirm, setColdStartConfirm] = useState(false)
  const [autoInfo, setAutoInfo] = useState<{ enabled: boolean; asked: boolean } | null>(null)
  const [autoBusy, setAutoBusy] = useState(false)

  const [generating, setGenerating] = useState(false)
  const [generateErr, setGenerateErr] = useState<string | null>(null)
  const [generateSuccess, setGenerateSuccess] = useState<string | null>(null)
  const [periodType, setPeriodType] = useState<PeriodType>('week')
  const [customStart, setCustomStart] = useState(() => {
    const d = new Date()
    return `${d.getFullYear()}-${pad2(d.getMonth() + 1)}-01`
  })
  const [customEnd, setCustomEnd] = useState(() => localDay())

  async function load() {
    setLoading(true)
    setError(null)
    try {
      const [ins, acc, auto] = await Promise.all([api.insights(), api.access(), api.insightAuto()])
      setInsights(ins.insights)
      setColdStart(ins.coldStart)
      setAccess(acc)
      setAutoInfo(auto)
    } catch (e) {
      setError(e instanceof Error ? e.message : '加载失败')
    } finally {
      setLoading(false)
    }
  }

  useEffect(() => {
    load()
  }, [])

  const singleList = useMemo(() => insights.filter((i) => i.scope === 'single'), [insights])
  const coupleList = useMemo(() => insights.filter((i) => i.scope === 'couple'), [insights])

  const reciprocal = useMemo(() => (access ? findReciprocalFull(access) : []), [access])
  const myFull = useMemo(() => (access ? findMyFullViewers(access) : new Map()), [access])
  const grantedFull = useMemo(() => (access ? findGrantedFullOwners(access) : new Map()), [access])

  async function runGenerateSingle(body: { periodType: PeriodType; start?: string; end?: string }) {
    setGenerating(true)
    setGenerateErr(null)
    setGenerateSuccess(null)
    try {
      const res = await api.generateSingleInsight(body)
      setGenerateSuccess(
        res.existing
          ? '该周期的报告已存在，已为你展开'
          : res.coldStart
            ? '首份全量报告已生成'
            : res.hasKey
              ? '报告已生成'
              : 'AI 服务未配置，返回了占位内容'
      )
      await load()
      // 自动展开新生成的
      setExpandedId(res.insight.id)
    } catch (e) {
      setGenerateErr(e instanceof Error ? e.message : '生成失败')
    } finally {
      setGenerating(false)
    }
  }

  function handleGenerateSingle() {
    setGenerateErr(null)
    setGenerateSuccess(null)

    if (loading || deleting || coldStart === null) {
      setGenerateErr('正在刷新报告状态，请稍候再试')
      return
    }
    if (coldStart.needed) {
      setColdStartConfirm(true)
      return
    }
    if (!coldStart.hasRecords) {
      setGenerateErr('还没有任何记录，先记录几天再来生成报告')
      return
    }
    if (periodType === 'manual') {
      if (!customStart || !customEnd) {
        setGenerateErr('请选择起始和结束日期')
        return
      }
      if (customStart > customEnd) {
        setGenerateErr('起始日期不能晚于结束日期')
        return
      }
    }

    const body: { periodType: PeriodType; start?: string; end?: string } = { periodType }
    if (periodType === 'manual') {
      body.start = customStart
      body.end = customEnd
    }
    void runGenerateSingle(body)
  }

  function confirmColdStart() {
    if (!coldStart?.start || !coldStart.end) return
    setColdStartConfirm(false)
    void runGenerateSingle({
      periodType: 'manual',
      start: coldStart.start,
      end: coldStart.end
    })
  }

  async function answerAuto(enabled: boolean) {
    setAutoBusy(true)
    try {
      const res = await api.setInsightAuto(enabled)
      setAutoInfo({ enabled: res.enabled, asked: res.asked })
    } catch (e) {
      setError(e instanceof Error ? e.message : '设置失败')
    } finally {
      setAutoBusy(false)
    }
  }

  async function handleDelete(insight: Insight) {
    setDeleting(true)
    try {
      await api.deleteInsight(insight.id)
      if (expandedId === insight.id) setExpandedId(null)
      await load()
    } finally {
      setDeleting(false)
    }
  }

  async function handleGenerateCouple(partnerId: number) {
    setGenerating(true)
    setGenerateErr(null)
    setGenerateSuccess(null)
    try {
      const res = await api.generateCoupleInsight(partnerId)
      setGenerateSuccess(res.hasKey ? '双人报告已生成' : 'AI 服务未配置，返回了占位内容')
      await load()
      setExpandedId(res.insight.id)
    } catch (e) {
      setGenerateErr(e instanceof Error ? e.message : '生成失败')
    } finally {
      setGenerating(false)
    }
  }

  return (
    <div className="page insights-page">
      <div className="page-head">
        <div>
          <h1>AI 分析</h1>
          <p className="sub">把你的情绪日记交给 Persona Agent，让它用你的 fact、标签和过往记录，写出一份有温度的报告。</p>
        </div>
      </div>

      {autoInfo && !autoInfo.asked && (
        <div className="insight-auto-ask">
          <div>
            <strong>开启每周自动报告？</strong>
            <p>每周一 03:00 后，自动为上一完整周生成一份单人报告；该周少于 3 条记录时跳过。</p>
          </div>
          <div className="insight-auto-actions">
            <button type="button" className="primary-btn small" disabled={autoBusy} onClick={() => answerAuto(true)}>
              开启
            </button>
            <button type="button" className="ghost-btn small" disabled={autoBusy} onClick={() => answerAuto(false)}>
              暂不
            </button>
          </div>
        </div>
      )}

      <div className="insights-tabs">
        <button
          type="button"
          className={'insights-tab ' + (tab === 'single' ? 'active' : '')}
          onClick={() => setTab('single')}
        >
          单人分析
          <span className="insights-tab-count">{singleList.length}</span>
        </button>
        <button
          type="button"
          className={'insights-tab ' + (tab === 'couple' ? 'active' : '')}
          onClick={() => setTab('couple')}
        >
          双人分析
          <span className="insights-tab-count">{coupleList.length}</span>
        </button>
      </div>

      {error && <div className="banner error">{error}</div>}

      {tab === 'single' && (
        <section className="insights-section">
          <div className="insights-actions">
            <div className="insights-actions-main">
              {coldStart?.needed ? (
                <p className="insights-actions-hint">
                  你现在还没有任何单人报告。这是你的第一份报告，会基于从 {coldStart.start} 到 {coldStart.end} 的全部{' '}
                  {coldStart.recordCount} 条记录生成全量分析。生成之后就可以按本周 / 本月 / 自定义继续。
                </p>
              ) : (
                <>
                  <div className="insights-period-tabs">
                    {(
                      [
                        ['week', '本周'],
                        ['month', '本月'],
                        ['manual', '自定义']
                      ] as const
                    ).map(([value, label]) => (
                      <button
                        key={value}
                        type="button"
                        className={'insights-period-tab ' + (periodType === value ? 'active' : '')}
                        onClick={() => setPeriodType(value)}
                      >
                        {label}
                      </button>
                    ))}
                  </div>

                  {periodType === 'manual' && (
                    <div className="insights-custom-range">
                      <input
                        type="date"
                        value={customStart}
                        max={customEnd || undefined}
                        onChange={(e) => setCustomStart(e.target.value)}
                        aria-label="起始日期"
                      />
                      <span>至</span>
                      <input
                        type="date"
                        value={customEnd}
                        min={customStart || undefined}
                        onChange={(e) => setCustomEnd(e.target.value)}
                        aria-label="结束日期"
                      />
                    </div>
                  )}

                  <p className="insights-actions-hint">
                    {periodType === 'week'
                      ? '基于本周（周一～周日）的情绪记录生成一份分析。'
                      : periodType === 'month'
                        ? '基于本月（1 号～月末）的情绪记录生成一份分析。'
                        : '选择一段日期，基于这段时间内的情绪记录生成分析。'}
                  </p>
                </>
              )}
            </div>
            <button
              type="button"
              className="primary-btn"
              onClick={handleGenerateSingle}
              disabled={generating || loading || deleting || (coldStart !== null && !coldStart.hasRecords)}
            >
              {generating
                ? '生成中…'
                : coldStart?.needed
                  ? '生成首份全量报告'
                  : periodType === 'week'
                    ? '生成本周报告'
                    : periodType === 'month'
                      ? '生成本月报告'
                      : '生成自定义报告'}
            </button>
          </div>

          {coldStartConfirm && coldStart?.needed && (
            <div className="banner info insights-coldstart-confirm">
              <div>
                首份报告会覆盖 {coldStart.start} ~ {coldStart.end} 的全部 {coldStart.recordCount} 条记录，
                生成后建议再按本周 / 本月继续。
              </div>
              <div className="insights-coldstart-actions">
                <button type="button" className="primary-btn" onClick={confirmColdStart} disabled={generating}>
                  {generating ? '生成中…' : '确认生成'}
                </button>
                <button
                  type="button"
                  className="ghost-btn"
                  onClick={() => setColdStartConfirm(false)}
                  disabled={generating}
                >
                  取消
                </button>
              </div>
            </div>
          )}

          {generateErr && <div className="banner error">{generateErr}</div>}
          {generateSuccess && <div className="banner success">{generateSuccess}</div>}

          {loading ? (
            <p className="loading-hint">正在加载…</p>
          ) : singleList.length === 0 ? (
            <div className="insights-empty card">
              <h3>还没有单人报告</h3>
              <p>
                {coldStart && !coldStart.hasRecords
                  ? '还没有任何记录，先投几颗情绪扭蛋，再来生成第一份分析吧。'
                  : coldStart?.needed
                    ? '第一份报告会从你最早的记录一路分析到现在，生成后就能按周 / 按月继续了。'
                    : '记录了几天情绪之后，就可以点上面的按钮生成第一份分析啦。'}
              </p>
            </div>
          ) : (
            <div className="insight-list">
              {singleList.map((ins) => (
                <InsightCard
                  key={ins.id}
                  insight={ins}
                  expanded={expandedId === ins.id}
                  onToggle={() => setExpandedId((prev) => (prev === ins.id ? null : ins.id))}
                  onDelete={() => handleDelete(ins)}
                />
              ))}
            </div>
          )}
        </section>
      )}

      {tab === 'couple' && (
        <section className="insights-section">
          {/* 互惠 full 的对象 */}
          {reciprocal.length === 0 ? (
            <div className="banner info">
              需要双方都给对方 <strong>full 档</strong> 授权才能生成双人报告。
              <br />
              （目前你给过 full 的：{myFull.size || 0} 人；给过你 full 的：{grantedFull.size || 0} 人）
            </div>
          ) : (
            <div className="couple-generate-row">
              {reciprocal.map(({ partnerId, partnerName }) => (
                <div key={partnerId} className="couple-generate-card card">
                  <div className="couple-generate-head">
                    <div>
                      <span className="tag full">已互惠 full 档</span>
                      <h3>与 {partnerName}</h3>
                      <p className="couple-generate-hint">报告基于双方的增量记录，下次生成自动跳过已覆盖的周期。</p>
                    </div>
                    <button
                      type="button"
                      className="primary-btn"
                      onClick={() => handleGenerateCouple(partnerId)}
                      disabled={generating}
                    >
                      {generating ? '生成中…' : '生成双人报告'}
                    </button>
                  </div>
                </div>
              ))}
            </div>
          )}

          {generateErr && <div className="banner error">{generateErr}</div>}
          {generateSuccess && <div className="banner success">{generateSuccess}</div>}

          {loading ? (
            <p className="loading-hint">正在加载…</p>
          ) : coupleList.length === 0 ? (
            <div className="insights-empty card">
              <h3>还没有双人报告</h3>
              <p>互相 full 授权之后，就可以一起看看 AI 怎么说你们的情绪节奏啦。</p>
            </div>
          ) : (
            <div className="insight-list">
              {coupleList.map((ins) => (
                <InsightCard
                  key={ins.id}
                  insight={ins}
                  expanded={expandedId === ins.id}
                  onToggle={() => setExpandedId((prev) => (prev === ins.id ? null : ins.id))}
                  onDelete={() => handleDelete(ins)}
                />
              ))}
            </div>
          )}
        </section>
      )}
    </div>
  )
}

function InsightCard({
  insight,
  expanded,
  onToggle,
  onDelete
}: {
  insight: Insight
  expanded: boolean
  onToggle: () => void
  onDelete: () => Promise<void>
}) {
  const [confirming, setConfirming] = useState(false)
  const [deleting, setDeleting] = useState(false)
  const [deleteErr, setDeleteErr] = useState<string | null>(null)

  useEffect(() => {
    if (!expanded) {
      setConfirming(false)
      setDeleteErr(null)
    }
  }, [expanded])

  async function handleDelete() {
    setDeleting(true)
    setDeleteErr(null)
    try {
      await onDelete()
    } catch (e) {
      setDeleteErr(e instanceof Error ? e.message : '删除失败')
      setDeleting(false)
    }
  }

  return (
    <article className={'insight-card card ' + (expanded ? 'expanded' : '')}>
      <header className="insight-card-head" onClick={onToggle} role="button" tabIndex={0}
        onKeyDown={(e) => (e.key === 'Enter' || e.key === ' ') && onToggle()}
      >
        <div className="insight-card-head-main">
          <span className={'tag ' + (insight.scope === 'couple' ? 'full' : '')}>
            {insight.scope === 'couple' ? '双人' : '单人'}
          </span>
          <h3>{formatPeriod(insight)}</h3>
          <p className="insight-card-meta">
            {formatTime(insight.generatedAt)}
            {insight.tokens ? ` · ${insight.tokens} tokens` : ''}
          </p>
        </div>
        <span className="insight-chevron">{expanded ? '▲' : '▼'}</span>
      </header>

      {expanded ? (
        <div className="insight-content">
          <Markdown className="markdown-report" content={insight.content} />

          <div className="insight-delete-row">
            {confirming ? (
              <>
                <span className="insight-delete-warn">
                  {insight.scope === 'couple' ? '删除后你和对方都将无法查看，' : ''}
                  确认删除这份报告？
                </span>
                <button
                  type="button"
                  className="ghost-btn small danger"
                  onClick={handleDelete}
                  disabled={deleting}
                >
                  {deleting ? '删除中…' : '确认删除'}
                </button>
                <button
                  type="button"
                  className="ghost-btn small"
                  onClick={() => setConfirming(false)}
                  disabled={deleting}
                >
                  取消
                </button>
              </>
            ) : (
              <button
                type="button"
                className="ghost-btn small danger"
                onClick={() => setConfirming(true)}
              >
                删除这份报告
              </button>
            )}
          </div>
          {deleteErr && <p className="insight-delete-error">{deleteErr}</p>}
        </div>
      ) : (
        <p className="insight-summary">{summarize(insight.content, 220)}</p>
      )}
    </article>
  )
}
