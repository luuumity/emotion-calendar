// 只读查看工具轨迹日志。
// 用法：
//   node scripts/trace-log.mjs <sessionId>               最近 3 轮
//   node scripts/trace-log.mjs <sessionId> <turnId>      指定一轮
//   node scripts/trace-log.mjs <sessionId> --recent 6    最近 6 轮
//   DB_PATH=/path/to/emotion.db node scripts/trace-log.mjs 15

import { buildTurnLog, buildRecentTurnLogs, renderTurnLog, renderRecentLogs } from '../src/lib/trace-log.js'

const args = process.argv.slice(2)
const sessionId = Number(args[0])

if (!Number.isInteger(sessionId) || sessionId <= 0) {
  console.error('用法: node scripts/trace-log.mjs <sessionId> [turnId | --recent N]')
  process.exit(1)
}

if (args[1] === '--recent') {
  const limit = Number(args[2] ?? 3)
  const logs = buildRecentTurnLogs(sessionId, Number.isInteger(limit) && limit > 0 ? limit : 3)
  console.log(renderRecentLogs(logs, { includeTurnId: true }))
} else if (args[1] !== undefined) {
  const turnId = Number(args[1])
  if (!Number.isInteger(turnId) || turnId <= 0) {
    console.error('turnId 需要是正整数')
    process.exit(1)
  }
  const log = buildTurnLog(sessionId, turnId)
  console.log(`【查询记录 · turn ${turnId}】`)
  console.log(renderTurnLog(log))
} else {
  const logs = buildRecentTurnLogs(sessionId, 3)
  console.log(renderRecentLogs(logs, { includeTurnId: true }))
}
