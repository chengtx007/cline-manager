import path from 'node:path'
import { atomicWriteJSON, dayKey, readJSONFile } from './util.js'

const RETENTION_DAYS = 400
const RECENT_LIMIT = 500

/** Normalize an OpenAI usage object into disjoint counters. */
export function mapUsage(usage) {
  const prompt = Number(usage?.prompt_tokens ?? usage?.input_tokens ?? 0) || 0
  const completion = Number(usage?.completion_tokens ?? usage?.output_tokens ?? 0) || 0
  const total = Number(usage?.total_tokens ?? 0) || prompt + completion
  const cached = Number(
    usage?.prompt_tokens_details?.cached_tokens
      ?? usage?.prompt_cache_hit_tokens
      ?? usage?.cache_read_input_tokens
      ?? 0,
  ) || 0
  const reasoning = Number(usage?.completion_tokens_details?.reasoning_tokens ?? 0) || 0
  return { prompt, completion, total, cached, reasoning }
}

function emptyCounters() {
  return {
    requests: 0,
    errors: 0,
    promptTokens: 0,
    completionTokens: 0,
    totalTokens: 0,
    cachedTokens: 0,
    reasoningTokens: 0,
  }
}

function emptyBucket() {
  return { ...emptyCounters(), models: {}, accounts: {}, keys: {} }
}

function addCounter(target, source) {
  target.requests += source.requests ?? 0
  target.errors += source.errors ?? 0
  target.promptTokens += source.promptTokens ?? 0
  target.completionTokens += source.completionTokens ?? 0
  target.totalTokens += source.totalTokens ?? 0
  target.cachedTokens += source.cachedTokens ?? 0
  target.reasoningTokens += source.reasoningTokens ?? 0
}

function bumpMap(map, key, name, counters) {
  if (!key) return
  const isMap = map instanceof Map
  const current = isMap ? map.get(key) : map[key]
  const entry = current ?? { name: name || key, ...emptyCounters() }
  if (name) entry.name = name
  addCounter(entry, counters)
  if (isMap) map.set(key, entry)
  else map[key] = entry
}

/** Local token accounting, split by day, model, account and request key. */
export function createStats({ dataDir, log } = {}) {
  const file = path.join(dataDir, 'stats.json')
  const loaded = readJSONFile(file, null)
  const data = {
    version: 1,
    byDay: loaded?.byDay && typeof loaded.byDay === 'object' ? loaded.byDay : {},
    recent: Array.isArray(loaded?.recent) ? loaded.recent.slice(0, RECENT_LIMIT) : [],
  }

  // Drop buckets beyond retention.
  const cutoff = dayKey(Date.now() - RETENTION_DAYS * 86_400_000)
  for (const key of Object.keys(data.byDay)) if (key < cutoff) delete data.byDay[key]

  let timer = null
  const saveNow = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    try {
      const cutoff = dayKey(Date.now() - RETENTION_DAYS * 86_400_000)
      for (const key of Object.keys(data.byDay)) if (key < cutoff) delete data.byDay[key]
      atomicWriteJSON(file, data)
    } catch (error) {
      log?.warn?.(`stats write failed: ${error?.message ?? error}`)
    }
  }
  const save = () => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      try {
        atomicWriteJSON(file, data)
      } catch (error) {
        log?.warn?.(`stats write failed: ${error?.message ?? error}`)
      }
    }, 1500)
    timer.unref?.()
  }

  function record(entry) {
    const ts = Number(entry.ts ?? Date.now())
    const day = dayKey(ts)
    const bucket = data.byDay[day] ?? emptyBucket()
    data.byDay[day] = bucket

    const usage = entry.usage ?? {}
    const counters = {
      requests: 1,
      errors: entry.status >= 400 || entry.error ? 1 : 0,
      promptTokens: Number(usage.prompt ?? 0) || 0,
      completionTokens: Number(usage.completion ?? 0) || 0,
      totalTokens: Number(usage.total ?? 0) || 0,
      cachedTokens: Number(usage.cached ?? 0) || 0,
      reasoningTokens: Number(usage.reasoning ?? 0) || 0,
    }

    addCounter(bucket, counters)
    bumpMap(bucket.models, entry.model, entry.model, counters)
    bumpMap(bucket.accounts, entry.accountId, entry.accountName, counters)
    bumpMap(bucket.keys, entry.keyId, entry.keyName, counters)

    const row = {
      ts,
      model: String(entry.model ?? ''),
      provider: String(entry.provider ?? ''),
      accountId: String(entry.accountId ?? ''),
      accountName: String(entry.accountName ?? ''),
      keyId: String(entry.keyId ?? ''),
      keyName: String(entry.keyName ?? ''),
      status: Number(entry.status ?? 0),
      error: entry.error ? String(entry.error).slice(0, 300) : '',
      ms: Number(entry.ms ?? 0),
      stream: entry.stream === true,
      attempts: Number(entry.attempts ?? 1),
      promptTokens: counters.promptTokens,
      completionTokens: counters.completionTokens,
      totalTokens: counters.totalTokens,
      cachedTokens: counters.cachedTokens,
      reasoningTokens: counters.reasoningTokens,
    }
    data.recent.unshift(row)
    if (data.recent.length > RECENT_LIMIT) data.recent.length = RECENT_LIMIT
    save()
    return row
  }

  function range(days = 7) {
    const span = Math.max(1, Math.min(RETENTION_DAYS, Number(days) || 7))
    const startTs = Date.now() - span * 86_400_000
    const from = dayKey(startTs)
    const to = dayKey()
    const totals = emptyCounters()
    const byModel = new Map()
    const byAccount = new Map()
    const byKey = new Map()
    const series = []
    const seriesMap = new Map()

    for (let offset = span - 1; offset >= 0; offset -= 1) {
      const key = dayKey(Date.now() - offset * 86_400_000)
      const point = { date: key, ...emptyCounters() }
      seriesMap.set(key, point)
      series.push(point)
    }

    for (const [day, bucket] of Object.entries(data.byDay)) {
      if (day < from || day > to) continue
      const point = seriesMap.get(day)
      if (point !== undefined) addCounter(point, bucket)
      addCounter(totals, bucket)
      for (const [id, entry] of Object.entries(bucket.models ?? {})) {
        bumpMap(byModel, id, entry.name, entry)
      }
      for (const [id, entry] of Object.entries(bucket.accounts ?? {})) {
        bumpMap(byAccount, id, entry.name, entry)
      }
      for (const [id, entry] of Object.entries(bucket.keys ?? {})) {
        bumpMap(byKey, id, entry.name, entry)
      }
    }

    const asRows = (map) => [...map.entries()]
      .map(([id, entry]) => ({ id, ...entry }))
      .sort((left, right) => right.totalTokens - left.totalTokens || right.requests - left.requests)

    return {
      days: span,
      from,
      to,
      totals,
      series,
      byModel: asRows(byModel),
      byAccount: asRows(byAccount),
      byKey: asRows(byKey),
      recent: data.recent.filter((row) => row.ts >= startTs).slice(0, 100),
    }
  }

  /** All-time counters for one model/account/key. */
  function lifetime(kind, id) {
    const mapKey = kind === 'model' ? 'models' : kind === 'account' ? 'accounts' : 'keys'
    const result = emptyCounters()
    for (const bucket of Object.values(data.byDay)) {
      const entry = bucket?.[mapKey]?.[id]
      if (entry) addCounter(result, entry)
    }
    return result
  }

  function today() {
    return data.byDay[dayKey()] ?? emptyBucket()
  }

  function allTime() {
    const totals = emptyCounters()
    for (const bucket of Object.values(data.byDay)) addCounter(totals, bucket)
    return totals
  }

  return { file, record, range, lifetime, today, allTime, flush: saveNow, data }
}
