export type User = { id: number; username: string; displayName: string; reminderEnabled: boolean; reminderTime: string }

export type RecordItem = {
  id: number
  day: string
  score: number
  note?: string
  hasNote?: boolean
  originalScore?: number | null
  adjustedAt?: string | null
  createdAt?: string
  updatedAt?: string
}

export type RecordTag = {
  id: number
  recordId: number
  recordDay: string
  tagType: 'insight' | 'suggestion' | 'pattern' | 'correction'
  content: string
  source: 'user' | 'agent'
  sourceRefMessageId?: number | null
  coupleVisible: boolean
  createdAt: string
}

export type Fact = {
  id: number
  content: string
  confidence: number
  source: 'user' | 'agent_extracted' | 'report_derived'
  sourceRefId?: number | null
  coupleVisible: boolean
  pinned: boolean
  createdAt: string
  updatedAt: string
}

export type ShareViewer = {
  id: number
  displayName: string
  scope: 'colors' | 'full'
  acceptedAt: string
}

export type Share = {
  id: number
  token: string
  scope: 'colors' | 'full'
  label: string
  revoked: boolean
  createdAt: string
  viewers: ShareViewer[]
}

export type Granted = {
  id: number
  displayName: string
  username: string
  scope: 'colors' | 'full'
  since: string
}

export type AccessInfo = { mine: Share[]; granted: Granted[] }

export class ApiError extends Error {
  status: number
  constructor(message: string, status: number) {
    super(message)
    this.status = status
  }
}

async function request<T>(path: string, init?: RequestInit): Promise<T> {
  const res = await fetch(`/api${path}`, {
    credentials: 'same-origin',
    headers: { 'Content-Type': 'application/json' },
    ...init
  })

  const text = await res.text()
  let data: unknown = null
  try {
    data = text ? JSON.parse(text) : null
  } catch {
    data = null
  }

  if (!res.ok) {
    const error = (data as { error?: string } | null)?.error || `请求失败（${res.status}）`
    throw new ApiError(error, res.status)
  }
  return data as T
}

// ---------- AI 报告（insights） ----------

export type ColdStartInfo = {
  hasRecords: boolean
  needed: boolean
  start: string | null
  end: string | null
  recordCount: number
}

export type Insight = {
  id: number
  scope: 'single' | 'couple'
  userId?: number | null
  coupleKey?: string | null
  periodType: string
  periodStart: string
  periodEnd: string
  content: string
  model?: string | null
  promptVersion?: string | null
  origin?: 'manual' | 'auto'
  kind?: 'cold' | 'weekly' | 'monthly' | 'custom'
  tokens?: number | null
  sources?: { id: number; type: string; content?: string }[] | null
  coveredUntil?: string | null
  generatedAt: string
}

// ---------- 聊天 ----------

export type ChatSession = {
  id: number
  title: string
  messageCount: number
  createdAt: string
  updatedAt: string
}

export type ChatProposal = {
  id: number
  kind: 'fact' | 'tag' | 'report' | 'record'
  status: 'pending' | 'accepted' | 'rejected' | 'expired'
  payload: {
    content?: string
    confidence?: number
    recordId?: number
    recordDay?: string
    recordIndex?: number
    recordScore?: number
    recordMissing?: boolean
    tagType?: RecordTag['tagType']
    existingTag?: {
      id: number
      tagType: RecordTag['tagType']
      content: string
      source: 'user' | 'agent'
    } | null
    periodType?: 'week' | 'month'
    start?: string | null
    end?: string | null
    day?: string
    score?: number
    note?: string
  } | null
  finalPayload?: ChatProposal['payload'] | null
  edited?: boolean
  coupleVisible: boolean
  resultRefId?: number | null
  createdAt: string
  decidedAt?: string | null
}

export type ChatMessage = {
  id: number
  role: 'user' | 'assistant' | 'system'
  content: string
  refs?: { id: number; type: string; content?: string }[] | null
  proposals?: ChatProposal[]
  createdAt: string
}

export const api = {
  me: () => request<{ user: User }>('/auth/me'),
  login: (username: string, password: string) =>
    request<{ user: User }>('/auth/login', { method: 'POST', body: JSON.stringify({ username, password }) }),
  register: (username: string, password: string, displayName: string) =>
    request<{ user: User }>('/auth/register', {
      method: 'POST',
      body: JSON.stringify({ username, password, displayName })
    }),
  logout: () => request<{ ok: true }>('/auth/logout', { method: 'POST' }),

  listRecords: (from: string, to: string) => request<{ records: RecordItem[] }>(`/records?from=${from}&to=${to}`),
  createRecord: (day: string, score: number, note?: string) =>
    request<{ record: RecordItem }>('/records', {
      method: 'POST',
      body: JSON.stringify(note === undefined ? { day, score } : { day, score, note })
    }),
  updateRecord: (id: number, patch: { note?: string; score?: number }, opts?: { keepalive?: boolean }) =>
    request<{ record: RecordItem }>(`/records/${id}`, {
      method: 'PUT',
      body: JSON.stringify(patch),
      keepalive: opts?.keepalive
    }),
  deleteRecord: (id: number) => request<{ ok: true }>(`/records/${id}`, { method: 'DELETE' }),

  access: () => request<AccessInfo>('/access'),
  createShare: (scope: 'colors' | 'full', label: string) =>
    request<{ share: Share }>('/access/shares', { method: 'POST', body: JSON.stringify({ scope, label }) }),
  revokeShare: (id: number) => request<{ ok: true }>(`/access/shares/${id}/revoke`, { method: 'POST' }),
  redeem: (token: string) =>
    request<{ granted: Granted }>('/access/redeem', { method: 'POST', body: JSON.stringify({ token }) }),
  removeGrant: (ownerId: number) => request<{ ok: true }>(`/access/granted/${ownerId}`, { method: 'DELETE' }),
  personRecords: (ownerId: number, from: string, to: string) =>
    request<{ owner: { id: number; displayName: string }; scope: 'colors' | 'full'; records: RecordItem[] }>(
      `/access/people/${ownerId}/records?from=${from}&to=${to}`
    ),

  pushKey: () => request<{ publicKey: string }>('/push/key'),
  pushStatus: () =>
    request<{
      configured: boolean
      subscriptions: number
      reminderEnabled: boolean
      reminderTime: string
      timezone: string
    }>('/push/status'),
  pushSubscribe: (subscription: PushSubscriptionJSON, timezone: string) =>
    request<{ ok: true }>('/push/subscribe', {
      method: 'POST',
      body: JSON.stringify({ subscription, timezone })
    }),
  pushUnsubscribe: (endpoint: string) =>
    request<{ ok: true }>('/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint }) }),
  pushSettings: (enabled: boolean, time: string, timezone: string) =>
    request<{ ok: true; enabled: boolean; time: string; timezone: string }>('/push/settings', {
      method: 'POST',
      body: JSON.stringify({ enabled, time, timezone })
    }),
  pushTest: () => request<{ ok: true; sent: number }>('/push/test', { method: 'POST' }),

  // ---- record tags ----
  tagsOfRecord: (recordId: number) => request<{ tags: RecordTag[] }>(`/tags/of-record/${recordId}`),
  createTag: (recordId: number, tagType: RecordTag['tagType'], content: string) =>
    request<{ tag: RecordTag }>('/tags', {
      method: 'POST',
      body: JSON.stringify({ recordId, tagType, content })
    }),
  deleteTag: (id: number) => request<{ ok: true }>(`/tags/${id}`, { method: 'DELETE' }),

  // ---- facts ----
  facts: () => request<{ facts: Fact[] }>('/facts'),
  createFact: (body: { content: string; confidence?: number; coupleVisible?: boolean; pinned?: boolean }) =>
    request<{ fact: Fact }>('/facts', { method: 'POST', body: JSON.stringify(body) }),
  updateFact: (
    id: number,
    patch: { content?: string; confidence?: number; coupleVisible?: boolean; pinned?: boolean }
  ) => request<{ fact: Fact }>(`/facts/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
  deleteFact: (id: number) => request<{ ok: true }>(`/facts/${id}`, { method: 'DELETE' }),

  // ---- insights ----
  insights: () => request<{ insights: Insight[]; coldStart: ColdStartInfo }>('/insights'),
  insightAuto: () => request<{ enabled: boolean; asked: boolean }>('/insights/auto'),
  setInsightAuto: (enabled: boolean) =>
    request<{ ok: true; enabled: boolean; asked: boolean }>('/insights/auto', {
      method: 'POST',
      body: JSON.stringify({ enabled })
    }),
  insight: (id: number) => request<{ insight: Insight }>(`/insights/${id}`),
  generateSingleInsight: (body: { periodType?: 'week' | 'month' | 'manual'; start?: string; end?: string }) =>
    request<{
      insight: Insight
      usage?: { total_tokens: number } | null
      hasKey?: boolean
      existing?: boolean
      coldStart?: boolean
    }>(
      '/insights/single/generate',
      {
        method: 'POST',
        body: JSON.stringify(body)
      }
    ),
  deleteInsight: (id: number) => request<{ ok: true }>(`/insights/${id}`, { method: 'DELETE' }),
  generateCoupleInsight: (partnerId: number) =>
    request<{ insight: Insight; usage?: { total_tokens: number }; hasKey?: boolean }>('/insights/couple/generate', {
      method: 'POST',
      body: JSON.stringify({ partnerId })
    }),

  // ---- chat ----
  chatSessions: () => request<{ sessions: ChatSession[] }>('/chat/sessions'),
  createChatSession: (title = '新对话') =>
    request<{ session: ChatSession }>('/chat/sessions', { method: 'POST', body: JSON.stringify({ title }) }),
  patchChatSession: (id: number, title: string) =>
    request<{ session: ChatSession }>(`/chat/sessions/${id}`, { method: 'PATCH', body: JSON.stringify({ title }) }),
  deleteChatSession: (id: number) => request<{ ok: true }>(`/chat/sessions/${id}`, { method: 'DELETE' }),
  chatMessages: (sessionId: number) =>
    request<{ messages: ChatMessage[] }>(`/chat/sessions/${sessionId}/messages`),
  sendChatMessage: (
    sessionId: number,
    body: { content: string; refs?: { id: number; type: string; content?: string }[] }
  ) =>
    request<{ userMessage: ChatMessage; assistantMessage: ChatMessage; usage?: { total_tokens: number } }>(
      `/chat/sessions/${sessionId}/messages`,
      { method: 'POST', body: JSON.stringify(body) }
    ),

  // ---- agent 写入提议 ----
  acceptProposal: (id: number, coupleVisible = false, payload?: ChatProposal['payload']) =>
    request<{
      proposal: ChatProposal
      action?: { type: string; scope: string; periodType: 'week' | 'month'; start?: string | null; end?: string | null }
    }>(`/proposals/${id}/accept`, {
      method: 'POST',
      body: JSON.stringify(payload ? { coupleVisible, payload } : { coupleVisible })
    }),
  rejectProposal: (id: number) =>
    request<{ proposal: ChatProposal }>(`/proposals/${id}/reject`, { method: 'POST' })
}
