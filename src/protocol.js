/**
 * Cline Pass wire protocol: pipeline detection, pin injection, failover
 * expansion, and error classification.
 *
 * Two routers sit behind the Cline Pass gateway and they spell a provider pin
 * differently:
 *   - direct  (OpenRouter):   top-level `provider.only / order / sort / ignore`
 *   - planner (Vercel AI GW): `providerOptions.gateway.only / order / sort`
 *
 * A request writes both spellings by default, because the gateway decides which
 * pipeline a model runs on and may change that between calls. Each router
 * ignores the other's field.
 *
 * Routing findings reimplemented from the MIT-licensed cline-pass-switcher and
 * dsh-cline-pass projects.
 */

export const MAX_UPSTREAMS = 64

/** Channels the two routers spell differently, as `[planner, direct]`. */
export const CHANNEL_ALIASES = [['zai', 'z-ai']]

export const OPENROUTER_SORT = { cost: 'price', ttft: 'latency', tps: 'throughput' }

/** The gateway wraps some answers in `{ data: … }`; unwrap that shape. */
export function unwrapEnvelope(json) {
  if (json !== null && typeof json === 'object' && json.data !== null && typeof json.data === 'object' && json.data.choices !== undefined) {
    return json.data
  }
  return json
}

export function normalizeSlug(value) {
  return String(value ?? '').toLowerCase().replace(/[^a-z0-9]/g, '')
}

export function channelNameFor(name, pipeline) {
  const needle = normalizeSlug(name)
  for (const [planner, direct] of CHANNEL_ALIASES) {
    if (normalizeSlug(planner) === needle) return pipeline === 'direct' ? direct : planner
    if (normalizeSlug(direct) === needle) return pipeline === 'planner' ? planner : direct
  }
  return name
}

export function normalizeSort(value) {
  if (typeof value !== 'string') return null
  const sort = value.trim()
  return sort.length === 0 || sort === 'none' ? null : sort
}

export function normalizePinMode(value) {
  return String(value ?? '').trim().toLowerCase() === 'preferred' ? 'preferred' : 'strict'
}

export function isAuthenticationError(message, status) {
  const detail = String(message ?? '').replace(/[_-]/g, ' ')
  return status === 401 || status === 403 || /unauthorized|re\s*authenticate|invalid\s*(?:api\s*key|token)|\b401\b|\b403\b/i.test(detail)
}

/**
 * A spent subscription window, as opposed to a temporary failure mentioning
 * one. Requiring an exhaustion verb is what keeps "temporarily unable to read
 * weekly usage" from standing an account down.
 */
export function isQuotaError(message, status) {
  const detail = String(message ?? '').replace(/[_-]/g, ' ')
  if (status === 402) return true
  const spentWindow = /\b(?:weekly|monthly|daily|(?:five|5)\s*hour|plan)\b[\s\S]{0,80}?\b(?:exceed\w*|exhaust\w*|reach\w*|used\s+up|out\s+of|deplet\w*|spent)\b|\b(?:exceed\w*|exhaust\w*|reach\w*|used\s+up|out\s+of|deplet\w*)\b[\s\S]{0,80}?\b(?:weekly|monthly|daily|(?:five|5)\s*hour|plan)\b[\s\S]{0,40}?\b(?:limit|cap|quota|credits|budget|allowance)\b/i.test(detail)
  return spentWindow
}

/** Map an upstream refusal to one stable code the pool understands. */
export function classifyFailure(status, message) {
  const detail = String(message ?? '')
  if (isQuotaError(detail, status)) return 'QUOTA'
  if (isAuthenticationError(detail, status)) return 'AUTH'
  if (status === 429 || /429|rate limit|rate-?limited/i.test(detail)) return 'RATE_LIMIT'
  if (status === 400 || /invalid_request|modelid|no allowed providers|no available providers|not found|unsupported/i.test(detail)) return 'INVALID_REQUEST'
  if (status >= 500) return 'SERVER'
  return 'UPSTREAM'
}

export function classifyUpstreamError(message) {
  const text = String(message ?? '')
  if (/empty response content/i.test(text)) return 'ok'
  if (/429|rate-?limited|temporarily rate/i.test(text)) return 'limited'
  if (/invalid_request|modelid|no allowed providers|no available providers|not found|unsupported/i.test(text)) return 'bad'
  if (isAuthenticationError(text)) return 'auth'
  return 'unknown'
}

/**
 * Read the routing facts out of one completed gateway response.
 * A direct-pipeline answer names the provider at the top level; a planner
 * answer hides it in `provider_metadata.gateway.routing`.
 */
export function parseRouting(json) {
  const payload = unwrapEnvelope(json)
  const message = payload?.choices?.[0]?.message ?? payload?.choices?.[0]?.delta
  const routing = message?.provider_metadata?.gateway?.routing ?? payload?.provider_metadata?.gateway?.routing ?? {}
  const direct = typeof payload?.provider === 'string' ? payload.provider : null
  return {
    content: typeof message?.content === 'string' ? message.content : null,
    pipeline: routing.finalProvider ? 'planner' : (direct === null ? null : 'direct'),
    canonicalSlug: routing.canonicalSlug ?? (typeof payload?.model === 'string' && payload.model.includes('/') ? payload.model : null),
    finalProvider: routing.finalProvider ?? (direct === null ? null : String(direct).toLowerCase().replace(/\s+/g, '-')),
    finalProviderName: routing.finalProvider ?? direct,
    fallbacks: Array.isArray(routing.fallbacksAvailable) ? routing.fallbacksAvailable.map(String) : [],
    plan: typeof routing.planningReasoning === 'string' ? routing.planningReasoning : '',
  }
}

function knownChannels(meta, pipeline) {
  const scoped = meta?.channels?.[pipeline]
  if (Array.isArray(scoped) && scoped.length > 0) return scoped
  return Array.isArray(meta?.upstreams) ? meta.upstreams : []
}

/**
 * Write one attempt's provider preference into a request body.
 *
 * Excludes are compiled into an `only` allow-list because the gateway ignores
 * the `exclude` spellings. OpenRouter's `ignore` is written alongside as a
 * second line of defence when no channel list exists yet.
 */
export function injectPrefs(body, meta, attempt) {
  const next = { ...body }
  const { upstream = null, orderRest = [], excludeList = [], strict = true } = attempt ?? {}
  const sort = normalizeSort(attempt?.sort)
  const excluded = excludeList.filter((name) => normalizeSlug(name) !== normalizeSlug(upstream ?? ''))
  const excludedIds = new Set(excluded.map(normalizeSlug))
  const spell = (names, pipeline) => names.map((name) => channelNameFor(name, pipeline))
  const gatewayAllow = excluded.length > 0
    ? knownChannels(meta, 'planner').filter((name) => !excludedIds.has(normalizeSlug(name)))
    : null
  const openRouterAllow = excluded.length > 0
    ? knownChannels(meta, 'direct').filter((name) => !excludedIds.has(normalizeSlug(name)))
    : null
  const pipeline = meta?.pipeline ?? null
  const both = attempt?.spelling !== 'detected'
  const useGateway = both || pipeline === 'planner' || pipeline === null
  const useOpenRouter = both || pipeline === 'direct' || pipeline === null
  const gatewayUsable = useGateway && (upstream !== null || sort !== null || (gatewayAllow !== null && gatewayAllow.length > 0))
  const openRouterUsable = useOpenRouter && (upstream !== null || sort !== null || excluded.length > 0 || (openRouterAllow !== null && openRouterAllow.length > 0))
  if (!gatewayUsable && !openRouterUsable) return next

  if (gatewayUsable) {
    const gateway = {}
    if (upstream !== null) {
      if (strict) gateway.only = spell([upstream], 'planner')
      else {
        gateway.order = spell([upstream, ...orderRest], 'planner')
        if (gatewayAllow !== null && gatewayAllow.length > 0) gateway.only = spell(gatewayAllow, 'planner')
      }
    } else if (gatewayAllow !== null && gatewayAllow.length > 0) {
      gateway.only = spell(gatewayAllow, 'planner')
    }
    if (sort !== null) gateway.sort = sort
    next.providerOptions = { ...(next.providerOptions ?? {}), gateway: { ...(next.providerOptions?.gateway ?? {}), ...gateway } }
  }

  if (openRouterUsable) {
    const provider = { ...(next.provider ?? {}) }
    if (upstream !== null) {
      if (strict) provider.only = spell([upstream], 'direct')
      else {
        provider.order = spell([upstream, ...orderRest], 'direct')
        if (openRouterAllow !== null && openRouterAllow.length > 0) provider.only = spell(openRouterAllow, 'direct')
      }
    } else if (openRouterAllow !== null && openRouterAllow.length > 0) {
      provider.only = spell(openRouterAllow, 'direct')
    }
    if (sort !== null) provider.sort = OPENROUTER_SORT[sort] ?? sort
    if (excluded.length > 0) provider.ignore = spell(excluded, 'direct')
    next.provider = provider
  }
  return next
}

/** Read back whether the router honored one attempt's pin. */
export function pinAdherence(attempt, routing) {
  const expected = attempt?.upstream ?? null
  const excluded = (attempt?.excludeList ?? [])
    .filter((name) => normalizeSlug(name) !== normalizeSlug(expected ?? ''))
    .map(normalizeSlug)
  const raw = routing?.finalProvider ?? null
  const actual = raw === null || raw === undefined || String(raw).length === 0 ? null : normalizeSlug(raw)
  if (actual !== null && excluded.includes(actual)) return 'violated'
  if (expected === null || expected === undefined || String(expected).length === 0) return 'unresolved'
  if (actual === null) return 'unresolved'
  if (actual === normalizeSlug(expected)) return 'adopted'
  if ((attempt?.orderRest ?? []).map(normalizeSlug).includes(actual)) return 'fallback'
  return 'not-adopted'
}

export function isAdherenceOk(adherence) {
  return adherence === 'adopted' || adherence === 'fallback' || adherence === 'unresolved'
}

export function pinWarnings(attempt, meta) {
  const upstream = attempt?.upstream ?? null
  const excluded = (attempt?.excludeList ?? []).filter((name) => normalizeSlug(name) !== normalizeSlug(upstream ?? ''))
  const excludedIds = new Set(excluded.map(normalizeSlug))
  if (excluded.length === 0) return []
  const known = Array.isArray(meta?.upstreams) ? meta.upstreams : []
  if (known.length === 0) {
    return [`还没有该模型的服务商列表，排除项 ${excluded.join(', ')} 无法编译成允许列表，请先探测`]
  }
  const remaining = known.filter((name) => !excludedIds.has(normalizeSlug(name)))
  if (remaining.length === 0 && upstream === null) {
    return [`所有已知服务商都被排除（${known.join(', ')}），请求将回落到网关自己的路由`]
  }
  return []
}

/** Expand one model's pin into ordered failover candidates. */
export function buildAttempts(config) {
  const listed = (config?.upstreams ?? []).filter((name) => typeof name === 'string' && name.length > 0)
  const exclude = (config?.exclude ?? []).filter((name) => typeof name === 'string' && name.length > 0)
  const excluded = new Set(exclude.map(normalizeSlug))
  const wanted = listed.filter((name) => !excluded.has(normalizeSlug(name)))
  const strict = normalizePinMode(config?.pinMode) === 'strict'
  const sort = normalizeSort(config?.sort)
  const base = { strict, sort, excludeList: exclude }
  if (typeof config?.spelling === 'string' && config.spelling.length > 0) base.spelling = config.spelling
  if (wanted.length > 0) {
    return wanted.map((upstream, index) => ({
      ...base,
      upstream,
      orderRest: strict ? [] : wanted.filter((_, other) => other !== index),
    }))
  }
  return [{ ...base, upstream: null, orderRest: [] }]
}

/** Recover the router's provider list from an impossible-pin refusal. */
export function extractAvailableProviders(message, pipeline) {
  const text = String(message ?? '')
  if (pipeline === 'planner') {
    const match = /Available providers are:\s*([^.]+)/.exec(text)
    if (match === null) return null
    const tokens = match[1].split(/,\s*/).map((token) => token.trim()).filter((token) => /^[a-z0-9][a-z0-9-]*$/.test(token))
    return tokens.length > 0 ? tokens : null
  }
  if (pipeline === 'direct') {
    const start = text.indexOf('{')
    if (start < 0) return null
    try {
      const parsed = JSON.parse(text.slice(start))
      const list = parsed?.error?.metadata?.available_providers
      return Array.isArray(list) && list.length > 0 ? list.map(String) : null
    } catch {
      return null
    }
  }
  return null
}

/** Merge channel lists across discovery sources, highest confidence first. */
export function mergeUpstreams(...lists) {
  const seen = []
  for (const list of lists) {
    for (const name of list ?? []) {
      const value = String(name)
      if (value.length > 0 && !seen.includes(value)) seen.push(value)
    }
  }
  return seen.slice(0, MAX_UPSTREAMS)
}
