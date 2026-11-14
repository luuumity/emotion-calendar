import { useEffect, useMemo, useRef, useState } from 'react'
import { Link, useNavigate, useSearchParams } from 'react-router-dom'
import { api, type Granted, type RecordItem } from '../lib/api'
import { averageScore, computeCompat, dailyAverages, type DayAverage } from '../lib/compat'
import { scoreColor, scoreSoftColor } from '../lib/colors'
import { dayOfMonth, monthMeta, shiftMonth, todayString } from '../lib/date'
import { ScoreLegend } from '../components/ScoreBits'
import { errorMessage } from '../context/AuthContext'

function MonthChart({ mine, theirs, daysInMonth }: { mine: DayAverage[]; theirs: DayAverage[]; daysInMonth: number }) {
  const width = 300
  const height = 118
  const x = (day: string) => 10 + ((dayOfMonth(day) - 1) / Math.max(1, daysInMonth - 1)) * (width - 20)
  const y = (score: number) => 105 - (score / 100) * 92

  const line = (records: DayAverage[]) =>
    records
      .slice()
      .sort((a, b) => a.day.localeCompare(b.day))
      .map((r) => `${x(r.day).toFixed(1)},${y(r.score).toFixed(1)}`)
      .join(' ')

  return (
    <svg className="trend-chart" viewBox={`0 0 ${width} ${height}`} role="img" aria-label="本月情绪曲线">
      {[25, 50, 75].map((tick) => (
        <line key={tick} x1="10" x2={width - 10} y1={y(tick)} y2={y(tick)} className="chart-grid" />
      ))}
      {mine.length > 1 && <polyline points={line(mine)} className="chart-line mine" />}
      {theirs.length > 1 && <polyline points={line(theirs)} className="chart-line theirs" />}
      {mine.map((r) => (
        <circle key={`m-${r.day}`} cx={x(r.day)} cy={y(r.score)} r="2.6" fill="#2f2a25" />
      ))}
      {theirs.map((r) => (
        <circle key={`t-${r.day}`} cx={x(r.day)} cy={y(r.score)} r="2.6" fill="#b06a4f" />
      ))}
    </svg>
  )
}

function StatCard({
  label,
  value,
  unit,
  hint,
  tone
}: {
  label: string
  value: string | number
  unit?: string
  hint?: string
  tone?: 'coral' | 'sage' | 'ink'
}) {
  return (
    <div className={`stat-card tone-${tone || 'ink'}`}>
      <span className="stat-label">{label}</span>
      <span className="stat-value">
        {value}
        {unit && <small>{unit}</small>}
      </span>
      {hint && <span className="stat-hint">{hint}</span>}
    </div>
  )
}

export function MonthPage() {
  const navigate = useNavigate()
  const [searchParams] = useSearchParams()
  const [cursor, setCursor] = useState(() => {
    const now = new Date()
    return { year: now.getFullYear(), month: now.getMonth() }
  })
  const meta = useMemo(() => monthMeta(cursor.year, cursor.month), [cursor])
  const [granted, setGranted] = useState<Granted[]>([])
  const [compareId, setCompareId] = useState<number | null>(null)
  const [myRecords, setMyRecords] = useState<RecordItem[]>([])
  const [theirRecords, setTheirRecords] = useState<RecordItem[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState('')
  const initialized = useRef(false)
  const today = todayString()

  useEffect(() => {
    let alive = true
    api
      .access()
      .then((info) => {
        if (!alive) return
        setGranted(info.granted)
        if (!initialized.current) {
          initialized.current = true
          const wanted = Number(searchParams.get('person'))
          const target = info.granted.find((g) => g.id === wanted)
          if (target) setCompareId(target.id)
          else if (info.granted.length > 0) setCompareId(info.granted[0].id)
        }
      })
      .catch(() => {})
    return () => {
      alive = false
    }
  }, [])

  useEffect(() => {
    let alive = true
    setLoading(true)
    api
      .listRecords(meta.from, meta.to)
      .then((res) => {
        if (alive) {
          setMyRecords(res.records)
          setError('')
        }
      })
      .catch((err) => {
        if (alive) setError(errorMessage(err))
      })
      .finally(() => {
        if (alive) setLoading(false)
      })
    return () => {
      alive = false
    }
  }, [meta.from, meta.to])

  useEffect(() => {
    if (compareId == null) {
      setTheirRecords([])
      return
    }
    let alive = true
    api
      .personRecords(compareId, meta.from, meta.to)
      .then((res) => {
        if (alive) setTheirRecords(res.records)
      })
      .catch(() => {
        if (!alive) return
        setTheirRecords([])
        setCompareId(null)
      })
    return () => {
      alive = false
    }
  }, [compareId, meta.from, meta.to])

  const myDaily = useMemo(() => dailyAverages(myRecords), [myRecords])
  const theirDaily = useMemo(() => dailyAverages(theirRecords), [theirRecords])
  const myMap = useMemo(() => new Map(myDaily.map((r) => [r.day, r])), [myDaily])
  const theirMap = useMemo(() => new Map(theirDaily.map((r) => [r.day, r])), [theirDaily])
  const comparePerson = granted.find((g) => g.id === compareId) || null
  const compat = useMemo(() => computeCompat(myRecords, theirRecords), [myRecords, theirRecords])
  const myAvg = averageScore(myRecords)
  const theirAvg = averageScore(theirRecords)

  const visibleDays = meta.daysInMonth
  const cells: Array<{ day: string; num: number } | null> = [
    ...Array.from({ length: meta.offset }, () => null),
    ...Array.from({ length: visibleDays }, (_, i) => ({
      day: `${cursor.year}-${String(cursor.month + 1).padStart(2, '0')}-${String(i + 1).padStart(2, '0')}`,
      num: i + 1
    }))
  ]

  const goMonth = (delta: number) => setCursor(shiftMonth(cursor.year, cursor.month, delta))
  const goToday = () => {
    const now = new Date()
    setCursor({ year: now.getFullYear(), month: now.getMonth() })
  }

  const currentMonthStart = `${new Date().getFullYear()}-${String(new Date().getMonth() + 1).padStart(2, '0')}-01`
  const isViewingCurrent = meta.from === currentMonthStart

  return (
    <div className="page month-page">
      <section className="page-head">
        <div>
          <h1>月视图</h1>
          <p className="sub">每个日期是当天所有扭蛋的平均色。深红是难受，深绿是舒服，中间是平平常常的一天。</p>
        </div>
        <div className="month-nav">
          <button type="button" className="icon-btn" onClick={() => goMonth(-1)} aria-label="上个月">
            ‹
          </button>
          <span className="month-label">{meta.label}</span>
          <button type="button" className="icon-btn" onClick={() => goMonth(1)} aria-label="下个月">
            ›
          </button>
          {!isViewingCurrent && (
            <button type="button" className="ghost-btn" onClick={goToday}>
              回到本月
            </button>
          )}
        </div>
      </section>

      {granted.length > 0 && (
        <div className="person-switch">
          <span className="switch-label">对照</span>
          <button
            type="button"
            className={compareId == null ? 'chip active' : 'chip'}
            onClick={() => setCompareId(null)}
          >
            只看自己
          </button>
          {granted.map((person) => (
            <button
              key={person.id}
              type="button"
              className={compareId === person.id ? 'chip active' : 'chip'}
              onClick={() => setCompareId(person.id)}
            >
              {person.displayName}
              <span className="chip-scope">{person.scope === 'full' ? '含理由' : '仅颜色'}</span>
            </button>
          ))}
        </div>
      )}

      <section className="stats-row">
        <StatCard
          label="我的平均"
          value={myAvg ?? '—'}
          hint={myDaily.length ? `${myDaily.length} 天有记录` : '这个月还没记录'}
          tone="ink"
        />
        {comparePerson && (
          <StatCard
            label={`${comparePerson.displayName} 的平均`}
            value={theirAvg ?? '—'}
            hint={theirDaily.length ? `${theirDaily.length} 天有记录` : '对方这个月还没记录'}
            tone="ink"
          />
        )}
        <StatCard
          label="同感指数"
          value={comparePerson && compat.alignment != null ? compat.alignment : '—'}
          hint={comparePerson ? compat.descriptor : '授权后可见'}
          tone="coral"
        />
        <StatCard
          label="共同记录"
          value={comparePerson ? compat.commonDays : '—'}
          unit={comparePerson ? '天' : undefined}
          hint={
            comparePerson
              ? compat.commonDays === 0
                ? '还没有共同记录'
                : compat.commonDays >= 3
                  ? '样本足够参考'
                  : '样本还偏少'
              : '需要对方授权'
          }
          tone="sage"
        />
      </section>

      {error && <div className="banner error">{error}</div>}

      <div className="month-layout">
        <section className="card calendar-card">
          <div className="calendar-top">
            <div className="weekdays">
              {['一', '二', '三', '四', '五', '六', '日'].map((w) => (
                <span key={w}>周{w}</span>
              ))}
            </div>
            <ScoreLegend compact />
          </div>

          <div className={comparePerson ? 'calendar-grid dual' : 'calendar-grid'}>
            {cells.map((cell, index) => {
              if (!cell) return <span className="day-cell empty" key={`empty-${index}`} />
              const mine = myMap.get(cell.day)
              const theirs = theirMap.get(cell.day)
              const future = cell.day > today
              const isToday = cell.day === today

              return (
                <button
                  key={cell.day}
                  type="button"
                  className={`day-cell${future ? ' future' : ''}${isToday ? ' today' : ''}`}
                  disabled={future}
                  onClick={() => navigate(`/day/${cell.day}`)}
                  title={
                    future
                      ? '还没到这一天'
                      : `${cell.day}${mine ? ` · 我 ${Math.round(mine.score)}（${mine.count} 颗）` : ''}${
                          theirs ? ` · TA ${Math.round(theirs.score)}（${theirs.count} 颗）` : ''
                        }`
                  }
                >
                  <span className="cell-top">
                    <span className="cell-num">{cell.num}</span>
                    {mine && <span className="cell-score">{Math.round(mine.score)}</span>}
                  </span>
                  <span className="cell-bars">
                    <span
                      className={mine ? 'bar filled' : 'bar'}
                      style={
                        mine
                          ? { background: scoreColor(mine.score) }
                          : { background: scoreSoftColor(50, 0.08) }
                      }
                    />
                    {comparePerson && (
                      <span
                        className={theirs ? 'bar filled partner' : 'bar partner'}
                        style={
                          theirs
                            ? { background: scoreColor(theirs.score) }
                            : { background: scoreSoftColor(50, 0.08) }
                        }
                      />
                    )}
                  </span>
                </button>
              )
            })}
          </div>

          <div className="calendar-legend">
            <span className="legend-item">
              <i className="swatch-dot mine" />
              我
            </span>
            {comparePerson && (
              <span className="legend-item">
                <i className="swatch-dot partner" />
                {comparePerson.displayName}
              </span>
            )}
            <span className="legend-tip">点击任意日期进入当天的扭蛋机</span>
          </div>
        </section>

        <aside className="month-side">
          <section className="card compat-card">
            <div className="card-head">
              <h2>同感速览</h2>
              {comparePerson && <span className="pill">{comparePerson.displayName}</span>}
            </div>

            {comparePerson ? (
              <>
                <div className="compat-main">
                  <div
                    className="score-ring"
                    style={{
                      background: `conic-gradient(#f2705f ${compat.alignment ?? 0}%, rgba(47,42,37,0.08) 0)`
                    }}
                  >
                    <div className="score-ring-inner">
                      <strong>{compat.alignment ?? '—'}</strong>
                      <span>同感指数</span>
                    </div>
                  </div>
                  <div className="compat-copy">
                    <strong className="compat-descriptor">{compat.descriptor}</strong>
                    <p>{compat.hint}</p>
                    {compat.trend && (
                      <span className={`trend trend-${compat.trend}`}>
                        {compat.trend === 'up' ? '↑ 比之前更同感' : compat.trend === 'down' ? '↓ 最近温差在变大' : '→ 和之前差不多'}
                      </span>
                    )}
                  </div>
                </div>
                <div className="compat-foot">
                  <span>同感指数 = 100 − 当天两人感受的平均差值</span>
                </div>
              </>
            ) : (
              <div className="compat-empty">
                <p>拿到对方的授权凭证后，这里会显示你们的同感指数。</p>
                <Link to="/access" className="primary-btn inline">
                  去授权管理
                </Link>
              </div>
            )}
          </section>

          <section className="card trend-card">
            <div className="card-head">
              <h2>本月曲线</h2>
              <span className="mini-legend">
                <i className="chart-dot mine" />我
                {comparePerson && (
                  <>
                    <i className="chart-dot theirs" />
                    TA
                  </>
                )}
              </span>
            </div>
            <MonthChart mine={myDaily} theirs={comparePerson ? theirDaily : []} daysInMonth={meta.daysInMonth} />
            <div className="chart-axis">
              <span>1 日</span>
              <span>{meta.daysInMonth} 日</span>
            </div>
          </section>

          <Link to={`/day/${today}`} className="today-card">
            <span className="today-kicker">今天</span>
            <strong>把今天的感受投进扭蛋机</strong>
            <span className="today-arrow">→</span>
          </Link>
        </aside>
      </div>

      {loading && myRecords.length === 0 && <div className="loading-hint">正在翻开这个月的记录…</div>}
    </div>
  )
}
