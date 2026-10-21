import path from 'node:path'
import { atomicWriteJSON, ensureDir, maskSecret, randomToken, readJSONFile, sha256 } from './util.js'

/** Subscription models known at release time; a live scan extends this list. */
export const DEFAULT_MODELS = [
  'cline-pass/glm-5.3-flash',
  'cline-pass/kimi-k3',
  'cline-pass/deepseek-v4-flash',
  'cline-pass/deepseek-v4.1-flash',
  'cline-pass/qwen3.8-max',
  'cline-pass/minimax-m3',
  'cline-pass/glm-5.3',
  'cline-pass/glm-5.2',
  'cline-pass/deepseek-v4-pro',
  'cline-pass/mimo-v2.5-pro',
  'cline-pass/mimo-v2.5',
  'cline-pass/kimi-k2.6',
  'cline-pass/qwen3.7-plus',
  'cline-pass/kimi-k2.7-code',
  'cline-pass/qwen3.7-max',
]

export const DEFAULT_BASE_URL = 'https://api.cline.bot/api/v1'

export function newId(prefix) {
  return `${prefix}_${randomToken(4)}`
}

export function defaultConfig() {
  return {
    version: 1,
    server: {
      host: '0.0.0.0',
      port: 8787,
      adminToken: '',
      cors: true,
      allowUnknownModels: true,
    },
    upstream: {
      baseURL: DEFAULT_BASE_URL,
      recommendedURL: 'https://api.cline.bot/api/v1/ai/cline/recommended-models',
      connectTimeoutMs: 60000,
      requestTimeoutMs: 180000,
      idleTimeoutMs: 300000,
    },
    accounts: [],
    accountMode: 'roundrobin',
    activeAccountId: '',
    cooldown: {
      quotaMs: 15 * 60_000,
      authMs: 30 * 60_000,
      rateLimitMs: 60_000,
    },
    quotaGuard: {
      enabled: true,
      threshold: 100,
      refreshMs: 5 * 60_000,
    },
    requestKeys: [],
    models: {
      known: [...DEFAULT_MODELS],
      enabled: [...DEFAULT_MODELS],
      pins: {},
      discovered: {},
    },
  }
}

function coerceConfig(raw) {
  const base = defaultConfig()
  const config = { ...base, ...(raw && typeof raw === 'object' ? raw : {}) }
  config.server = { ...base.server, ...(raw?.server ?? {}) }
  config.upstream = { ...base.upstream, ...(raw?.upstream ?? {}) }
  config.cooldown = { ...base.cooldown, ...(raw?.cooldown ?? {}) }
  config.quotaGuard = { ...base.quotaGuard, ...(raw?.quotaGuard ?? {}) }
  config.accounts = Array.isArray(raw?.accounts) ? raw.accounts : []
  config.requestKeys = Array.isArray(raw?.requestKeys) ? raw.requestKeys : []
  const models = raw?.models ?? {}
  const known = Array.isArray(models.known) && models.known.length > 0 ? [...new Set(models.known.map(String))] : [...DEFAULT_MODELS]
  config.models = {
    known,
    enabled: Array.isArray(models.enabled) ? [...new Set(models.enabled.map(String))] : [...known],
    pins: models.pins && typeof models.pins === 'object' ? models.pins : {},
    discovered: models.discovered && typeof models.discovered === 'object' ? models.discovered : {},
  }
  // A model can only be enabled while it is known.
  config.models.enabled = config.models.enabled.filter((id) => config.models.known.includes(id))
  config.accountMode = config.accountMode === 'roundrobin' ? 'roundrobin' : 'single'
  return config
}

/**
 * Config store: one JSON document, atomic writes, debounced persistence.
 * Derived runtime data (stats, quota readings) lives elsewhere.
 */
export function createStore({ dataDir, env = process.env } = {}) {
  ensureDir(dataDir)
  const file = path.join(dataDir, 'config.json')
  const raw = readJSONFile(file, null)
  const config = coerceConfig(raw)
  let createdAdminToken = ''
  let createdKey = ''

  if (env.ADMIN_TOKEN) {
    if (config.server.adminToken !== env.ADMIN_TOKEN) {
      config.server.adminToken = env.ADMIN_TOKEN
      createdAdminToken = ''
    }
  } else if (!config.server.adminToken) {
    config.server.adminToken = randomToken(24, 'atk-')
    createdAdminToken = config.server.adminToken
  }

  if (env.CLINE_BASE_URL) {
    config.upstream.baseURL = String(env.CLINE_BASE_URL).trim().replace(/\/+$/, '')
  }
  if (env.CLINE_RECOMMENDED_URL) {
    config.upstream.recommendedURL = String(env.CLINE_RECOMMENDED_URL).trim()
  }

  if (config.requestKeys.length === 0) {
    const fixed = String(env.GATEWAY_API_KEY ?? '').trim()
    const key = fixed || randomToken(24, 'sk-cline-')
    config.requestKeys.push({
      id: newId('key'),
      name: fixed ? 'env' : 'default',
      keyHash: sha256(key),
      hint: maskSecret(key),
      enabled: true,
      createdAt: Date.now(),
    })
    if (!fixed) createdKey = key
  }

  for (const account of config.accounts) {
    if (!account.id) account.id = newId('acc')
    account.enabled = account.enabled !== false
    if (!Number.isFinite(account.maxConcurrent)) account.maxConcurrent = 16
  }

  let timer = null
  const saveNow = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    atomicWriteJSON(file, config)
  }
  const save = () => {
    if (timer !== null) return
    timer = setTimeout(() => {
      timer = null
      atomicWriteJSON(file, config)
    }, 250)
    timer.unref?.()
  }

  saveNow()

  return {
    config,
    dataDir,
    file,
    save,
    flush: saveNow,
    bootstrap: { createdAdminToken, createdKey },
    /** Apply a mutation and persist it. */
    update(mutator) {
      mutator(config)
      save()
      return config
    },
  }
}
