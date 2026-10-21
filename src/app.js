import fs from 'node:fs'
import http from 'node:http'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createAccountPool } from './pool.js'
import { createChatProxy } from './proxy.js'
import { createAdmin } from './admin.js'
import { createModelRegistry } from './models.js'
import { createStats } from './stats.js'
import { createStore } from './store.js'
import { createUsageCache } from './usage.js'
import { openAIError, sendJSON } from './util.js'

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..')

function createLogger() {
  const stamp = () => new Date().toISOString()
  return {
    info: (message) => console.log(`${stamp()} INFO  ${message}`),
    warn: (message) => console.warn(`${stamp()} WARN  ${message}`),
    error: (message) => console.error(`${stamp()} ERROR ${message}`),
  }
}

/** Serve one file from public/, cached after the first read. */
function createStatic(publicDir, log) {
  const cache = new Map()
  const types = {
    '.html': 'text/html; charset=utf-8',
    '.js': 'text/javascript; charset=utf-8',
    '.css': 'text/css; charset=utf-8',
    '.svg': 'image/svg+xml',
    '.png': 'image/png',
    '.ico': 'image/x-icon',
    '.json': 'application/json; charset=utf-8',
  }
  return function serve(res, file, status = 200) {
    if (!cache.has(file)) {
      try {
        cache.set(file, fs.readFileSync(path.join(publicDir, file)))
      } catch (error) {
        log.warn(`static file missing: ${file}`)
        sendJSON(res, 404, { error: 'not_found' })
        return
      }
    }
    const body = cache.get(file)
    res.writeHead(status, {
      'Content-Type': types[path.extname(file)] ?? 'application/octet-stream',
      'Content-Length': body.length,
      'Cache-Control': file.endsWith('.html') ? 'no-store' : 'public, max-age=60',
      'X-Content-Type-Options': 'nosniff',
      'Referrer-Policy': 'no-referrer',
      ...(file.endsWith('.html')
        ? { 'Content-Security-Policy': "default-src 'self'; script-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; base-uri 'none'; frame-ancestors 'none'" }
        : {}),
    })
    res.end(body)
  }
}

export async function createGateway({ dataDir, env = process.env, port, host } = {}) {
  const log = createLogger()
  const store = createStore({ dataDir, env })
  const usage = createUsageCache({ store, log })
  const pool = createAccountPool({ store, usage, log })
  const models = createModelRegistry({ store, pool, log })
  const stats = createStats({ dataDir, log })
  const proxy = createChatProxy({ store, pool, models, stats, log })
  const adminToken = String(env.ADMIN_TOKEN ?? '').trim() || store.config.server.adminToken
  const admin = createAdmin({ store, pool, usage, models, stats, log, adminToken })
  const serveStatic = createStatic(path.join(ROOT, 'public'), log)

  const ctx = { store, config: store.config, pool, usage, models, stats, proxy, admin, log, adminToken, dataDir }

  const listenPort = port ?? Number(env.PORT ?? store.config.server.port ?? 8787)
  const listenHost = host ?? String(env.HOST ?? store.config.server.host ?? '0.0.0.0')

  async function route(req, res) {
    const url = new URL(req.url ?? '/', 'http://localhost')
    const pathname = url.pathname
    const rawSegments = pathname.split('/').filter(Boolean)

    if (req.method === 'OPTIONS' && (pathname.startsWith('/v1') || pathname === '/models')) {
      res.writeHead(204, proxy.corsHeaders())
      res.end()
      return
    }

    if (pathname === '/healthz' || pathname === '/health') {
      sendJSON(res, 200, { ok: true, uptime: Math.round(process.uptime()), upstream: store.config.upstream.baseURL })
      return
    }

    if (pathname === '/' || pathname === '/admin') {
      serveStatic(res, 'admin.html')
      return
    }

    if (pathname === '/admin/' ) {
      serveStatic(res, 'admin.html')
      return
    }
    if (pathname === '/admin/app.js' || pathname === '/admin/app.css') {
      serveStatic(res, pathname.slice('/admin/'.length))
      return
    }
    if (pathname === '/favicon.ico') {
      res.writeHead(204)
      res.end()
      return
    }

    if (pathname === '/v1/chat/completions' || pathname === '/chat/completions') {
      if (req.method !== 'POST') {
        sendJSON(res, 405, openAIError('仅支持 POST', 'invalid_request_error'), proxy.corsHeaders())
        return
      }
      await proxy.handleChat(req, res)
      return
    }

    if (pathname === '/v1/models' || pathname === '/models') {
      if (req.method !== 'GET') {
        sendJSON(res, 405, openAIError('仅支持 GET', 'invalid_request_error'), proxy.corsHeaders())
        return
      }
      proxy.handleModels(req, res)
      return
    }

    if (pathname.startsWith('/v1/models/')) {
      if (req.method !== 'GET') {
        sendJSON(res, 405, openAIError('仅支持 GET', 'invalid_request_error'), proxy.corsHeaders())
        return
      }
      const id = decodeURIComponent(pathname.slice('/v1/models/'.length))
      proxy.handleModel(req, res, id)
      return
    }

    if (pathname === '/admin/api' || pathname.startsWith('/admin/api/')) {
      const segments = rawSegments.slice(2).map((part) => decodeURIComponent(part))
      try {
        await admin.handle(req, res, segments, url)
      } catch (error) {
        const status = Number(error?.status ?? 500)
        if (status >= 500) log.error(`admin ${pathname}: ${error?.stack ?? error}`)
        if (!res.headersSent) sendJSON(res, status, { error: error?.message ?? 'internal error' })
      }
      return
    }

    sendJSON(res, 404, { error: 'not_found' })
  }

  const server = http.createServer((req, res) => {
    route(req, res).catch((error) => {
      log.error(`unhandled request error ${req.method} ${req.url}: ${error?.stack ?? error}`)
      if (!res.headersSent) {
        const isV1 = String(req.url ?? '').startsWith('/v1') || String(req.url ?? '').startsWith('/chat')
        if (isV1) sendJSON(res, 500, openAIError('网关内部错误', 'upstream_error', 'internal_error'), proxy.corsHeaders())
        else sendJSON(res, 500, { error: 'internal_error' })
      } else {
        res.end()
      }
    })
  })
  server.keepAliveTimeout = 65_000
  server.headersTimeout = 70_000

  await new Promise((resolve, reject) => {
    server.once('error', reject)
    server.listen(listenPort, listenHost, () => {
      server.off('error', reject)
      resolve()
    })
  })
  const actualPort = server.address().port

  usage.start()
  models.refreshCatalog()
    .then((result) => {
      if (result.added.length > 0) log.info(`catalog refresh added ${result.added.length} model(s)`)
    })
    .catch((error) => log.warn(`catalog refresh failed: ${error?.message ?? error}`))

  let closed = false
  async function close() {
    if (closed) return
    closed = true
    usage.stop()
    store.flush()
    stats.flush()
    const forced = setTimeout(() => {
      server.closeAllConnections?.()
    }, 3000)
    forced.unref?.()
    await new Promise((resolve) => server.close(resolve))
    clearTimeout(forced)
  }

  return {
    server,
    ctx,
    host: listenHost,
    port: actualPort,
    adminToken,
    bootstrap: { ...store.bootstrap, adminToken },
    close,
  }
}
