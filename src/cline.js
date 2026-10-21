/**
 * Cline Pass transport and usage endpoints.
 *
 *   POST {baseURL}/chat/completions          — the gateway
 *   GET  {baseURL}/models                    — the gateway's own catalog
 *   GET  {baseURL}/users/me/plan/usage-limits — quota windows
 *   GET  {baseURL}/users/me                  — account profile (contains the id)
 *   GET  {baseURL}/users/me/plan             — plan and caps
 *   GET  {baseURL}/users/{id}/usages/daily   — per-day/per-model usage
 *   GET  {baseURL}/users/{id}/usages         — raw request history
 *   GET  api.cline.bot/.../recommended-models — subscription model list (no auth)
 */

import { errorText, trimBase, withTimeout } from './util.js'

export const RECOMMENDED_MODELS_URL = 'https://api.cline.bot/api/v1/ai/cline/recommended-models'
export const USAGE_PAGE_SIZE = 200

export function chatURL(baseURL) {
  return `${trimBase(baseURL)}/chat/completions`
}

/** Attribution headers a gateway may use for rate accounting. */
export function attributionHeaders() {
  return {
    'HTTP-Referer': 'https://cline.bot',
    'X-Title': 'Cline Manager',
    'User-Agent': 'cline-manager/1.0 (+https://github.com/chengtx007/cline-manager)',
  }
}

/** One JSON request; HTTP errors are returned as data, never thrown. */
export async function sendJSON(url, { method = 'GET', apiKey = '', body, signal, timeoutMs = 60000, headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: {
      Accept: 'application/json',
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      ...(apiKey === '' ? {} : { Authorization: `Bearer ${apiKey}` }),
      ...attributionHeaders(),
      ...headers,
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    signal: withTimeout(signal, timeoutMs),
  })
  const text = await response.text()
  let json = null
  if (text.length > 0) {
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
  }
  return { status: response.status, ok: response.ok, json, text }
}

export function chatCompletion({ baseURL, apiKey, body, signal, timeoutMs = 180000 }) {
  return sendJSON(chatURL(baseURL), { method: 'POST', apiKey, body, signal, timeoutMs })
}

/**
 * Open a streaming completion. Only the wait for response headers is bounded
 * here; body reads get their own idle watchdog in the proxy.
 */
export async function openChatStream({ baseURL, apiKey, body, signal, headers = {}, connectTimeoutMs = 60000 }) {
  const connect = new AbortController()
  const timer = setTimeout(() => connect.abort(new Error('upstream connect timeout')), connectTimeoutMs)
  timer.unref?.()
  try {
    return await fetch(chatURL(baseURL), {
      method: 'POST',
      headers: {
        Accept: 'text/event-stream',
        'Content-Type': 'application/json',
        ...(apiKey === '' ? {} : { Authorization: `Bearer ${apiKey}` }),
        ...attributionHeaders(),
        ...headers,
      },
      body: JSON.stringify(body),
      signal: signal === undefined ? connect.signal : AbortSignal.any([signal, connect.signal]),
    })
  } finally {
    clearTimeout(timer)
  }
}

function envelopePayload(json) {
  if (json !== null && typeof json === 'object' && json.data !== null && typeof json.data === 'object' && (Array.isArray(json.data) || json.data.choices !== undefined || json.data.limits !== undefined || json.data.items !== undefined)) {
    return json.data
  }
  return json
}

function firstMessage(envelope) {
  const message = envelope?.error ?? envelope?.message ?? envelope?.error?.message
  if (typeof message === 'string') return message.slice(0, 300)
  if (message && typeof message === 'object') return errorText(message).slice(0, 300)
  return ''
}

/**
 * Read the account's quota windows.
 * @returns `{ ok, limits: [{ type, percentUsed, resetsAt }], error }`
 */
export async function fetchUsageLimits({ baseURL, apiKey, signal, timeoutMs = 30000 }) {
  try {
    const result = await sendJSON(`${trimBase(baseURL)}/users/me/plan/usage-limits`, { apiKey, signal, timeoutMs })
    const envelope = result.json
    if (!result.ok) {
      return { ok: false, limits: [], error: `HTTP ${result.status}${firstMessage(envelope) ? `: ${firstMessage(envelope)}` : ''}` }
    }
    const payload = envelopePayload(envelope) ?? {}
    const rawLimits = Array.isArray(payload) ? payload : Array.isArray(payload?.limits) ? payload.limits : []
    const limits = rawLimits
      .map((limit) => ({
        type: String(limit?.type ?? ''),
        percentUsed: Number(limit?.percentUsed ?? 0),
        resetsAt: String(limit?.resetsAt ?? ''),
      }))
      .filter((limit) => limit.type.length > 0)
    return { ok: true, limits, error: '' }
  } catch (error) {
    return { ok: false, limits: [], error: String(error?.message ?? error) }
  }
}

export async function fetchProfile({ baseURL, apiKey, signal, timeoutMs = 30000 }) {
  try {
    const result = await sendJSON(`${trimBase(baseURL)}/users/me`, { apiKey, signal, timeoutMs })
    if (!result.ok) return { ok: false, profile: null, error: `HTTP ${result.status}${firstMessage(result.json) ? `: ${firstMessage(result.json)}` : ''}` }
    const envelope = result.json
    const payload = envelope?.data !== null && typeof envelope?.data === 'object' ? envelope.data : envelope
    const user = payload?.user ?? payload
    return {
      ok: true,
      profile: {
        id: String(user?.id ?? user?.userId ?? ''),
        name: String(user?.name ?? user?.displayName ?? user?.email ?? ''),
        email: String(user?.email ?? ''),
      },
      error: '',
    }
  } catch (error) {
    return { ok: false, profile: null, error: String(error?.message ?? error) }
  }
}

export async function fetchPlan({ baseURL, apiKey, signal, timeoutMs = 30000 }) {
  try {
    const result = await sendJSON(`${trimBase(baseURL)}/users/me/plan`, { apiKey, signal, timeoutMs })
    if (!result.ok) return { ok: false, plan: null, error: `HTTP ${result.status}${firstMessage(result.json) ? `: ${firstMessage(result.json)}` : ''}` }
    const envelope = result.json
    const payload = envelope?.data !== null && typeof envelope?.data === 'object' ? envelope.data : envelope
    return { ok: true, plan: payload?.plan ?? payload ?? null, error: '' }
  } catch (error) {
    return { ok: false, plan: null, error: String(error?.message ?? error) }
  }
}

/**
 * Per-day, per-model usage aggregated by the gateway.
 * @returns `{ ok, rows: [{ date, model, promptTokens, completionTokens, totalTokens, costUsd }], error }`
 */
export async function fetchDailyUsage({ baseURL, apiKey, userId, startDate, endDate, signal, timeoutMs = 45000 }) {
  if (!userId) return { ok: false, rows: [], error: 'account id is unknown; refresh the profile first' }
  try {
    const url = `${trimBase(baseURL)}/users/${encodeURIComponent(userId)}/usages/daily?startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}`
    const result = await sendJSON(url, { apiKey, signal, timeoutMs })
    if (!result.ok) {
      return { ok: false, rows: [], error: `HTTP ${result.status}${firstMessage(result.json) ? `: ${firstMessage(result.json)}` : ''}` }
    }
    const payload = envelopePayload(result.json) ?? {}
    const items = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : []
    const rows = items.map((row) => {
      const promptTokens = Number(row?.promptTokens ?? 0)
      const completionTokens = Number(row?.completionTokens ?? 0)
      return {
        date: String(row?.date ?? ''),
        model: String(row?.aiModelName ?? row?.aiModelTypeName ?? ''),
        promptTokens,
        completionTokens,
        totalTokens: promptTokens + completionTokens,
        costUsd: Number(row?.costUsd ?? 0),
      }
    })
    return { ok: true, rows, error: '' }
  } catch (error) {
    return { ok: false, rows: [], error: String(error?.message ?? error) }
  }
}

export async function fetchUsageHistory({ baseURL, apiKey, userId, page = 1, limit = USAGE_PAGE_SIZE, signal, timeoutMs = 45000 }) {
  if (!userId) return { ok: false, rows: [], error: 'account id is unknown; refresh the profile first' }
  try {
    const url = `${trimBase(baseURL)}/users/${encodeURIComponent(userId)}/usages?page=${page}&limit=${limit}`
    const result = await sendJSON(url, { apiKey, signal, timeoutMs })
    if (!result.ok) return { ok: false, rows: [], error: `HTTP ${result.status}` }
    const payload = envelopePayload(result.json) ?? {}
    const rows = Array.isArray(payload) ? payload : Array.isArray(payload?.items) ? payload.items : []
    return { ok: true, rows, error: '' }
  } catch (error) {
    return { ok: false, rows: [], error: String(error?.message ?? error) }
  }
}

/** The gateway's own catalog ids. */
export async function fetchGatewayModels({ baseURL, apiKey, signal, timeoutMs = 30000 }) {
  try {
    const result = await sendJSON(`${trimBase(baseURL)}/models`, { apiKey, signal, timeoutMs })
    if (!result.ok) return []
    const list = Array.isArray(result.json)
      ? result.json
      : Array.isArray(result.json?.data) ? result.json.data : Array.isArray(result.json?.models) ? result.json.models : []
    return list.map((model) => model?.id).filter((id) => typeof id === 'string')
  } catch {
    return []
  }
}

/** The official public subscription list (no auth required). */
export async function fetchRecommendedModels({ url = RECOMMENDED_MODELS_URL, signal, timeoutMs = 30000 } = {}) {
  try {
    const response = await fetch(url, { signal: withTimeout(signal, timeoutMs), headers: attributionHeaders() })
    if (!response.ok) return []
    const json = await response.json()
    const list = json?.clinePass ?? json?.data?.clinePass
    if (!Array.isArray(list)) return []
    return list
      .map((entry) => (typeof entry === 'string' ? entry : entry?.id))
      .filter((id) => typeof id === 'string' && id.startsWith('cline-pass/'))
  } catch {
    return []
  }
}

/**
 * Merge both catalogs. The live `/models` call wins for discovery, and the
 * public recommendation list still works when no account key is configured.
 */
export async function fetchAllModels({ baseURL, apiKey, recommendedURL, signal } = {}) {
  const [gateway, recommended] = await Promise.all([
    apiKey ? fetchGatewayModels({ baseURL, apiKey, signal }) : Promise.resolve([]),
    fetchRecommendedModels({ url: recommendedURL, signal }),
  ])
  const ids = []
  for (const id of [...gateway, ...recommended]) {
    const value = String(id)
    if (!ids.includes(value)) ids.push(value)
  }
  return ids
}
