const WEEKDAYS = ['一', '二', '三', '四', '五', '六', '日']

export function pad2(n: number): string {
  return String(n).padStart(2, '0')
}

export function toDayString(date: Date): string {
  return `${date.getFullYear()}-${pad2(date.getMonth() + 1)}-${pad2(date.getDate())}`
}

export function todayString(): string {
  return toDayString(new Date())
}

export function parseDay(day: string): Date {
  const [y, m, d] = day.split('-').map(Number)
  return new Date(y, (m || 1) - 1, d || 1, 12, 0, 0)
}

export function monthMeta(year: number, month: number) {
  const first = new Date(year, month, 1, 12)
  const daysInMonth = new Date(year, month + 1, 0).getDate()
  const offset = (first.getDay() + 6) % 7 // 周一为一周开始
  const from = `${year}-${pad2(month + 1)}-01`
  const to = `${year}-${pad2(month + 1)}-${pad2(daysInMonth)}`
  return { year, month, daysInMonth, offset, from, to, label: `${year} 年 ${month + 1} 月` }
}

export function shiftMonth(year: number, month: number, delta: number) {
  const d = new Date(year, month + delta, 1)
  return { year: d.getFullYear(), month: d.getMonth() }
}

export function dayOfMonth(day: string): number {
  return Number(day.slice(8, 10))
}

export function weekdayShort(day: string): string {
  const d = parseDay(day)
  return `周${WEEKDAYS[(d.getDay() + 6) % 7]}`
}

export function formatDay(day: string): string {
  const d = parseDay(day)
  return `${d.getMonth() + 1} 月 ${d.getDate()} 日`
}

export function formatDateLong(day: string): string {
  return `${formatDay(day)} · ${weekdayShort(day)}`
}

export function daysBetween(a: string, b: string): number {
  const diff = parseDay(b).getTime() - parseDay(a).getTime()
  return Math.round(diff / 86400000)
}

export { WEEKDAYS }
