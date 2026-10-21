import { chatCompletion, fetchAllModels } from './cline.js'
import {
  buildAttempts,
  classifyUpstreamError,
  extractAvailableProviders,
  injectPrefs,
  mergeUpstreams,
  normalizePinMode,
  normalizeSort,
  parseRouting,
  pinAdherence,
  unwrapEnvelope,
} from './protocol.js'
import { errorText as errorTextFallback } from './util.js'

function messageOf(result) {
  const payload = unwrapEnvelope(result.json)
  if (result.ok !== true) return errorTextFallback(payload?.error) || String(result.text ?? '').slice(0, 400) || `HTTP ${result.status}`
  if (!Array.isArray(payload?.choices) || payload.choices.length === 0) return '上游返回了空补全'
  return ''
}

function failed(result) {
  const payload = unwrapEnvelope(result.json)
  if (result.ok !== true) return true
  if (payload?.error !== undefined && payload?.choices === undefined) return true
  return !Array.isArray(payload?.choices) || payload.choices.length === 0
}

/**
 * Recover the provider list from a refusal. The direct router puts it in JSON
 * metadata while the planner puts it in the message, so try the raw body, the
 * error message, and the serialized payload before giving up.
 */
function providersFromResponse(result, pipeline) {
  const payload = unwrapEnvelope(result.json)
  const candidates = [
    String(result.text ?? ''),
    errorTextFallback(payload?.error),
    JSON.stringify(payload ?? {}),
  ]
  for (const candidate of candidates) {
    if (!candidate) continue
    const list = extractAvailableProviders(candidate, pipeline)
    if (Array.isArray(list) && list.length > 0) return list
  }
  const metadata = payload?.error?.metadata?.available_providers
  if (Array.isArray(metadata) && metadata.length > 0) return metadata.map(String)
  return null
}

function defaultPin() {
  return { upstreams: [], exclude: [], pinMode: 'strict', sort: '', spelling: 'both' }
}

function normalizePin(input, previous = defaultPin()) {
  const pin = { ...defaultPin(), ...previous, ...(input && typeof input === 'object' ? input : {}) }
  pin.upstreams = Array.isArray(pin.upstreams) ? pin.upstreams.map(String).filter(Boolean).slice(0, 64) : []
  pin.exclude = Array.isArray(pin.exclude) ? pin.exclude.map(String).filter(Boolean).slice(0, 64) : []
  pin.pinMode = normalizePinMode(pin.pinMode)
  pin.sort = normalizeSort(pin.sort) ?? ''
  pin.spelling = pin.spelling === 'detected' ? 'detected' : 'both'
  return pin
}

export function createModelRegistry({ store, pool, log }) {
  const config = () => store.config
  const baseURLOf = (account) => String(account?.baseURL || config().upstream.baseURL || '')
  /**
   * The last observed result of a pin, kept in memory rather than in the
   * config: a probe, a validation or one live request is evidence about a
   * moment, not a setting. It is what the panel shows next to the pin so
   * "served by someone else" is visible instead of silent.
   */
  const pinStatus = new Map()

  function resolve(requested) {
    const raw = String(requested ?? '').trim()
    if (raw.length === 0) return null
    const models = config().models
    if (models.known.includes(raw)) return { id: raw, enabled: models.enabled.includes(raw), unknown: false }
    const tail = raw.replace(/^cline-pass\//, '')
    const match = models.known.find((id) => id.replace(/^cline-pass\//, '') === tail)
    if (match !== undefined) return { id: match, enabled: models.enabled.includes(match), unknown: false }
    if (config().server.allowUnknownModels === true) {
      return { id: raw.startsWith('cline-pass/') ? raw : `cline-pass/${raw}`, enabled: true, unknown: true }
    }
    return null
  }

  function pinFor(id) {
    return normalizePin(config().models.pins?.[id] ?? {}, defaultPin())
  }

  function metaFor(id) {
    return config().models.discovered?.[id] ?? {}
  }

  function publicModel(id) {
    return {
      id,
      name: id.replace(/^cline-pass\//, ''),
      enabled: config().models.enabled.includes(id),
      pin: pinFor(id),
      discovered: metaFor(id),
      lastPin: pinStatus.get(id) ?? null,
    }
  }

  function list() {
    return config().models.known.map(publicModel)
  }

  function enabledModels() {
    return config().models.enabled.map((id) => ({ id, name: id.replace(/^cline-pass\//, '') }))
  }

  function addModel(id, { enabled = true, name = '' } = {}) {
    const value = String(id ?? '').trim()
    if (!value) throw new Error('model id is required')
    store.update((next) => {
      if (!next.models.known.includes(value)) next.models.known.push(value)
      if (enabled && !next.models.enabled.includes(value)) next.models.enabled.push(value)
      if (!next.models.discovered[value]) next.models.discovered[value] = {}
      if (name) next.models.discovered[value].name = String(name)
    })
    return publicModel(value)
  }

  function removeModel(id) {
    store.update((next) => {
      next.models.known = next.models.known.filter((value) => value !== id)
      next.models.enabled = next.models.enabled.filter((value) => value !== id)
      delete next.models.pins?.[id]
      delete next.models.discovered?.[id]
      pinStatus.delete(id)
    })
  }

  function setVisibility(id, enabled) {
    if (!config().models.known.includes(id)) throw new Error('unknown model')
    store.update((next) => {
      if (enabled === true) {
        if (!next.models.enabled.includes(id)) next.models.enabled.push(id)
      } else {
        next.models.enabled = next.models.enabled.filter((value) => value !== id)
      }
    })
    return publicModel(id)
  }

  function setPin(id, patch) {
    store.update((next) => {
      next.models.pins[id] = normalizePin(patch, normalizePin(next.models.pins?.[id] ?? {}, defaultPin()))
    })
    // A new pin invalidates whatever the previous one was verified against.
    pinStatus.delete(id)
    return publicModel(id)
  }

  /** Merge catalog ids, keeping disabled models disabled. */
  function addKnown(ids, { enableNew = true } = {}) {
    const added = []
    store.update((next) => {
      for (const raw of ids) {
        const id = String(raw ?? '').trim()
        if (!id) continue
        if (!next.models.known.includes(id)) {
          next.models.known.push(id)
          added.push(id)
          if (enableNew && !next.models.enabled.includes(id)) next.models.enabled.push(id)
        }
        if (!next.models.discovered[id]) next.models.discovered[id] = {}
      }
    })
    return added
  }

  async function refreshCatalog() {
    const account = pool.peekAny()
    const ids = await fetchAllModels({
      baseURL: account ? baseURLOf(account) : config().upstream.baseURL,
      apiKey: account?.apiKey ?? '',
      recommendedURL: config().upstream.recommendedURL,
    })
    const clinePass = ids.filter((id) => id.startsWith('cline-pass/'))
    const effective = clinePass.length > 0 ? clinePass : ids
    const added = addKnown(effective, { enableNew: true })
    return { added, total: config().models.known.length, fetched: ids.length }
  }

  /**
   * Detect the pipeline, read back the serving provider, and harvest both
   * routers' channel lists with an impossible `only` value.
   */
  async function probe(id) {
    const account = pool.peekAny()
    if (account === undefined || account === null) throw new Error('no enabled account with an API key')
    const baseURL = baseURLOf(account)
    const timeoutMs = Math.max(10_000, Number(config().upstream.connectTimeoutMs ?? 60_000))

    const started = Date.now()
    const result = await chatCompletion({
      baseURL,
      apiKey: account.apiKey,
      body: { model: id, messages: [{ role: 'user', content: 'Reply with the word OK' }], max_tokens: 256 },
      timeoutMs,
    })
    if (failed(result)) {
      const message = messageOf(result)
      noteUpstream(id, null, 'unknown', message, Date.now() - started)
      return { ok: false, model: id, status: result.status, ms: Date.now() - started, error: message }
    }
    const routing = parseRouting(result.json)
    const base = { model: id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }
    const harvest = async (body, pipeline) => {
      try {
        const response = await chatCompletion({ baseURL, apiKey: account.apiKey, body, timeoutMs })
        return providersFromResponse(response, pipeline)
      } catch {
        return null
      }
    }
    const [directList, plannerList] = await Promise.all([
      harvest({ ...base, provider: { only: ['__probe__'] } }, 'direct'),
      harvest({ ...base, providerOptions: { gateway: { only: ['__probe__'] } } }, 'planner'),
    ])

    const previous = metaFor(id)
    const pipeline = routing.pipeline
    const served = routing.finalProvider
    const channels = { ...(previous.channels ?? {}) }
    if (pipeline === 'planner') {
      const scoped = mergeUpstreams(served ? [served] : [], plannerList, routing.fallbacks)
      if (scoped.length > 0) channels.planner = scoped
      if (Array.isArray(directList) && directList.length > 0) channels.direct = directList
    } else if (pipeline === 'direct') {
      const scoped = mergeUpstreams(served ? [served] : [], directList, routing.fallbacks)
      if (scoped.length > 0) channels.direct = scoped
      if (Array.isArray(plannerList) && plannerList.length > 0) channels.planner = plannerList
    } else {
      if (Array.isArray(directList) && directList.length > 0) channels.direct = directList
      if (Array.isArray(plannerList) && plannerList.length > 0) channels.planner = plannerList
    }

    const combined = mergeUpstreams(
      served ? [served] : [],
      pipeline === 'planner' ? plannerList : directList,
      routing.fallbacks,
      previous.upstreams,
      channels.direct,
      channels.planner,
    )
    const discovered = {
      ...previous,
      pipeline,
      pinnable: pipeline !== null,
      canonicalSlug: routing.canonicalSlug ?? previous.canonicalSlug ?? null,
      upstreams: combined,
      channels,
      availableProviders: pipeline === 'planner' ? (plannerList ?? []) : (directList ?? []),
      lastProvider: served ?? previous.lastProvider ?? '',
      lastPlan: routing.plan ?? '',
      probedAt: Date.now(),
      lastError: '',
    }
    if (served) {
      discovered.upstreamStatus = { ...(previous.upstreamStatus ?? {}), [served]: { status: 'ok', note: 'probe served by this channel', ms: Date.now() - started, checkedAt: Date.now() } }
    }
    store.update((next) => {
      next.models.discovered[id] = discovered
    })
    return { ok: true, model: id, ms: Date.now() - started, pipeline, pinnable: pipeline !== null, lastProvider: served ?? '', upstreams: combined, channels, canonicalSlug: discovered.canonicalSlug }
  }

  /** Record the outcome of a pin check, for the row badge. */
  function notePin(id, status) {
    if (status === null || status === undefined) {
      pinStatus.delete(id)
      return null
    }
    const value = { ...status, at: status.at ?? Date.now() }
    pinStatus.set(id, value)
    return value
  }

  /**
   * Send one request through the saved pin and report whether the router
   * honored it. A probe is intentionally unpinned, so the provider a probe
   * reports says nothing about the saved pin; this is the action that does.
   */
  async function testPin(id) {
    const pin = pinFor(id)
    const expected = pin.upstreams?.[0] ?? null
    if (expected === null && (pin.exclude ?? []).length === 0) {
      return { ok: false, model: id, expected: null, actual: '', adherence: 'unresolved', note: '这个模型还没有钉住任何服务商', trace: [] }
    }
    const meta = metaFor(id)
    const account = pool.peek()
    if (account === null) throw new Error('没有可用的 Cline 账户（请先添加并启用账户）')
    const baseURL = baseURLOf(account)
    const timeoutMs = Math.max(10_000, Number(config().upstream.connectTimeoutMs ?? 60_000))
    const attempts = buildAttempts(pin)
    const trace = []
    const started = Date.now()
    let last = null

    for (const attempt of attempts) {
      const body = injectPrefs({
        model: id,
        messages: [{ role: 'user', content: 'Reply with the word OK' }],
        max_tokens: 512,
      }, meta, attempt)
      try {
        const result = await chatCompletion({ baseURL, apiKey: account.apiKey, body, timeoutMs })
        const ms = Date.now() - started
        if (failed(result)) {
          const note = messageOf(result)
          trace.push({ upstream: attempt.upstream ?? '(auto)', status: 0, adherence: 'error', ms, note: note.slice(0, 160) })
          last = { ok: false, expected: attempt.upstream ?? null, actual: '', adherence: 'error', note }
          if (attempt.upstream) noteUpstream(id, attempt.upstream, classifyUpstreamError(note), note, ms)
          continue
        }
        const routing = parseRouting(result.json)
        const adherence = pinAdherence(attempt, routing)
        const actual = routing.finalProvider ?? ''
        trace.push({ upstream: attempt.upstream ?? '(auto)', status: 200, adherence, ms, note: actual ? `实际由 ${actual} 服务` : '响应没有报告服务商' })
        last = { ok: true, expected: attempt.upstream ?? null, actual, adherence, pipeline: routing.pipeline, canonicalSlug: routing.canonicalSlug, note: '' }
        if (adherence === 'adopted' || adherence === 'fallback') {
          notePin(id, { expected: last.expected, actual, adherence, source: 'test' })
          if (attempt.upstream !== null) noteUpstream(id, attempt.upstream, 'ok', 'pin adopted', ms)
          return { ...last, model: id, account: account.name, ms, trace }
        }
      } catch (error) {
        const ms = Date.now() - started
        const note = String(error?.message ?? error)
        trace.push({ upstream: attempt.upstream ?? '(auto)', status: 0, adherence: 'error', ms, note: note.slice(0, 160) })
        last = { ok: false, expected: attempt.upstream ?? null, actual: '', adherence: 'error', note }
      }
    }

    if (last !== null) {
      notePin(id, { expected: last.expected, actual: last.actual ?? '', adherence: last.adherence === 'unresolved' ? 'unresolved' : 'not-adopted', source: 'test' })
      if (last.expected !== null) noteUpstream(id, last.expected, 'bad', 'pin not adopted', Date.now() - started)
      return {
        ...last,
        model: id,
        ok: false,
        account: account.name,
        ms: Date.now() - started,
        trace,
        note: last.adherence === 'unresolved'
          ? '响应没有报告实际服务商，无法验证钉住'
          : `钉住未生效：期望 ${last.expected ?? '(自动)'}，实际由 ${last.actual || '(unknown)'} 服务`,
      }
    }
    return { ok: false, model: id, expected, actual: '', adherence: 'error', note: '测试请求没有结果', trace }
  }

  /** Send a tiny pinned request per channel and record whether the pin held. */
  async function validate(id, requested) {
    const meta = metaFor(id)
    const pinned = pinFor(id).upstreams?.[0] ?? null
    const upstreams = Array.isArray(requested) && requested.length > 0
      ? requested.map(String)
      : Array.isArray(meta.upstreams) ? meta.upstreams : []
    if (upstreams.length === 0) throw new Error('该模型还没有服务商列表，请先探测')
    const account = pool.peekAny()
    if (account === undefined || account === null) throw new Error('no enabled account with an API key')
    const baseURL = baseURLOf(account)
    const timeoutMs = Math.max(10_000, Number(config().upstream.connectTimeoutMs ?? 60_000))
    const results = []

    for (let index = 0; index < upstreams.length; index += 4) {
      const batch = upstreams.slice(index, index + 4)
      const settled = await Promise.all(batch.map(async (upstream) => {
        const started = Date.now()
        const attempt = { upstream, strict: true, orderRest: [], excludeList: [] }
        const body = injectPrefs({ model: id, messages: [{ role: 'user', content: 'hi' }], max_tokens: 16 }, meta, attempt)
        try {
          const result = await chatCompletion({ baseURL, apiKey: account.apiKey, body, timeoutMs })
          const ms = Date.now() - started
          if (failed(result)) {
            const note = messageOf(result)
            return { upstream, status: classifyUpstreamError(note), ms, note: note.slice(0, 200), actual: '' }
          }
          const routing = parseRouting(result.json)
          const adherence = pinAdherence(attempt, routing)
          const actual = routing.finalProvider ?? ''
          if (adherence === 'adopted') return { upstream, status: 'ok', ms, note: 'pin adopted', actual }
          if (adherence === 'unresolved') return { upstream, status: 'unknown', ms, note: '响应没有报告服务商，钉住无法验证', actual }
          return { upstream, status: 'not-adopted', ms, note: `钉住未生效，实际由 ${routing.finalProvider ?? '(unknown)'} 服务`, actual }
        } catch (error) {
          return { upstream, status: 'unknown', ms: Date.now() - started, note: String(error?.message ?? error).slice(0, 200) }
        }
      }))
      for (const row of settled) {
        results.push(row)
        if (row.status !== 'unknown') noteUpstream(id, row.upstream, row.status, row.note, row.ms)
        if (pinned !== null && row.upstream === pinned) {
          notePin(id, {
            expected: pinned,
            actual: row.actual || '',
            adherence: row.status === 'ok' ? 'adopted' : row.status === 'not-adopted' ? 'not-adopted' : 'unresolved',
            source: 'validate',
          })
        }
      }
    }
    return { model: id, results }
  }

  /** Learn which channel served a live request. */
  function noteRouting(id, routing) {
    if (!routing || (!routing.finalProvider && !routing.pipeline && !routing.canonicalSlug)) return
    const previous = metaFor(id)
    const next = { ...previous }
    let changed = false
    if (routing.finalProvider) {
      const list = mergeUpstreams([routing.finalProvider], previous.upstreams)
      if (list.length !== (previous.upstreams?.length ?? 0)) {
        next.upstreams = list
        changed = true
      }
      if (previous.lastProvider !== routing.finalProvider) {
        next.lastProvider = routing.finalProvider
        changed = true
      }
      if (routing.pipeline) {
        const channels = { ...(previous.channels ?? {}) }
        const scoped = mergeUpstreams([routing.finalProvider], channels[routing.pipeline])
        if (scoped.length !== (channels[routing.pipeline]?.length ?? 0)) {
          channels[routing.pipeline] = scoped
          next.channels = channels
          changed = true
        }
      }
    }
    if (routing.pipeline && previous.pipeline !== routing.pipeline) {
      next.pipeline = routing.pipeline
      next.pinnable = routing.pipeline !== null
      changed = true
    }
    if (routing.canonicalSlug && previous.canonicalSlug !== routing.canonicalSlug) {
      next.canonicalSlug = routing.canonicalSlug
      changed = true
    }
    if (!changed) return
    store.update((current) => {
      current.models.discovered[id] = next
    })
  }

  function noteUpstream(id, upstream, status, note, ms) {
    if (!upstream) return
    store.update((next) => {
      const discovered = next.models.discovered[id] ?? {}
      next.models.discovered[id] = {
        ...discovered,
        upstreamStatus: {
          ...(discovered.upstreamStatus ?? {}),
          [upstream]: { status: String(status), note: String(note ?? '').slice(0, 240), ms: Number(ms ?? 0), checkedAt: Date.now() },
        },
      }
    })
  }

  /** Merge a provider list the router volunteered in an error message. */
  function noteFromError(id, message) {
    const match = /Available providers are:\s*([^.]+)/.exec(String(message ?? ''))
    if (match === null) return
    const tokens = match[1].split(/,\s*/).map((token) => token.trim()).filter((token) => /^[a-z0-9][a-z0-9-]*$/.test(token))
    if (tokens.length === 0) return
    const previous = metaFor(id)
    const merged = mergeUpstreams(tokens, previous.upstreams)
    if (merged.length === (previous.upstreams?.length ?? 0)) return
    store.update((next) => {
      next.models.discovered[id] = { ...(next.models.discovered[id] ?? {}), upstreams: merged }
    })
    log?.info?.(`learned ${tokens.length} provider(s) for ${id} from a router error`)
  }

  return {
    resolve,
    list,
    enabledModels,
    addModel,
    removeModel,
    addKnown,
    setVisibility,
    setPin,
    pinFor,
    metaFor,
    refreshCatalog,
    probe,
    validate,
    testPin,
    notePin,
    noteRouting,
    noteUpstream,
    noteFromError,
  }
}
