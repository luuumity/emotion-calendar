export type RGB = [number, number, number]

const STOPS: Array<{ at: number; rgb: RGB }> = [
  { at: 0, rgb: [208, 66, 66] },
  { at: 20, rgb: [228, 108, 62] },
  { at: 40, rgb: [230, 166, 62] },
  { at: 52, rgb: [214, 192, 78] },
  { at: 64, rgb: [156, 190, 92] },
  { at: 80, rgb: [92, 165, 108] },
  { at: 100, rgb: [46, 138, 92] }
]

function mix(a: RGB, b: RGB, t: number): RGB {
  return [
    Math.round(a[0] + (b[0] - a[0]) * t),
    Math.round(a[1] + (b[1] - a[1]) * t),
    Math.round(a[2] + (b[2] - a[2]) * t)
  ]
}

export function scoreRGB(score: number): RGB {
  const s = Math.max(0, Math.min(100, score))
  for (let i = 0; i < STOPS.length - 1; i += 1) {
    const left = STOPS[i]
    const right = STOPS[i + 1]
    if (s >= left.at && s <= right.at) {
      const t = (s - left.at) / (right.at - left.at || 1)
      return mix(left.rgb, right.rgb, t)
    }
  }
  return STOPS[STOPS.length - 1].rgb
}

export function scoreColor(score: number): string {
  const [r, g, b] = scoreRGB(score)
  return `rgb(${r}, ${g}, ${b})`
}

export function scoreSoftColor(score: number, alpha = 0.18): string {
  const [r, g, b] = scoreRGB(score)
  return `rgba(${r}, ${g}, ${b}, ${alpha})`
}

export function isDark(score: number): boolean {
  const [r, g, b] = scoreRGB(score)
  const luminance = (0.299 * r + 0.587 * g + 0.114 * b) / 255
  return luminance < 0.62
}

export function scoreLabel(score: number): string {
  if (score <= 15) return '很糟'
  if (score <= 32) return '有点低落'
  if (score <= 48) return '偏凉'
  if (score <= 58) return '一般'
  if (score <= 72) return '还不错'
  if (score <= 87) return '挺开心'
  return '很幸福'
}

export const SWATCH_SCORES = [0, 18, 34, 50, 66, 82, 100]
