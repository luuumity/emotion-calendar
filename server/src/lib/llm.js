// DeepSeek Chat API 封装
// 环境变量：DEEPSEEK_API_KEY（必须），DEEPSEEK_BASE_URL（可选，默认 https://api.deepseek.com）
// 未配置 API key 时，call() 返回占位内容，不抛错——方便本地联调 UI

const BASE_URL = process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com'
const MODEL = process.env.DEEPSEEK_MODEL || 'deepseek-v4-flash'

const API_KEY = process.env.DEEPSEEK_API_KEY
const HAS_KEY = Boolean(API_KEY)

// 服务端工具：模型可自行读取最后一条 user 消息中的链接。不按次计费，只算 token
const DEFAULT_TOOLS = [{ type: 'deepseek_read_url' }]

export function hasDeepSeekKey() {
  return HAS_KEY
}

/**
 * 同步包装：DeepSeek 是 HTTP 调用，Node 里用 fetch + async/await。
 * 业务层可以 await 它。
 * @param {Array<{role: string, content: string}>} messages
 * @param {object} [opts]
 * @param {string} [opts.model]
 * @param {number} [opts.maxTokens]
 * @param {number} [opts.temperature]
 * @param {Array<object>|false} [opts.tools] 服务端工具；默认声明 deepseek_read_url，传 false 可关闭
 * @param {Array<object>} [opts.functions] 客户端 function calling 工具
 * @returns {Promise<{content: string, toolCalls: Array|null, message: object, usage: object, model: string}>}
 */
export async function callDeepSeek(messages, opts = {}) {
  if (!HAS_KEY) {
    // 无 key 时返回占位，不抛错
    console.warn('[llm] DEEPSEEK_API_KEY 未配置，返回占位内容')
    return {
      content: '[AI 服务未配置，返回占位内容。请在服务器设置 DEEPSEEK_API_KEY 环境变量。]',
      toolCalls: null,
      message: { role: 'assistant', content: '' },
      usage: { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
      model: MODEL
    }
  }

  const serverTools = opts.tools === false ? [] : opts.tools || DEFAULT_TOOLS
  const tools = [...serverTools, ...(opts.functions || [])]

  const payload = {
    model: opts.model || MODEL,
    messages,
    stream: false,
    temperature: opts.temperature ?? 0.7,
    ...(opts.maxTokens ? { max_tokens: opts.maxTokens } : {}),
    ...(tools.length ? { tools } : {})
  }

  const resp = await fetch(`${BASE_URL}/chat/completions`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${API_KEY}`
    },
    body: JSON.stringify(payload)
  })

  if (!resp.ok) {
    const body = await resp.text()
    throw new Error(`DeepSeek API ${resp.status}: ${body.slice(0, 200)}`)
  }

  const data = await resp.json()
  const message = data.choices?.[0]?.message || {}
  return {
    content: message.content ?? '',
    toolCalls: Array.isArray(message.tool_calls) && message.tool_calls.length ? message.tool_calls : null,
    message,
    usage: data.usage || { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 },
    model: data.model || MODEL
  }
}
