import { chatCompletion, openChatStream } from './cline.js'
import {
  buildAttempts,
  classifyFailure,
  injectPrefs,
  parseRouting,
  pinWarnings,
  unwrapEnvelope,
} from './protocol.js'
import { mapUsage } from './stats.js'
import {
  errorText,
  openAIError,
  parseBearer,
  readJSONBody,
  safeEqual,
  sendJSON,
  sha256,
} from './util.js'

/** Fields copied from the client request to the upstream request. */
const FORWARD_FIELDS = [
  'temperature', 'top_p', 'max_tokens', 'max_completion_tokens', 'stop', 'tools', 'tool_choice',
  'response_format', 'n', 'presence_penalty', 'frequency_penalty', 'seed', 'user',
  'parallel_tool_calls', 'reasoning_effort', 'reasoning', 'logprobs', 'top_logprobs',
  'functions', 'function_call',
  'thinking', 'thinking_budget', 'enable_thinking',
]

const MAX_BUFFERED_FRAMES = 200

export function createChatProxy({ store, pool, models, stats, log }) {
  const config = () => store.config

  function corsHeaders() {
    if (config().server.cors !== true) return {}
    return {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Headers': 'Authorization, Content-Type, X-API-Key',
      'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    }
  }

  function authenticate(req) {
    const token = parseBearer(req)
    if (!token) return null
    const hash = sha256(token)
    return config().requestKeys.find((key) => key.enabled && safeEqual(key.keyHash, hash)) ?? null
  }

  function buildUpstreamBody(clientBody, model, stream) {
    const out = { model, messages: clientBody.messages, stream }
    for (const field of FORWARD_FIELDS) {
      if (clientBody[field] !== undefined) out[field] = clientBody[field]
    }
    if (stream) {
      out.stream_options = {
        ...(clientBody.stream_options && typeof clientBody.stream_options === 'object' ? clientBody.stream_options : {}),
        include_usage: true,
      }
    }
    return out
  }

  function failureOf(result) {
    const payload = unwrapEnvelope(result.json)
    const message = errorText(payload?.error) || String(result.text ?? '').slice(0, 500) || `HTTP ${result.status}`
    return { ok: false, status: result.status, message, code: classifyFailure(result.status, message) }
  }

  function interpret(result) {
    if (result.ok !== true) return failureOf(result)
    const payload = unwrapEnvelope(result.json)
    if (payload?.error !== undefined && payload?.choices === undefined) return failureOf(result)
    if (!payload || !Array.isArray(payload.choices) || payload.choices.length === 0) {
      return { ok: false, status: 502, message: '上游返回了空补全（no choices）', code: 'UPSTREAM' }
    }
    return { ok: true, payload, routing: parseRouting(payload), usage: mapUsage(payload.usage) }
  }

  /** SSE event splitter; keeps a partial tail between chunks. */
  class SSEParser {
    constructor() {
      this.buffer = ''
    }

    push(text) {
      this.buffer += text
      const events = []
      const separator = /\r?\n\r?\n/
      for (;;) {
        const match = separator.exec(this.buffer)
        if (match === null) break
        const event = this.buffer.slice(0, match.index)
        this.buffer = this.buffer.slice(match.index + match[0].length)
        if (event.trim().length > 0) events.push(event)
      }
      return events
    }

    flush() {
      const event = this.buffer
      this.buffer = ''
      return event.trim().length > 0 ? [event] : []
    }
  }

  function dataOf(event) {
    return event
      .split(/\r?\n/)
      .filter((line) => line.startsWith('data:'))
      .map((line) => line.slice(5).replace(/^ /, ''))
      .join('\n')
  }

  function writeSSEHeaders(res) {
    if (res.headersSent) return
    res.writeHead(200, {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...corsHeaders(),
    })
  }

  function synthesizeSSE(payload, model) {
    const id = payload?.id ?? `chatcmpl-${Date.now()}`
    const created = Number(payload?.created ?? Math.floor(Date.now() / 1000))
    const message = payload?.choices?.[0]?.message ?? {}
    const finish = payload?.choices?.[0]?.finish_reason ?? 'stop'
    const delta = { role: 'assistant' }
    if (typeof message.content === 'string' && message.content.length > 0) delta.content = message.content
    if (typeof message.reasoning_content === 'string' && message.reasoning_content.length > 0) delta.reasoning_content = message.reasoning_content
    if (Array.isArray(message.tool_calls) && message.tool_calls.length > 0) {
      delta.tool_calls = message.tool_calls.map((call, index) => ({
        index: Number(call.index ?? index),
        id: call.id,
        type: call.type ?? 'function',
        function: { name: call.function?.name ?? '', arguments: call.function?.arguments ?? '' },
      }))
    }
    const frames = [
      { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta, finish_reason: null }] },
      { id, object: 'chat.completion.chunk', created, model, choices: [{ index: 0, delta: {}, finish_reason: finish }] },
    ]
    if (payload?.usage !== undefined) {
      frames.push({ id, object: 'chat.completion.chunk', created, model, choices: [], usage: payload.usage })
    }
    return frames
  }

  async function readWithIdle(reader, idleMs) {
    let timer = null
    try {
      return await Promise.race([
        reader.read(),
        new Promise((_, reject) => {
          timer = setTimeout(() => {
            reader.cancel().catch(() => {})
            const error = new Error(`上游流空闲超时（${idleMs}ms）`)
            error.code = 'TIMEOUT'
            reject(error)
          }, idleMs)
          timer.unref?.()
        }),
      ])
    } finally {
      if (timer !== null) clearTimeout(timer)
    }
  }

  /**
   * Try one streaming attempt. Nothing reaches the client until the first
   * successful frame, which is what keeps pre-first-token failover possible.
   */
  async function streamAttempt({ account, upstreamBody, signal, res, canonical }) {
    const started = Date.now()
    let response
    try {
      response = await openChatStream({
        baseURL: account.baseURL || config().upstream.baseURL,
        apiKey: account.apiKey,
        body: upstreamBody,
        signal,
        connectTimeoutMs: Number(config().upstream.connectTimeoutMs ?? 60_000),
      })
    } catch (error) {
      return { ok: false, status: 0, message: String(error?.message ?? error), code: signal?.aborted ? 'ABORT' : 'TRANSPORT', ms: Date.now() - started }
    }

    if (!response.ok) {
      const text = await response.text().catch(() => '')
      let message = text.slice(0, 500)
      try {
        const parsed = unwrapEnvelope(JSON.parse(text))
        message = errorText(parsed?.error) || message
      } catch { /* keep raw text */ }
      return { ok: false, status: response.status, message: message || `HTTP ${response.status}`, code: classifyFailure(response.status, message), ms: Date.now() - started }
    }

    const contentType = String(response.headers.get('content-type') ?? '')
    if (!contentType.includes('text/event-stream')) {
      // Some models answer a `stream: true` request with one JSON body.
      const text = await response.text().catch(() => '')
      let parsed = null
      try {
        parsed = JSON.parse(text)
      } catch {
        return { ok: false, status: 502, message: '上游返回了无法解析的响应体', code: 'UPSTREAM', ms: Date.now() - started }
      }
      const payload = unwrapEnvelope(parsed)
      if (payload?.error !== undefined && payload?.choices === undefined) {
        const message = errorText(payload.error) || text.slice(0, 500)
        return { ok: false, status: 502, message, code: classifyFailure(502, message), ms: Date.now() - started }
      }
      const routing = parseRouting(payload)
      const usage = mapUsage(payload?.usage)
      writeSSEHeaders(res)
      for (const frame of synthesizeSSE(payload, canonical)) {
        res.write(typeof frame === 'string' ? `data: ${frame}\n\n` : `data: ${JSON.stringify(frame)}\n\n`)
      }
      res.end()
      return { ok: true, committed: true, status: 200, ms: Date.now() - started, usage, routing }
    }

    if (response.body === null || response.body === undefined) {
      return { ok: false, status: 502, message: '上游没有返回响应体', code: 'UPSTREAM', ms: Date.now() - started }
    }

    const reader = response.body.getReader()
    const decoder = new TextDecoder()
    const parser = new SSEParser()
    const pending = []
    let committed = false
    let usage = { prompt: 0, completion: 0, total: 0, cached: 0, reasoning: 0 }
    let routing = { pipeline: null, finalProvider: null, canonicalSlug: null }
    let sawDone = false
    let sawContent = false

    const commit = () => {
      if (committed) return
      committed = true
      writeSSEHeaders(res)
      for (const raw of pending) res.write(raw)
      pending.length = 0
    }

    const onAbort = () => {
      reader.cancel().catch(() => {})
    }
    signal?.addEventListener?.('abort', onAbort, { once: true })

    const handleEvent = (raw, event) => {
      const data = dataOf(event)
      if (data === '[DONE]') {
        if (!committed) commit()
        res.write(raw)
        sawDone = true
        return 'done'
      }
      let payload = null
      try {
        payload = JSON.parse(data)
      } catch {
        if (committed) res.write(raw)
        else if (pending.length < MAX_BUFFERED_FRAMES) pending.push(raw)
        return 'next'
      }
      if (payload?.usage !== undefined && payload.usage !== null) usage = mapUsage(payload.usage)
      const frameRouting = parseRouting(payload)
      if (frameRouting.finalProvider !== null || frameRouting.pipeline !== null) {
        routing = {
          pipeline: frameRouting.pipeline ?? routing.pipeline,
          finalProvider: frameRouting.finalProvider ?? routing.finalProvider,
          canonicalSlug: frameRouting.canonicalSlug ?? routing.canonicalSlug,
        }
      }
      if (payload?.error !== undefined && payload?.choices === undefined) {
        const message = errorText(payload.error)
        if (!committed) return { error: { ok: false, status: 502, message, code: classifyFailure(502, message), ms: Date.now() - started } }
        res.write(`event: error\ndata: ${JSON.stringify({ error: payload.error })}\n\n`)
        res.end()
        return { error: { ok: false, committed: true, status: 502, message, code: classifyFailure(502, message), ms: Date.now() - started } }
      }
      if (Array.isArray(payload?.choices) && payload.choices.length > 0) {
        sawContent = true
        commit()
        res.write(raw)
        return 'written'
      }
      if (committed) {
        res.write(raw)
      } else if (pending.length < MAX_BUFFERED_FRAMES) {
        pending.push(raw)
      }
      return 'buffered'
    }

    try {
      for (;;) {
        const next = await readWithIdle(reader, Number(config().upstream.idleTimeoutMs ?? 300_000))
        if (next.done === true) break
        const text = decoder.decode(next.value, { stream: true })
        for (const event of parser.push(text)) {
          const raw = `${event}\n\n`
          const result = handleEvent(raw, event)
          if (result === 'done') break
          if (result?.error) return result.error
        }
        if (sawDone) break
      }
      for (const event of parser.flush()) {
        const raw = `${event}\n\n`
        const result = handleEvent(raw, event)
        if (result?.error) return result.error
      }
    } catch (error) {
      if (signal?.aborted) {
        return { ok: false, committed, status: 0, message: '客户端已断开', code: 'ABORT', ms: Date.now() - started, usage, routing }
      }
      if (committed) {
        const message = String(error?.message ?? error)
        res.write(`event: error\ndata: ${JSON.stringify({ error: { message, type: 'upstream_error' } })}\n\n`)
        res.end()
        return { ok: false, committed: true, status: 502, message, code: 'UPSTREAM', ms: Date.now() - started, usage, routing }
      }
      return { ok: false, status: 0, message: String(error?.message ?? error), code: error?.code ?? 'TRANSPORT', ms: Date.now() - started, usage, routing }
    } finally {
      signal?.removeEventListener?.('abort', onAbort)
      reader.cancel().catch(() => {})
    }

    if (!sawDone && committed) {
      // The content is already delivered; close the SSE stream cleanly instead
      // of leaving the client waiting forever.
      res.write('data: [DONE]\n\n')
    }
    if (committed) res.end()
    if (!sawContent && !committed) {
      return { ok: false, status: 502, message: '上游流在输出任何内容前结束', code: 'UPSTREAM', ms: Date.now() - started, usage, routing }
    }
    if (!sawDone && !committed) {
      return { ok: false, status: 502, message: '上游流没有 [DONE] 且没有内容', code: 'UPSTREAM', ms: Date.now() - started, usage, routing }
    }
    return { ok: true, committed, status: 200, ms: Date.now() - started, usage, routing }
  }

  /** POST /v1/chat/completions */
  async function handleChat(req, res) {
    const key = authenticate(req)
    if (key === null) {
      sendJSON(res, 401, openAIError('无效的网关 API Key。请在请求头使用 Authorization: Bearer <key> 或 x-api-key。', 'invalid_request_error', 'invalid_api_key'), corsHeaders())
      return
    }

    let body
    try {
      body = await readJSONBody(req)
    } catch (error) {
      sendJSON(res, error.status ?? 400, openAIError(String(error.message), 'invalid_request_error', 'invalid_request'), corsHeaders())
      return
    }

    if (!body || typeof body !== 'object' || !Array.isArray(body.messages) || body.messages.length === 0) {
      sendJSON(res, 400, openAIError('messages 必须是非空数组', 'invalid_request_error', 'invalid_request'), corsHeaders())
      return
    }
    const requested = String(body.model ?? '').trim()
    const resolved = models.resolve(requested)
    if (resolved === null) {
      sendJSON(res, 404, openAIError(`未知模型：${requested || '(empty)'}。请在管理后台刷新模型列表或开启 allowUnknownModels。`, 'invalid_request_error', 'model_not_found'), corsHeaders())
      return
    }
    if (resolved.enabled !== true) {
      sendJSON(res, 404, openAIError(`模型已关闭：${resolved.id}`, 'invalid_request_error', 'model_not_found'), corsHeaders())
      return
    }

    const canonical = resolved.id
    const stream = body.stream === true
    const pin = models.pinFor(canonical)
    const meta = models.metaFor(canonical)
    const attempts = buildAttempts(pin)
    const warnings = pinWarnings(attempts[0] ?? {}, meta)
    const refused = new Set()
    const trace = []
    let attemptIndex = 0
    let lastError = null
    const started = Date.now()

    const clientAbort = new AbortController()
    const onClose = () => {
      if (!res.writableEnded) clientAbort.abort(new Error('client disconnected'))
    }
    res.on('close', onClose)
    res.on('error', () => {})
    req.on('error', () => {})

    const recordSuccess = (account, outcome, attemptsUsed) => {
      models.noteRouting(canonical, outcome.routing ?? {})
      if (attemptsUsed > 1) {
        for (const row of trace) {
          if (row.status !== 0) models.noteUpstream(canonical, row.upstream, row.code === 'QUOTA' || row.code === 'AUTH' ? 'limited' : 'unknown', row.message, row.ms)
        }
      }
      stats.record({
        ts: Date.now(),
        model: canonical,
        provider: outcome.routing?.finalProvider ?? '',
        accountId: account.id,
        accountName: account.name,
        keyId: key.id,
        keyName: key.name,
        usage: outcome.usage,
        ms: Date.now() - started,
        status: 200,
        stream,
        attempts: attemptsUsed,
      })
      if (warnings.length > 0) log?.warn?.(`pin warnings for ${canonical}: ${warnings.join('; ')}`)
    }

    try {
      while (attemptIndex < attempts.length) {
        const attempt = attempts[attemptIndex++]
        const account = pool.pick({ exclude: [...refused] })
        if (account === null) break

        let release
        try {
          release = await pool.acquire(account, clientAbort.signal)
        } catch {
          break
        }

        const attemptStarted = Date.now()
        try {
          const upstreamBody = injectPrefs(buildUpstreamBody(body, canonical, stream), meta, attempt)
          let outcome
          if (stream) {
            outcome = await streamAttempt({ account, upstreamBody, signal: clientAbort.signal, res, canonical })
          } else {
            const result = await chatCompletion({
              baseURL: account.baseURL || config().upstream.baseURL,
              apiKey: account.apiKey,
              body: upstreamBody,
              signal: clientAbort.signal,
              timeoutMs: Number(config().upstream.requestTimeoutMs ?? 180_000),
            })
            const interpreted = interpret(result)
            if (interpreted.ok) {
              sendJSON(res, 200, interpreted.payload, corsHeaders())
            }
            outcome = { ...interpreted, ms: Date.now() - attemptStarted }
          }

          if (outcome.ok === true) {
            recordSuccess(account, outcome, attemptIndex)
            return
          }

          if (clientAbort.signal.aborted) return

          trace.push({
            attempt: attempt.upstream ?? '(auto)',
            account: account.name,
            accountId: account.id,
            status: outcome.status ?? 0,
            code: outcome.code ?? 'UPSTREAM',
            message: String(outcome.message ?? '').slice(0, 240),
            ms: outcome.ms ?? Date.now() - attemptStarted,
          })
          if (attempt.upstream === null) models.noteFromError(canonical, outcome.message)
          lastError = outcome

          // A refusal about the ACCOUNT (spent window, revoked key) is answered
          // by another account and a fresh pin chain.
          if (outcome.code === 'AUTH' || outcome.code === 'QUOTA' || outcome.code === 'RATE_LIMIT') {
            refused.add(account.id)
            pool.noteFailure(account.id, outcome.code)
            attemptIndex = 0
            log?.warn?.(`account ${account.name} failed with ${outcome.code}: ${String(outcome.message).slice(0, 160)}`)
          }

          // The stream already reached the client: no retry can un-deliver it.
          if (outcome.committed === true) {
            models.noteRouting(canonical, outcome.routing ?? {})
            stats.record({
              ts: Date.now(),
              model: canonical,
              provider: outcome.routing?.finalProvider ?? '',
              accountId: account.id,
              accountName: account.name,
              keyId: key.id,
              keyName: key.name,
              usage: outcome.usage ?? {},
              ms: Date.now() - started,
              status: outcome.status || 502,
              error: outcome.message,
              stream,
              attempts: attemptIndex,
            })
            return
          }
        } catch (error) {
          if (clientAbort.signal.aborted) return
          lastError = { ok: false, status: 0, message: String(error?.message ?? error), code: 'TRANSPORT' }
          trace.push({ attempt: attempt.upstream ?? '(auto)', account: account.name, accountId: account.id, status: 0, code: 'TRANSPORT', message: String(error?.message ?? error).slice(0, 240), ms: Date.now() - attemptStarted })
        } finally {
          release()
        }
      }

      if (clientAbort.signal.aborted) return
      const failure = lastError ?? { status: 502, message: '没有可用的 Cline 账户（请检查账户是否启用、Key 是否有效、额度是否耗尽）', code: 'UPSTREAM' }
      const mapped = mapClientError(failure, trace)
      if (!res.headersSent) sendJSON(res, mapped.status, mapped.body, corsHeaders())
      stats.record({
        ts: Date.now(),
        model: canonical,
        accountId: '',
        accountName: '',
        keyId: key.id,
        keyName: key.name,
        usage: {},
        ms: Date.now() - started,
        status: mapped.status,
        error: failure.message,
        stream,
        attempts: trace.length,
      })
      log?.warn?.(`chat ${canonical} failed after ${trace.length} attempt(s): ${failure.message}`)
    } finally {
      res.off('close', onClose)
    }
  }

  function mapClientError(failure, trace) {
    const base = { trace: trace.slice(-8) }
    switch (failure.code) {
      case 'AUTH':
        return { status: 502, body: { ...openAIError(`所有 Cline 账户的鉴权均失败：${failure.message}`, 'upstream_error', 'upstream_auth_failed'), ...base } }
      case 'QUOTA':
        return { status: 429, body: { ...openAIError(`所有 Cline 账户额度均不足：${failure.message}`, 'insufficient_quota', 'insufficient_quota'), ...base } }
      case 'RATE_LIMIT':
        return { status: 429, body: { ...openAIError(`上游限流：${failure.message}`, 'rate_limit_exceeded', 'rate_limit_exceeded'), ...base } }
      case 'INVALID_REQUEST':
        return { status: 400, body: { ...openAIError(failure.message, 'invalid_request_error', 'invalid_request'), ...base } }
      default:
        return { status: 502, body: { ...openAIError(`上游请求失败：${failure.message}`, 'upstream_error', 'upstream_error'), ...base } }
    }
  }

  /** GET /v1/models */
  function handleModels(req, res) {
    const key = authenticate(req)
    if (key === null) {
      sendJSON(res, 401, openAIError('无效的网关 API Key', 'invalid_request_error', 'invalid_api_key'), corsHeaders())
      return
    }
    const data = models.enabledModels().map((model) => ({
      id: model.id,
      object: 'model',
      created: 0,
      owned_by: 'cline-pass',
    }))
    sendJSON(res, 200, { object: 'list', data }, corsHeaders())
  }

  function handleModel(req, res, id) {
    const key = authenticate(req)
    if (key === null) {
      sendJSON(res, 401, openAIError('无效的网关 API Key', 'invalid_request_error', 'invalid_api_key'), corsHeaders())
      return
    }
    const resolved = models.resolve(id)
    if (resolved === null || resolved.enabled !== true) {
      sendJSON(res, 404, openAIError(`模型不存在：${id}`, 'invalid_request_error', 'model_not_found'), corsHeaders())
      return
    }
    sendJSON(res, 200, { id: resolved.id, object: 'model', created: 0, owned_by: 'cline-pass' }, corsHeaders())
  }

  return { handleChat, handleModels, handleModel, authenticate, corsHeaders }
}
