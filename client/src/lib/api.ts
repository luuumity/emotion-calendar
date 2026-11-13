export type User = { id: number; username: string; displayName: string }

export type RecordItem = {
  id: number
  day: string
  score: number
  note?: string
  hasNote?: boolean
  createdAt?: string
  updatedAt?: string
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
  updateRecord: (id: number, patch: { score?: number; note?: string }) =>
    request<{ record: RecordItem }>(`/records/${id}`, { method: 'PUT', body: JSON.stringify(patch) }),
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
    )
}
