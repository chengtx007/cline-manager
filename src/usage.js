import { fetchDailyUsage, fetchPlan, fetchProfile, fetchUsageLimits } from './cline.js'
import { utcDayKey } from './util.js'

/**
 * Per-account quota readings. Cline's quota is per account, so every reading
 * carries the account it belongs to.
 */
export function createUsageCache({ store, log }) {
  /** @type {Map<string, object>} */
  const cache = new Map()
  let timer = null
  let running = false

  const baseURLOf = (account) => String(account.baseURL || store.config.upstream.baseURL || '')

  function emptyEntry(account) {
    return {
      accountId: account.id,
      at: 0,
      ok: false,
      limits: [],
      error: 'not read yet',
      profile: null,
      plan: null,
      daily: null,
      userId: '',
    }
  }

  async function refresh(account, { days = 0, withProfile = false } = {}) {
    const previous = cache.get(account.id) ?? emptyEntry(account)
    const next = { ...previous, accountId: account.id }
    if (!account.apiKey) {
      Object.assign(next, { at: Date.now(), ok: false, limits: [], error: '未配置 API Key' })
      cache.set(account.id, next)
      return next
    }
    const limits = await fetchUsageLimits({ baseURL: baseURLOf(account), apiKey: account.apiKey })
    Object.assign(next, { at: Date.now(), ok: limits.ok, limits: limits.limits, error: limits.error })

    if (withProfile || days > 0) {
      const profile = await fetchProfile({ baseURL: baseURLOf(account), apiKey: account.apiKey })
      if (profile.ok) {
        next.profile = profile.profile
        next.userId = profile.profile?.id ?? ''
      } else if (!next.profile) {
        next.profile = null
      }
      const plan = await fetchPlan({ baseURL: baseURLOf(account), apiKey: account.apiKey })
      if (plan.ok) next.plan = plan.plan
    }

    if (days > 0 && next.userId) {
      const endDate = utcDayKey()
      const startDate = utcDayKey(Date.now() - Math.max(0, days - 1) * 86_400_000)
      const daily = await fetchDailyUsage({
        baseURL: baseURLOf(account),
        apiKey: account.apiKey,
        userId: next.userId,
        startDate,
        endDate,
      })
      next.daily = { at: Date.now(), days, ...daily }
    }

    cache.set(account.id, next)
    return next
  }

  /** Refresh every enabled account with concurrency 4. */
  async function refreshAll() {
    if (running) return
    running = true
    try {
      const accounts = store.config.accounts.filter((account) => account.enabled && account.apiKey)
      for (let index = 0; index < accounts.length; index += 4) {
        await Promise.all(accounts.slice(index, index + 4).map((account) => refresh(account).catch((error) => {
          log?.warn?.(`quota refresh failed for ${account.name}: ${error?.message ?? error}`)
        })))
      }
    } finally {
      running = false
    }
  }

  function start() {
    stop()
    const interval = Math.max(30_000, Number(store.config.quotaGuard.refreshMs ?? 300_000))
    timer = setInterval(() => {
      if (store.config.quotaGuard.enabled) refreshAll().catch(() => {})
    }, interval)
    timer.unref?.()
    refreshAll().catch(() => {})
  }

  function stop() {
    if (timer !== null) {
      clearInterval(timer)
      timer = null
    }
  }

  function get(accountId) {
    return cache.get(accountId) ?? null
  }

  function snapshot() {
    return Object.fromEntries(cache.entries())
  }

  function resetTime(entry, threshold) {
    const now = Date.now()
    let earliest = 0
    for (const limit of entry?.limits ?? []) {
      if (Number(limit.percentUsed) < threshold) continue
      const reset = Date.parse(limit.resetsAt)
      if (Number.isFinite(reset) && reset <= now) continue
      if (earliest === 0 || (Number.isFinite(reset) && reset < earliest)) earliest = Number.isFinite(reset) ? reset : Number.MAX_SAFE_INTEGER
    }
    return earliest
  }

  /** Whether the last reading says a window is spent (reset time still ahead). */
  function blocked(accountId, threshold = 100) {
    const entry = cache.get(accountId)
    if (!entry || entry.ok !== true || entry.limits.length === 0) return false
    return resetTime(entry, threshold) !== 0
  }

  function blockedUntil(accountId, threshold = 100) {
    return resetTime(cache.get(accountId), threshold)
  }

  return { refresh, refreshAll, start, stop, get, snapshot, blocked, blockedUntil, baseURLOf }
}
