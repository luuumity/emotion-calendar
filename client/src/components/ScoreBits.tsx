import type { PointerEvent } from 'react'
import { SWATCH_SCORES, scoreColor, scoreLabel } from '../lib/colors'

export function ScoreLegend({ compact = false }: { compact?: boolean }) {
  return (
    <div className={compact ? 'score-legend compact' : 'score-legend'}>
      <span>低落</span>
      <span className="legend-track" aria-hidden="true" />
      <span>很好</span>
    </div>
  )
}

export function SwatchRail({
  selectedScore,
  disabled,
  onDragStart,
  title = '拖动色块投进扭蛋机',
  hint = '或直接点一下'
}: {
  selectedScore?: number | null
  disabled?: boolean
  onDragStart: (score: number, event: PointerEvent) => void
  title?: string
  hint?: string
}) {
  return (
    <div className={disabled ? 'swatch-rail disabled' : 'swatch-rail'}>
      <div className="swatch-head">
        <span className="swatch-title">{title}</span>
        <span className="swatch-sub">{hint}</span>
      </div>
      <div className="swatch-row">
        {SWATCH_SCORES.map((score) => {
          const active = selectedScore != null && Math.abs(selectedScore - score) < 9
          return (
            <button
              key={score}
              type="button"
              className={active ? 'swatch active' : 'swatch'}
              style={{ background: scoreColor(score) }}
              onPointerDown={(event) => {
                if (disabled) return
                event.preventDefault()
                onDragStart(score, event)
              }}
              title={`${scoreLabel(score)} · ${score} 分`}
              aria-label={`${scoreLabel(score)}，${score} 分`}
            >
              <span className="swatch-value">{score}</span>
            </button>
          )
        })}
      </div>
      <ScoreLegend compact />
    </div>
  )
}
