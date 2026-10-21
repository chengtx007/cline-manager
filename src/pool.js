/**
 * Account pool: round-robin or single-active selection, quota pre-checks,
 * cooldowns after account-level refusals, and per-account stream slots.
 *
 * The failover contract matches dsh-cline-pass: an account is only abandoned
 * while nothing has been delivered. A spent window or a revoked key moves the
 * request to another account and starts its pin chain over.
 */
export function createAccountPool({ store, usage, log }) {
  /** account id -> { until, code, at } */
  const cooling = new Map()
  /** account id -> { active, limit, queue } */
  const slots = new Map()
  let cursor = 0

  const enabledAccounts = () => store.config.accounts.filter((account) => account.enabled && account.apiKey)

  function isCooling(accountId, now = Date.now()) {
    return (cooling.get(accountId)?.until ?? 0) > now
  }

  function quotaThreshold() {
    return Number(store.config.quotaGuard.threshold ?? 100)
  }

  function quotaBlocked(account) {
    if (store.config.quotaGuard.enabled !== true) return false
    return usage.blocked(account.id, quotaThreshold())
  }

  /**
   * Accounts in preference order, with the cooling and quota rules applied.
   * `exclude` holds accounts this request already got a refusal from.
   */
  function ordered(exclude = [], { advance = true } = {}) {
    const skip = new Set(exclude)
    let candidates = enabledAccounts().filter((account) => !skip.has(account.id))
    if (candidates.length === 0) return []

    const now = Date.now()
    const warm = candidates.filter((account) => !isCooling(account.id, now))
    if (warm.length > 0) candidates = warm
    else candidates = [...candidates].sort((left, right) => (cooling.get(left.id)?.until ?? 0) - (cooling.get(right.id)?.until ?? 0))

    const config = store.config
    if (config.accountMode === 'roundrobin') {
      const index = cursor % candidates.length
      if (advance) cursor = (cursor + 1) % 1_000_000_000
      candidates = [...candidates.slice(index), ...candidates.slice(0, index)]
    } else {
      const active = candidates.find((account) => account.id === config.activeAccountId)
      if (active !== undefined) candidates = [active, ...candidates.filter((account) => account !== active)]
    }

    // A spent window only decides whom to try first; if every account looks
    // spent (stale reading, reset already passed), trying is still better than
    // refusing locally.
    const healthy = candidates.filter((account) => !quotaBlocked(account))
    return healthy.length > 0 ? healthy : candidates
  }

  function pick({ exclude = [], advance = true } = {}) {
    return ordered(exclude, { advance })[0] ?? null
  }

  function peek() {
    return pick({ exclude: [], advance: false })
  }

  function peekAny() {
    return enabledAccounts()[0] ?? null
  }

  function effectiveId() {
    return peek()?.id ?? ''
  }

  /** Stand an account down for a while after an account-level refusal. */
  function noteFailure(accountId, code) {
    const config = store.config
    let wait = 0
    if (code === 'QUOTA') wait = Number(config.cooldown.quotaMs ?? 900_000)
    else if (code === 'AUTH') wait = Number(config.cooldown.authMs ?? 1_800_000)
    else if (code === 'RATE_LIMIT') wait = Number(config.cooldown.rateLimitMs ?? 60_000)
    if (wait <= 0) return

    if (code === 'QUOTA') {
      const reset = usage.blockedUntil(accountId, quotaThreshold())
      if (reset > Date.now() && reset !== Number.MAX_SAFE_INTEGER) wait = Math.max(wait, reset - Date.now())
    }
    cooling.set(accountId, { until: Date.now() + wait, code, at: Date.now() })
    log?.warn?.(`account ${accountId} stood down for ${Math.round(wait / 1000)}s after ${code}`)
  }

  function clearCooldown(accountId) {
    cooling.delete(accountId)
  }

  function snapshot() {
    return Object.fromEntries([...cooling.entries()].map(([id, entry]) => [id, { ...entry }]))
  }

  /** Per-account concurrency slots, held for the whole upstream stream. */
  function acquire(account, signal) {
    const limit = Number(account.maxConcurrent ?? 16)
    if (!Number.isFinite(limit) || limit <= 0) return Promise.resolve(() => {})
    signal?.throwIfAborted?.()
    let pool = slots.get(account.id)
    if (pool === undefined) {
      pool = { active: 0, limit, queue: [] }
      slots.set(account.id, pool)
    }
    pool.limit = Math.max(1, Math.floor(limit))

    const hold = () => {
      let held = true
      const release = () => {
        if (!held) return
        held = false
        signal?.removeEventListener?.('abort', release)
        pool.active -= 1
        admit()
      }
      signal?.addEventListener?.('abort', release, { once: true })
      return release
    }

    const admit = () => {
      while (pool.queue.length > 0 && pool.active < pool.limit) {
        pool.active += 1
        const grant = pool.queue.shift()
        grant()
      }
    }

    admit()
    if (pool.active < pool.limit && pool.queue.length === 0) {
      pool.active += 1
      return Promise.resolve(hold())
    }

    return new Promise((resolve, reject) => {
      const waiter = () => {
        signal?.removeEventListener?.('abort', abandon)
        resolve(hold())
      }
      const abandon = () => {
        const index = pool.queue.indexOf(waiter)
        if (index >= 0) pool.queue.splice(index, 1)
        reject(signal?.reason ?? new Error('aborted'))
      }
      signal?.addEventListener?.('abort', abandon, { once: true })
      pool.queue.push(waiter)
    })
  }

  return {
    ordered,
    pick,
    peek,
    peekAny,
    effectiveId,
    noteFailure,
    clearCooldown,
    isCooling,
    snapshot,
    acquire,
  }
}
