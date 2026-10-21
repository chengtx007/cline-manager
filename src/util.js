import crypto from 'node:crypto'
import fs from 'node:fs'
import path from 'node:path'

/** Generate a URL-safe random secret. */
export function randomToken(bytes = 24, prefix = '') {
  return `${prefix}${crypto.randomBytes(bytes).toString('hex')}`
}

export function sha256(value) {
  return crypto.createHash('sha256').update(String(value)).digest('hex')
}

/** Constant-time comparison that also hides length differences. */
export function safeEqual(left, right) {
  return crypto.timingSafeEqual(
    crypto.createHash('sha256').update(String(left ?? '')).digest(),
    crypto.createHash('sha256').update(String(right ?? '')).digest(),
  )
}

export function maskSecret(value) {
  const key = String(value ?? '')
  if (key.length === 0) return ''
  if (key.length <= 12) return `${key.slice(0, 3)}…${key.slice(-2)}`
  return `${key.slice(0, 7)}…${key.slice(-4)}`
}

export function parseBearer(req) {
  const header = String(req.headers.authorization ?? '')
  if (/^bearer\s+/i.test(header)) return header.replace(/^bearer\s+/i, '').trim()
  const apiKey = req.headers['x-api-key']
  return typeof apiKey === 'string' ? apiKey.trim() : ''
}

export function withTimeout(signal, timeoutMs) {
  const signals = []
  if (Number.isFinite(timeoutMs) && timeoutMs > 0) signals.push(AbortSignal.timeout(timeoutMs))
  if (signal !== undefined && signal !== null) signals.push(signal)
  if (signals.length === 0) return undefined
  return signals.length === 1 ? signals[0] : AbortSignal.any(signals)
}

export function trimBase(baseURL) {
  return String(baseURL ?? '').trim().replace(/\/+$/, '')
}

/** Local calendar day, used for the local usage buckets. */
export function dayKey(ts = Date.now()) {
  const date = new Date(ts)
  const pad = (value) => String(value).padStart(2, '0')
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

export function dayKeyOffset(days, from = Date.now()) {
  return dayKey(from - days * 86_400_000)
}

/** UTC calendar day, the spelling Cline's daily usage endpoint expects. */
export function utcDayKey(ts = Date.now()) {
  return new Date(ts).toISOString().slice(0, 10)
}

export function ensureDir(dir) {
  fs.mkdirSync(dir, { recursive: true })
}

/** Write JSON atomically so a crash never leaves a half-written config. */
export function atomicWriteJSON(file, value) {
  ensureDir(path.dirname(file))
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`
  fs.writeFileSync(tmp, JSON.stringify(value, null, 2), { encoding: 'utf8', mode: 0o600 })
  fs.renameSync(tmp, file)
  try {
    fs.chmodSync(file, 0o600)
  } catch { /* best effort on platforms without POSIX modes */ }
}

export function readJSONFile(file, fallback) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return fallback
  }
}

export function sendJSON(res, status, payload, headers = {}) {
  if (res.headersSent || res.writableEnded) return
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'Content-Type': 'application/json; charset=utf-8',
    'Content-Length': Buffer.byteLength(body),
    'Cache-Control': 'no-store',
    'X-Content-Type-Options': 'nosniff',
    ...headers,
  })
  res.end(body)
}

/** OpenAI's error envelope, so every SDK parses it the same way. */
export function openAIError(message, type = 'invalid_request_error', code = null, param = null) {
  return { error: { message: String(message ?? 'unknown error'), type, param, code } }
}

export async function readRequestBody(req, limitBytes = 64 * 1024 * 1024) {
  const chunks = []
  let size = 0
  for await (const chunk of req) {
    size += chunk.length
    if (size > limitBytes) {
      const error = new Error(`request body exceeds ${Math.round(limitBytes / 1024 / 1024)} MB`)
      error.status = 413
      throw error
    }
    chunks.push(chunk)
  }
  return Buffer.concat(chunks)
}

export async function readJSONBody(req, limitBytes) {
  const raw = await readRequestBody(req, limitBytes)
  if (raw.length === 0) return {}
  try {
    return JSON.parse(raw.toString('utf8'))
  } catch {
    const error = new Error('request body is not valid JSON')
    error.status = 400
    throw error
  }
}

export function intOr(value, fallback, { min = -Infinity, max = Infinity } = {}) {
  const parsed = typeof value === 'number' ? value : Number.parseInt(String(value ?? ''), 10)
  if (!Number.isFinite(parsed)) return fallback
  return Math.max(min, Math.min(max, parsed))
}

export function boolOr(value, fallback) {
  if (value === undefined || value === null || value === '') return fallback
  if (typeof value === 'boolean') return value
  return !['0', 'false', 'no', 'off'].includes(String(value).toLowerCase())
}

export function errorText(value) {
  if (value === undefined || value === null) return ''
  if (typeof value === 'string') return value
  if (typeof value === 'object' && typeof value.message === 'string') return value.message
  try {
    return JSON.stringify(value)
  } catch {
    return String(value)
  }
}

export function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

export function nowISO() {
  return new Date().toISOString()
}
