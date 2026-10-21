import http from 'node:http'

/** A tiny Cline-compatible upstream used by the smoke test. */
export async function startMockUpstream() {
  const state = { requests: [], resetAt: Date.now() }
  const reset = () => {
    state.requests.length = 0
    state.resetAt = Date.now()
  }

  const readJSON = async (req) => {
    const chunks = []
    for await (const chunk of req) chunks.push(chunk)
    if (chunks.length === 0) return {}
    try {
      return JSON.parse(Buffer.concat(chunks).toString('utf8'))
    } catch {
      return {}
    }
  }

  const json = (res, status, payload) => {
    const body = JSON.stringify(payload)
    res.writeHead(status, { 'Content-Type': 'application/json', 'Content-Length': Buffer.byteLength(body) })
    res.end(body)
  }

  const bearer = (req) => String(req.headers.authorization ?? '').replace(/^Bearer\s+/i, '').trim()

  const limitsFor = (key) => {
    const future = new Date(Date.now() + 3 * 3600_000).toISOString()
    if (key === 'key-quota') {
      return [
        { type: 'five_hour', percentUsed: 42, resetsAt: future },
        { type: 'weekly', percentUsed: 100, resetsAt: future },
        { type: 'monthly', percentUsed: 66, resetsAt: future },
      ]
    }
    if (key === 'key-fail') {
      return [
        { type: 'five_hour', percentUsed: 12, resetsAt: future },
        { type: 'weekly', percentUsed: 50, resetsAt: future },
        { type: 'monthly', percentUsed: 33, resetsAt: future },
      ]
    }
    if (key === 'key-alt') {
      return [
        { type: 'five_hour', percentUsed: 88, resetsAt: future },
        { type: 'weekly', percentUsed: 91, resetsAt: future },
        { type: 'monthly', percentUsed: 70, resetsAt: future },
      ]
    }
    return [
      { type: 'five_hour', percentUsed: 20, resetsAt: future },
      { type: 'weekly', percentUsed: 35, resetsAt: future },
      { type: 'monthly', percentUsed: 10, resetsAt: future },
    ]
  }

  const models = [
    'cline-pass/glm-5.3',
    'cline-pass/kimi-k3',
    'cline-pass/deepseek-v4-flash',
    'cline-pass/glm-5.3-flash',
  ]

  const server = http.createServer(async (req, res) => {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const path = url.pathname

    if (path === '/__requests') {
      json(res, 200, { requests: state.requests })
      return
    }
    if (path === '/__reset') {
      reset()
      json(res, 200, { ok: true })
      return
    }

    if (path === '/api/v1/ai/cline/recommended-models' || path === '/recommended-models') {
      json(res, 200, { clinePass: models.map((id) => ({ id, name: id.replace('cline-pass/', '') })) })
      return
    }

    if (!path.startsWith('/api/v1/')) {
      json(res, 404, { error: 'not found' })
      return
    }

    const key = bearer(req)

    if (path === '/api/v1/models') {
      if (!key) {
        json(res, 401, { error: { message: 'missing api key' } })
        return
      }
      json(res, 200, { data: models.map((id) => ({ id, object: 'model' })) })
      return
    }

    if (path === '/api/v1/users/me/plan/usage-limits') {
      if (key === 'key-bad') {
        json(res, 401, { error: { message: 'Invalid API key' } })
        return
      }
      json(res, 200, { success: true, data: { limits: limitsFor(key) } })
      return
    }

    if (path === '/api/v1/users/me') {
      if (key === 'key-bad') {
        json(res, 401, { error: { message: 'Invalid API key' } })
        return
      }
      json(res, 200, { success: true, data: { id: `user-${key}`, name: `Mock ${key}`, email: `${key}@example.test` } })
      return
    }

    if (path === '/api/v1/users/me/plan') {
      json(res, 200, { success: true, data: { plan: { name: 'Mock Pro', weeklyCap: 2_500_000_000 } } })
      return
    }

    if (/^\/api\/v1\/users\/[^/]+\/usages\/daily$/.test(path)) {
      const items = []
      for (let day = 0; day < 3; day += 1) {
        const date = new Date(Date.now() - day * 86_400_000).toISOString().slice(0, 10)
        items.push({ date, aiModelName: 'cline-pass/glm-5.3', promptTokens: 1000 + day, completionTokens: 250, costUsd: 0.012 })
        items.push({ date, aiModelName: 'cline-pass/kimi-k3', promptTokens: 500, completionTokens: 120, costUsd: 0.004 })
      }
      json(res, 200, { success: true, data: { items } })
      return
    }

    if (path === '/api/v1/chat/completions' && req.method === 'POST') {
      const body = await readJSON(req)
      state.requests.push({ key, path, body, at: Date.now() })

      if (key === 'key-bad') {
        json(res, 401, { error: { message: 'Invalid API key' } })
        return
      }
      if (key === 'key-fail') {
        json(res, 402, { error: { message: 'Weekly usage limit reached for this plan' } })
        return
      }

      const directProbe = Array.isArray(body.provider?.only) && body.provider.only.includes('__probe__')
      if (directProbe) {
        json(res, 400, {
          error: {
            message: 'No allowed providers are available for the selected model.',
            metadata: { available_providers: ['alpha', 'beta', 'gamma'] },
          },
        })
        return
      }
      const plannerProbe = Array.isArray(body.providerOptions?.gateway?.only) && body.providerOptions.gateway.only.includes('__probe__')
      if (plannerProbe) {
        json(res, 400, { error: { message: 'Available providers are: alpha, beta, gamma.' } })
        return
      }

      const pipeline = String(body.model ?? '').includes('kimi') ? 'planner' : 'direct'
      const requested = pipeline === 'planner'
        ? body.providerOptions?.gateway?.only?.[0]
        : body.provider?.only?.[0]
      const provider = requested ?? 'alpha'
      if (!['alpha', 'beta', 'gamma'].includes(provider)) {
        if (pipeline === 'planner') json(res, 400, { error: { message: 'Available providers are: alpha, beta, gamma.' } })
        else json(res, 400, { error: { message: 'No allowed providers are available for the selected model.', metadata: { available_providers: ['alpha', 'beta', 'gamma'] } } })
        return
      }

      const tail = String(body.model ?? '').replace(/^cline-pass\//, '')
      const routing = { finalProvider: provider, canonicalSlug: `zai/${tail}`, fallbacksAvailable: ['beta'] }
      const id = `chatcmpl-mock-${state.requests.length}`
      const created = Math.floor(Date.now() / 1000)

      if (body.stream === true) {
        res.writeHead(200, { 'Content-Type': 'text/event-stream', 'Cache-Control': 'no-cache', Connection: 'keep-alive' })
        const frame = (choices, extra = {}) => {
          const payload = { id, object: 'chat.completion.chunk', created, model: body.model, choices, ...extra }
          if (pipeline === 'direct') payload.provider = provider
          for (const choice of choices) {
            if (choice.delta !== undefined && pipeline === 'planner') {
              choice.delta.provider_metadata = { gateway: { routing } }
            }
          }
          res.write(`data: ${JSON.stringify(payload)}\n\n`)
        }
        frame([{ index: 0, delta: { role: 'assistant' }, finish_reason: null }])
        frame([{ index: 0, delta: { content: 'O' }, finish_reason: null }])
        frame([{ index: 0, delta: { content: 'K' }, finish_reason: null }])
        frame([{ index: 0, delta: {}, finish_reason: 'stop' }])
        res.write(`data: ${JSON.stringify({ id, object: 'chat.completion.chunk', created, model: body.model, choices: [], usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 } })}\n\n`)
        res.write('data: [DONE]\n\n')
        res.end()
        return
      }

      const message = { role: 'assistant', content: 'OK' }
      if (pipeline === 'planner') message.provider_metadata = { gateway: { routing } }
      const payload = {
        id,
        object: 'chat.completion',
        created,
        model: body.model,
        choices: [{ index: 0, message, finish_reason: 'stop' }],
        usage: { prompt_tokens: 12, completion_tokens: 5, total_tokens: 17 },
      }
      if (pipeline === 'direct') payload.provider = provider
      json(res, 200, payload)
      return
    }

    json(res, 404, { error: { message: `mock has no route for ${path}` } })
  })

  await new Promise((resolve) => server.listen(0, '127.0.0.1', resolve))
  const port = server.address().port
  const origin = `http://127.0.0.1:${port}`
  return {
    origin,
    url: `${origin}/api/v1`,
    recommendedURL: `${origin}/api/v1/ai/cline/recommended-models`,
    state,
    reset,
    close: () => new Promise((resolve) => server.close(resolve)),
  }
}
