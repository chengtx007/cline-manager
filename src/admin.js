import { chatCompletion } from './cline.js'
import { isAuthenticationError, unwrapEnvelope } from './protocol.js'
import { newId } from './store.js'
import {
  boolOr,
  errorText,
  intOr,
  maskSecret,
  parseBearer,
  randomToken,
  readJSONBody,
  safeEqual,
  sendJSON,
  sha256,
} from './util.js'

export function createAdmin({ store, pool, usage, models, stats, log, adminToken }) {
  const config = () => store.config

  /** Keep only the first few characters, enough to tell accounts apart. */
  function maskAccountName(name) {
    const value = String(name ?? '').trim()
    if (value.length <= 1) return '***'
    const keep = Math.min(4, Math.max(1, Math.floor(value.length / 2)))
    return `${value.slice(0, keep)}***`
  }

  function authorized(req) {
    const given = parseBearer(req) || String(req.headers['x-admin-token'] ?? '').trim()
    return given.length > 0 && safeEqual(given, adminToken)
  }

  function accountView(account) {
    const quota = usage.get(account.id)
    return {
      id: account.id,
      name: account.name,
      hint: maskSecret(account.apiKey),
      enabled: account.enabled !== false,
      baseURL: account.baseURL ?? '',
      maxConcurrent: Number(account.maxConcurrent ?? 16),
      createdAt: account.createdAt ?? 0,
      quota: quota ? {
        ok: quota.ok === true,
        at: quota.at,
        limits: quota.limits ?? [],
        error: quota.error ?? '',
        profile: quota.profile ?? null,
        plan: quota.plan ?? null,
        daily: quota.daily ?? null,
      } : null,
      cooling: pool.snapshot()[account.id] ?? null,
      stats: stats.lifetime('account', account.id),
    }
  }

  function keyView(key) {
    return {
      id: key.id,
      name: key.name,
      hint: key.hint,
      enabled: key.enabled !== false,
      createdAt: key.createdAt ?? 0,
      stats: stats.lifetime('key', key.id),
    }
  }

  function settingsView() {
    const current = config()
    return {
      baseURL: current.upstream.baseURL,
      accountMode: current.accountMode,
      activeAccountId: current.activeAccountId,
      effectiveAccountId: pool.effectiveId(),
      allowUnknownModels: current.server.allowUnknownModels === true,
      cors: current.server.cors === true,
      publicDashboard: current.publicDashboard === true,
      quotaGuard: { ...current.quotaGuard },
      cooldown: { ...current.cooldown },
      timeouts: {
        connectTimeoutMs: current.upstream.connectTimeoutMs,
        requestTimeoutMs: current.upstream.requestTimeoutMs,
        idleTimeoutMs: current.upstream.idleTimeoutMs,
      },
    }
  }

  function stateView() {
    const current = config()
    const today = stats.today()
    return {
      version: '1.0.0',
      settings: settingsView(),
      accounts: current.accounts.map(accountView),
      models: models.list(),
      keys: current.requestKeys.map(keyView),
      overview: {
        today: {
          requests: today.requests,
          errors: today.errors,
          promptTokens: today.promptTokens,
          completionTokens: today.completionTokens,
          totalTokens: today.totalTokens,
        },
        total: stats.allTime(),
        recent: stats.range(7).recent.slice(0, 20),
      },
    }
  }

  /**
   * The unauthenticated snapshot behind /public. It deliberately contains no
   * account ids, key hints, upstream URLs, request rows or full account names:
   * everything here is shown to anyone who can open the page.
   */
  function publicView() {
    const today = stats.today()
    const cooling = pool.snapshot()
    const now = Date.now()
    const accounts = config().accounts.map((account) => {
      const quota = usage.get(account.id)
      const cool = cooling[account.id]
      const coolingActive = cool !== undefined && Number(cool.until ?? 0) > now
      const enabled = account.enabled !== false
      return {
        name: maskAccountName(account.name),
        enabled,
        status: !enabled ? 'disabled' : coolingActive ? 'cooling' : 'active',
        cooling: coolingActive ? { code: String(cool.code ?? ''), until: Number(cool.until ?? 0) } : null,
        quota: quota && quota.ok === true
          ? {
              at: Number(quota.at ?? 0),
              limits: (quota.limits ?? []).map((limit) => ({
                type: String(limit.type ?? ''),
                percentUsed: Math.max(0, Math.min(100, Number(limit.percentUsed) || 0)),
                resetsAt: String(limit.resetsAt ?? ''),
              })),
            }
          : null,
      }
    })
    return {
      enabled: true,
      generatedAt: now,
      today: {
        requests: today.requests,
        errors: today.errors,
        promptTokens: today.promptTokens,
        completionTokens: today.completionTokens,
        totalTokens: today.totalTokens,
        cachedTokens: today.cachedTokens,
        reasoningTokens: today.reasoningTokens,
      },
      summary: {
        accounts: accounts.length,
        active: accounts.filter((entry) => entry.status === 'active').length,
        cooling: accounts.filter((entry) => entry.status === 'cooling').length,
        disabled: accounts.filter((entry) => entry.status === 'disabled').length,
      },
      accounts,
    }
  }

  function accountOf(id) {
    const account = config().accounts.find((entry) => entry.id === id)
    if (account === undefined) {
      const error = new Error('account not found')
      error.status = 404
      throw error
    }
    return account
  }

  function modelExists(id) {
    if (!config().models.known.includes(id)) {
      const error = new Error('model not found')
      error.status = 404
      throw error
    }
  }

  async function testAccount(account, model) {
    const target = model || config().models.enabled[0] || 'cline-pass/glm-5.3'
    const started = Date.now()
    try {
      const result = await chatCompletion({
        baseURL: account.baseURL || config().upstream.baseURL,
        apiKey: account.apiKey,
        body: { model: target, messages: [{ role: 'user', content: 'Say OK' }], max_tokens: 512 },
        timeoutMs: Number(config().upstream.connectTimeoutMs ?? 60_000),
      })
      const payload = unwrapEnvelope(result.json)
      const message = errorText(payload?.error) || String(payload?.message ?? '') || (result.ok ? '' : String(result.text ?? '').slice(0, 400)) || (result.ok ? '' : `HTTP ${result.status}`)
      if (isAuthenticationError(message, result.status)) {
        return { ok: false, authorized: false, model: target, status: result.status, ms: Date.now() - started, error: message || `HTTP ${result.status}` }
      }
      const hasCompletion = result.ok && Array.isArray(payload?.choices) && payload.choices.length > 0
      const modelRefusal = payload?.error !== undefined && ([402, 429].includes(result.status) || /empty response content|model|context|max[_ -]?tokens|reasoning|no (?:allowed|available) providers/i.test(message))
      const authorized = hasCompletion || modelRefusal
      return {
        ok: authorized,
        authorized,
        model: target,
        status: result.status,
        ms: Date.now() - started,
        error: authorized && hasCompletion ? '' : message || '网关没有返回补全，无法验证鉴权',
      }
    } catch (error) {
      return { ok: false, authorized: false, model: target, status: 0, ms: Date.now() - started, error: String(error?.message ?? error) }
    }
  }

  async function handle(req, res, segments, url) {
    if (authorized(req) !== true) {
      sendJSON(res, 401, { error: 'unauthorized', message: '管理员令牌无效' })
      return
    }

    const method = req.method
    const [root, id, action] = segments
    const body = method === 'GET' || method === 'DELETE' ? {} : await readJSONBody(req)

    // ── state ────────────────────────────────────────────────────────────────
    if (root === 'state' && method === 'GET') {
      sendJSON(res, 200, stateView())
      return
    }

    if (root === 'settings' && method === 'PATCH') {
      store.update((next) => {
        if (body.accountMode !== undefined) next.accountMode = body.accountMode === 'roundrobin' ? 'roundrobin' : 'single'
        if (body.activeAccountId !== undefined) next.activeAccountId = String(body.activeAccountId)
        if (body.allowUnknownModels !== undefined) next.server.allowUnknownModels = boolOr(body.allowUnknownModels, next.server.allowUnknownModels)
        if (body.cors !== undefined) next.server.cors = boolOr(body.cors, next.server.cors)
        if (body.publicDashboard !== undefined) next.publicDashboard = boolOr(body.publicDashboard, next.publicDashboard === true)
        if (body.baseURL !== undefined && String(body.baseURL).trim()) next.upstream.baseURL = String(body.baseURL).trim().replace(/\/+$/, '')
        if (body.quotaGuard && typeof body.quotaGuard === 'object') {
          next.quotaGuard.enabled = boolOr(body.quotaGuard.enabled, next.quotaGuard.enabled)
          next.quotaGuard.threshold = intOr(body.quotaGuard.threshold, next.quotaGuard.threshold, { min: 1, max: 100 })
          next.quotaGuard.refreshMs = intOr(body.quotaGuard.refreshMs, next.quotaGuard.refreshMs, { min: 30_000, max: 3_600_000 })
        }
        if (body.cooldown && typeof body.cooldown === 'object') {
          next.cooldown.quotaMs = intOr(body.cooldown.quotaMs, next.cooldown.quotaMs, { min: 0, max: 86_400_000 })
          next.cooldown.authMs = intOr(body.cooldown.authMs, next.cooldown.authMs, { min: 0, max: 86_400_000 })
          next.cooldown.rateLimitMs = intOr(body.cooldown.rateLimitMs, next.cooldown.rateLimitMs, { min: 0, max: 86_400_000 })
        }
        if (body.timeouts && typeof body.timeouts === 'object') {
          next.upstream.connectTimeoutMs = intOr(body.timeouts.connectTimeoutMs, next.upstream.connectTimeoutMs, { min: 5000, max: 600_000 })
          next.upstream.requestTimeoutMs = intOr(body.timeouts.requestTimeoutMs, next.upstream.requestTimeoutMs, { min: 10_000, max: 3_600_000 })
          next.upstream.idleTimeoutMs = intOr(body.timeouts.idleTimeoutMs, next.upstream.idleTimeoutMs, { min: 10_000, max: 3_600_000 })
        }
      })
      usage.start()
      sendJSON(res, 200, { settings: settingsView() })
      return
    }

    // ── accounts ─────────────────────────────────────────────────────────────
    if (root === 'accounts') {
      if (method === 'POST' && id === undefined) {
        const apiKey = String(body.apiKey ?? '').trim()
        if (!apiKey) throw Object.assign(new Error('apiKey is required'), { status: 400 })
        const account = {
          id: newId('acc'),
          name: String(body.name ?? '').trim() || `account-${config().accounts.length + 1}`,
          apiKey,
          baseURL: String(body.baseURL ?? '').trim(),
          enabled: boolOr(body.enabled, true),
          maxConcurrent: intOr(body.maxConcurrent, 16, { min: 0, max: 512 }),
          createdAt: Date.now(),
        }
        store.update((next) => {
          next.accounts.push(account)
        })
        sendJSON(res, 201, { account: accountView(account) })
        usage.refresh(account, { withProfile: true }).catch(() => {})
        return
      }

      if (id !== undefined && action === undefined) {
        const account = accountOf(id)
        if (method === 'PATCH') {
          store.update((next) => {
            const target = next.accounts.find((entry) => entry.id === id)
            if (body.name !== undefined) target.name = String(body.name).trim() || target.name
            if (body.apiKey !== undefined && String(body.apiKey).trim() !== '') target.apiKey = String(body.apiKey).trim()
            if (body.baseURL !== undefined) target.baseURL = String(body.baseURL).trim()
            if (body.enabled !== undefined) target.enabled = boolOr(body.enabled, target.enabled)
            if (body.maxConcurrent !== undefined) target.maxConcurrent = intOr(body.maxConcurrent, target.maxConcurrent, { min: 0, max: 512 })
            if (target.enabled === false && next.activeAccountId === id) next.activeAccountId = ''
          })
          usage.refresh(account, { withProfile: true }).catch(() => {})
          pool.clearCooldown(id)
          sendJSON(res, 200, { account: accountView(account) })
          return
        }
        if (method === 'DELETE') {
          if (config().accounts.length <= 1) throw Object.assign(new Error('至少保留一个账户'), { status: 400 })
          store.update((next) => {
            next.accounts = next.accounts.filter((entry) => entry.id !== id)
            if (next.activeAccountId === id) next.activeAccountId = ''
          })
          pool.clearCooldown(id)
          sendJSON(res, 200, { ok: true, state: stateView() })
          return
        }
      }

      if (id !== undefined && action === 'test' && method === 'POST') {
        const account = accountOf(id)
        const result = await testAccount(account, body.model)
        sendJSON(res, 200, result)
        return
      }

      if (id !== undefined && action === 'usage' && method === 'POST') {
        const account = accountOf(id)
        const quota = await usage.refresh(account, { days: intOr(body.days, 0, { min: 0, max: 90 }), withProfile: true })
        pool.clearCooldown(id)
        sendJSON(res, 200, { account: accountView(account), quota })
        return
      }

      if (id !== undefined && action === 'cooldown' && method === 'DELETE') {
        pool.clearCooldown(id)
        sendJSON(res, 200, { ok: true })
        return
      }
    }

    // ── request keys ─────────────────────────────────────────────────────────
    if (root === 'keys') {
      if (method === 'POST' && id === undefined) {
        const key = randomToken(24, 'sk-cline-')
        const record = {
          id: newId('key'),
          name: String(body.name ?? '').trim() || `key-${config().requestKeys.length + 1}`,
          keyHash: sha256(key),
          hint: maskSecret(key),
          enabled: true,
          createdAt: Date.now(),
        }
        store.update((next) => {
          next.requestKeys.push(record)
        })
        sendJSON(res, 201, { key, record: keyView(record) })
        return
      }
      if (id !== undefined && method === 'PATCH') {
        const target = config().requestKeys.find((entry) => entry.id === id)
        if (target === undefined) throw Object.assign(new Error('key not found'), { status: 404 })
        store.update((next) => {
          const entry = next.requestKeys.find((item) => item.id === id)
          if (body.name !== undefined) entry.name = String(body.name).trim() || entry.name
          if (body.enabled !== undefined) entry.enabled = boolOr(body.enabled, entry.enabled)
        })
        sendJSON(res, 200, { record: keyView(target) })
        return
      }
      if (id !== undefined && method === 'DELETE') {
        const enabled = config().requestKeys.filter((entry) => entry.enabled !== false)
        const target = config().requestKeys.find((entry) => entry.id === id)
        if (target === undefined) throw Object.assign(new Error('key not found'), { status: 404 })
        if (enabled.length <= 1 && target.enabled !== false) throw Object.assign(new Error('至少保留一个启用的接入密钥'), { status: 400 })
        store.update((next) => {
          next.requestKeys = next.requestKeys.filter((entry) => entry.id !== id)
        })
        sendJSON(res, 200, { ok: true })
        return
      }
    }

    // ── models & pins ────────────────────────────────────────────────────────
    if (root === 'models') {
      if (method === 'GET' && id === undefined) {
        sendJSON(res, 200, { models: models.list() })
        return
      }
      if (method === 'POST' && id === undefined) {
        sendJSON(res, 201, { model: models.addModel(body.id, { enabled: boolOr(body.enabled, true), name: body.name }) })
        return
      }
      if (id === 'refresh' && method === 'POST') {
        const result = await models.refreshCatalog()
        sendJSON(res, 200, { ...result, models: models.list() })
        return
      }
      if (id !== undefined && action === undefined) {
        if (method === 'PATCH') {
          modelExists(id)
          if (body.enabled !== undefined) models.setVisibility(id, boolOr(body.enabled, true))
          if (body.pin !== undefined) models.setPin(id, body.pin)
          if (body.name !== undefined) {
            store.update((next) => {
              next.models.discovered[id] = { ...(next.models.discovered[id] ?? {}), name: String(body.name) }
            })
          }
          sendJSON(res, 200, { model: models.list().find((entry) => entry.id === id) })
          return
        }
        if (method === 'DELETE') {
          models.removeModel(id)
          sendJSON(res, 200, { ok: true })
          return
        }
      }
      if (id !== undefined && action === 'probe' && method === 'POST') {
        modelExists(id)
        const result = await models.probe(id)
        sendJSON(res, 200, { result, model: models.list().find((entry) => entry.id === id) })
        return
      }
      if (id !== undefined && action === 'validate' && method === 'POST') {
        modelExists(id)
        const result = await models.validate(id, Array.isArray(body.upstreams) ? body.upstreams : undefined)
        sendJSON(res, 200, { ...result, model: models.list().find((entry) => entry.id === id) })
        return
      }
      if (id !== undefined && action === 'test' && method === 'POST') {
        modelExists(id)
        const result = await models.testPin(id)
        sendJSON(res, 200, { ...result, model: models.list().find((entry) => entry.id === id) })
        return
      }
    }

    // ── stats ────────────────────────────────────────────────────────────────
    if (root === 'stats' && method === 'GET') {
      const days = intOr(url?.searchParams?.get('days'), 7, { min: 1, max: 400 })
      sendJSON(res, 200, stats.range(days))
      return
    }

    if (root === 'logs' && method === 'GET') {
      const limit = intOr(url?.searchParams?.get('limit'), 100, { min: 1, max: 500 })
      sendJSON(res, 200, { recent: stats.range(400).recent.slice(0, limit) })
      return
    }

    sendJSON(res, 404, { error: 'not_found' })
  }

  return { handle, stateView, publicView, accountView, keyView, adminToken }
}
