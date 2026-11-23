// 通用工具循环：对话与报告共用。
// 对话：15 步、全部工具、落工具轨迹。
// 报告：6 步、只开放白名单工具、不落轨迹（没有 turnId）。

import { db } from '../db.js'
import { callDeepSeek } from './llm.js'
import { executeTool } from './tools.js'

const DEFAULT_MAX_STEPS = 15
const DEFAULT_FINAL_HINT =
  '工具调用额度已用完。不要再调用或输出任何工具调用格式，直接根据已经拿到的信息回答；信息不完整就说明哪部分没查到。'

export function mergeUsage(total, usage) {
  if (!usage) return total
  return {
    prompt_tokens: (total.prompt_tokens || 0) + (usage.prompt_tokens || 0),
    completion_tokens: (total.completion_tokens || 0) + (usage.completion_tokens || 0),
    total_tokens: (total.total_tokens || 0) + (usage.total_tokens || 0),
    prompt_cache_hit_tokens: (total.prompt_cache_hit_tokens || 0) + (usage.prompt_cache_hit_tokens || 0),
    prompt_cache_miss_tokens: (total.prompt_cache_miss_tokens || 0) + (usage.prompt_cache_miss_tokens || 0)
  }
}

export function classifyToolOutput(output) {
  try {
    const data = JSON.parse(output)
    if (data && data.ok === false) {
      if (data.reason === 'duplicate_call') return { status: 'duplicate', error: data.hint || data.reason }
      if (data.reason === 'result_too_large') return { status: 'too_large', error: data.hint || data.reason }
      return { status: 'error', error: data.hint || data.reason || 'tool_error' }
    }
  } catch {
    // 非 JSON 输出按成功处理
  }
  return { status: 'ok' }
}

/**
 * 记录完整工具调用轨迹。只写库，不影响本轮消息或后续历史。
 * 落库失败不阻断对话，避免审计表问题影响主流程。
 */
export function recordTraceEvent(ctx, seq, type, payload) {
  if (!ctx.turnId) return
  try {
    db.prepare(
      `INSERT INTO chat_trace_events (session_id, user_id, turn_id, seq, type, payload, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).run(ctx.sessionId, ctx.userId, ctx.turnId, seq, type, JSON.stringify(payload), new Date().toISOString())
  } catch (err) {
    console.error('[chat] 工具轨迹落库失败:', err.message)
  }
}

/**
 * 工具循环：模型按需调用工具，相同参数的重复调用直接拒绝，避免原地打转。
 *
 * @param {Array} baseMessages
 * @param {object} ctx { userId, sessionId?, turnId? }
 * @param {object} [options]
 * @param {Array} [options.functions] 客户端 function calling 工具声明
 * @param {number} [options.maxSteps] 工具步数上限，用尽后强制收尾一次
 * @param {number} [options.timeoutMs] 整轮截止时间；0 表示不限制（单次请求仍受 DEEPSEEK_TIMEOUT_MS 约束）
 * @param {Array<string>|null} [options.allowedTools] 白名单；命中名单外的调用直接拒绝
 * @param {Function} [options.execute] 工具执行函数，默认 executeTool
 * @param {string} [options.finalHint] 额度用尽时的收尾提示
 */
export async function runWithTools(baseMessages, ctx, options = {}) {
  const {
    functions = [],
    maxSteps = DEFAULT_MAX_STEPS,
    timeoutMs = 0,
    allowedTools = null,
    execute = executeTool,
    finalHint = DEFAULT_FINAL_HINT
  } = options

  const work = [...baseMessages]
  const seen = new Set()
  let usage = {}
  let lastPromptTokens = 0
  let lastPromptChars = 0
  let lastModel = ''
  let traceSeq = 0

  // 整轮截止时间：到点后取消在途请求，避免一份报告无限占用并发槽位
  const controller = timeoutMs > 0 ? new AbortController() : null
  let timedOut = false
  const timer = controller
    ? setTimeout(() => {
        timedOut = true
        controller.abort()
      }, timeoutMs)
    : null
  const turnOptions = controller ? { functions, signal: controller.signal } : { functions }

  try {
    for (let step = 0; step < maxSteps; step++) {
      lastPromptChars = work.reduce((n, m) => n + String(m.content || '').length, 0)
      const result = await callDeepSeek(work, turnOptions)
      usage = mergeUsage(usage, result.usage)
      lastPromptTokens = result.usage?.prompt_tokens || lastPromptTokens
      if (result.model) lastModel = result.model

      if (!result.toolCalls) {
        return { content: result.content, usage, lastPromptTokens, lastPromptChars, model: lastModel }
      }

      const assistantMsg = { role: 'assistant', content: result.message.content ?? '', tool_calls: result.toolCalls }
      // 思考模式下，带 tool_calls 的 assistant 消息必须把 reasoning_content 原样带回去
      if (result.message.reasoning_content) assistantMsg.reasoning_content = result.message.reasoning_content
      work.push(assistantMsg)
      recordTraceEvent(ctx, ++traceSeq, 'assistant_tool_calls', {
        content: assistantMsg.content,
        tool_calls: result.toolCalls,
        reasoning_content: result.message.reasoning_content ?? null
      })

      for (const call of result.toolCalls) {
        const name = call.function?.name
        const rawArgs = call.function?.arguments || '{}'
        const key = `${name}:${rawArgs}`
        let args = {}
        try {
          args = JSON.parse(rawArgs)
        } catch {
          args = {}
        }

        let output
        if (allowedTools && !allowedTools.includes(name)) {
          output = JSON.stringify({
            ok: false,
            reason: 'tool_not_allowed',
            hint: '这里只能回读具体的记录或报告，不要全量扫描。'
          })
        } else if (seen.has(key)) {
          output = JSON.stringify({
            ok: false,
            reason: 'duplicate_call',
            hint: '同样的查询已经执行过，请换一个 offset、缩小范围，或换一种查法。'
          })
        } else {
          seen.add(key)
          output = execute(name, args, ctx)
        }

        const info = classifyToolOutput(output)
        recordTraceEvent(ctx, ++traceSeq, 'tool_result', {
          tool_call_id: call.id,
          name,
          raw_args: rawArgs,
          args,
          output,
          status: info.status,
          error: info.error || null
        })

        work.push({ role: 'tool', tool_call_id: call.id, content: output })
      }
    }

    // 步数用尽：明确告知额度用尽并撤掉工具，避免模型把工具调用当文本输出
    work.push({ role: 'system', content: finalHint })
    lastPromptChars = work.reduce((n, m) => n + String(m.content || '').length, 0)
    const final = await callDeepSeek(work, controller ? { tools: false, signal: controller.signal } : { tools: false })
    usage = mergeUsage(usage, final.usage)
    lastPromptTokens = final.usage?.prompt_tokens || lastPromptTokens
    if (final.model) lastModel = final.model
    return { content: final.content, usage, lastPromptTokens, lastPromptChars, model: lastModel }
  } catch (err) {
    if (timedOut) {
      const timeoutErr = new Error(`AI 生成超时（${timeoutMs >= 1000 ? `${Math.round(timeoutMs / 1000)} 秒` : `${timeoutMs} 毫秒`}）`)
      timeoutErr.code = 'LLM_TIMEOUT'
      throw timeoutErr
    }
    throw err
  } finally {
    if (timer) clearTimeout(timer)
  }
}
