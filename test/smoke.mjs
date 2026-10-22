import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createGateway } from '../src/app.js'
import { startMockUpstream } from './mock-upstream.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const enc = (value) => encodeURIComponent(value)

let step = 0
function ok(name) {
  step += 1
  console.log(`  ✓ ${String(step).padStart(2, '0')} ${name}`)
}

const mock = await startMockUpstream()
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-manager-test-'))
const env = {
  PATH: process.env.PATH,
  CLINE_BASE_URL: mock.url,
  CLINE_RECOMMENDED_URL: mock.recommendedURL,
}

let gateway
let gateway2
try {
  gateway = await createGateway({ dataDir, env, port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${gateway.port}`
  const adminToken = gateway.adminToken
  const apiKey = gateway.bootstrap.createdKey
  assert(apiKey, 'first-run gateway key must be generated')
  assert(adminToken, 'admin token must exist')

  const admin = async (method, apiPath, body) => {
    const response = await fetch(`${base}/admin/api${apiPath}`, {
      method,
      headers: {
        Authorization: `Bearer ${adminToken}`,
        ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
      },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    const payload = await response.json().catch(() => ({}))
    if (!response.ok) throw new Error(`${method} ${apiPath} -> ${response.status}: ${JSON.stringify(payload)}`)
    return payload
  }

  const chat = (body, key = apiKey) => fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(body),
  })

  const listModels = (key = apiKey) => fetch(`${base}/v1/models`, { headers: { Authorization: `Bearer ${key}` } })

  // 1. auth
  let response = await fetch(`${base}/v1/models`)
  assert.equal(response.status, 401)
  response = await listModels()
  assert.equal(response.status, 200)
  let payload = await response.json()
  assert(payload.data.some((model) => model.id === 'cline-pass/glm-5.3'))
  ok('网关 Key 鉴权与 /v1/models')

  // 2. add account + usage
  const main = await admin('POST', '/accounts', { name: 'main', apiKey: 'key-main' })
  const mainId = main.account.id
  const usage = await admin('POST', `/accounts/${enc(mainId)}/usage`, { days: 30 })
  assert.equal(usage.quota.ok, true)
  assert(usage.quota.limits.length >= 3)
  assert.equal(usage.quota.daily.ok, true)
  assert(usage.quota.daily.rows.length > 0)
  assert.match(main.account.hint, /…/)
  assert.equal(main.account.apiKey, undefined)
  ok('添加账户、读取官方额度与 30 天明细')

  // 3. non-stream chat + stats
  response = await chat({ model: 'cline-pass/glm-5.3', messages: [{ role: 'user', content: 'hi' }] })
  assert.equal(response.status, 200)
  payload = await response.json()
  assert.equal(payload.choices[0].message.content, 'OK')
  response = await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { 'x-api-key': apiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'glm-5.3', messages: [{ role: 'user', content: 'alias' }] }),
  })
  assert.equal(response.status, 200)
  payload = await response.json()
  assert.equal(payload.model, 'cline-pass/glm-5.3')
  await sleep(100)
  let stats = await admin('GET', '/stats?days=1')
  assert(stats.totals.requests >= 1)
  assert(stats.totals.totalTokens >= 17)
  assert(stats.byModel.some((row) => row.name === 'cline-pass/glm-5.3'))
  assert(stats.byKey.some((row) => row.name === 'default'))
  assert(stats.byAccount.some((row) => row.name === 'main'))
  ok('非流式请求与按模型/账户/Key 统计')

  // 4. streaming chat
  response = await chat({ model: 'cline-pass/glm-5.3', messages: [{ role: 'user', content: 'hi' }], stream: true })
  assert.equal(response.status, 200)
  assert.match(response.headers.get('content-type'), /text\/event-stream/)
  const sse = await response.text()
  assert(sse.includes('data: '))
  assert(sse.includes('"content":"O"'))
  assert(sse.includes('[DONE]'))
  await sleep(100)
  stats = await admin('GET', '/stats?days=1')
  assert(stats.totals.requests >= 2)
  ok('流式转发、usage 帧采集与 [DONE]')

  // 5. pin injection
  const modelId = 'cline-pass/glm-5.3'
  await admin('PATCH', `/models/${enc(modelId)}`, {
    pin: { upstreams: ['beta'], exclude: [], pinMode: 'strict', sort: '', spelling: 'both' },
  })
  mock.reset()
  response = await chat({ model: modelId, messages: [{ role: 'user', content: 'pin' }] })
  assert.equal(response.status, 200)
  const chatRequests = mock.state.requests.filter((request) => request.path.endsWith('/chat/completions'))
  assert.equal(chatRequests.length, 1)
  assert.deepEqual(chatRequests[0].body.provider.only, ['beta'])
  assert.deepEqual(chatRequests[0].body.providerOptions.gateway.only, ['beta'])
  await sleep(100)
  stats = await admin('GET', '/stats?days=1')
  assert.equal(stats.recent[0].provider, 'beta')
  ok('双拼写钉住服务商并回读实际路由')

  // 5b. planner pipeline + pin test endpoint
  const kimiId = 'cline-pass/kimi-k3'
  await admin('PATCH', `/models/${enc(kimiId)}`, {
    pin: { upstreams: ['gamma'], exclude: [], pinMode: 'strict', sort: '', spelling: 'both' },
  })
  mock.reset()
  response = await chat({ model: kimiId, messages: [{ role: 'user', content: 'planner pin' }] })
  assert.equal(response.status, 200)
  payload = await response.json()
  const plannerRequests = mock.state.requests.filter((request) => request.path.endsWith('/chat/completions'))
  assert.equal(plannerRequests.length, 1)
  assert.deepEqual(plannerRequests[0].body.providerOptions.gateway.only, ['gamma'])
  assert.deepEqual(plannerRequests[0].body.provider.only, ['gamma'])
  assert.equal(payload.choices[0].message.provider_metadata.gateway.routing.finalProvider, 'gamma')

  const pinTest = await admin('POST', `/models/${enc(modelId)}/test`)
  assert.equal(pinTest.ok, true)
  assert.equal(pinTest.expected, 'beta')
  assert.equal(pinTest.actual, 'beta')
  assert.equal(pinTest.adherence, 'adopted')
  assert.equal(pinTest.account, 'main')
  ok('direct/planner 双链路钉住与「测试钉住」回读实际服务商')

  // 6. probe + validate
  const probe = await admin('POST', `/models/${enc(modelId)}/probe`)
  assert.equal(probe.result.ok, true)
  assert.equal(probe.result.pipeline, 'direct')
  assert(probe.result.upstreams.includes('alpha'))
  assert(probe.result.upstreams.includes('beta'))
  assert(probe.result.upstreams.includes('gamma'))
  assert(probe.result.channels.direct.includes('alpha'))
  assert(probe.result.channels.direct.includes('gamma'))
  assert(probe.result.channels.planner.includes('alpha'))
  const validate = await admin('POST', `/models/${enc(modelId)}/validate`)
  assert(validate.results.length >= 3)
  assert(validate.results.every((row) => row.status === 'ok'))
  ok('探测服务商列表与逐渠道钉住校验')

  // 7. model switch
  await admin('PATCH', `/models/${enc(modelId)}`, { enabled: false })
  response = await chat({ model: modelId, messages: [{ role: 'user', content: 'x' }] })
  assert.equal(response.status, 404)
  payload = await response.json()
  assert.equal(payload.error.code, 'model_not_found')
  await admin('PATCH', `/models/${enc(modelId)}`, { enabled: true })
  ok('关闭模型后 /v1 返回 model_not_found')

  // 8. quota pre-check
  const quota = await admin('POST', '/accounts', { name: 'quota', apiKey: 'key-quota' })
  await admin('POST', `/accounts/${enc(quota.account.id)}/usage`, { days: 0 })
  await admin('PATCH', '/settings', { accountMode: 'single', activeAccountId: quota.account.id })
  mock.reset()
  response = await chat({ model: modelId, messages: [{ role: 'user', content: 'skip quota' }] })
  assert.equal(response.status, 200)
  assert.equal(mock.state.requests.filter((request) => request.key === 'key-quota').length, 0)
  ok('额度守卫在请求前跳过已耗尽账户')

  // 9. failover on 402
  const failing = await admin('POST', '/accounts', { name: 'failing', apiKey: 'key-fail' })
  await admin('POST', `/accounts/${enc(failing.account.id)}/usage`, { days: 0 })
  await admin('PATCH', '/settings', { accountMode: 'single', activeAccountId: failing.account.id })
  mock.reset()
  response = await chat({ model: modelId, messages: [{ role: 'user', content: 'failover' }] })
  assert.equal(response.status, 200)
  const order = mock.state.requests.filter((request) => request.path.endsWith('/chat/completions')).map((request) => request.key)
  assert.deepEqual(order.slice(0, 2), ['key-fail', 'key-main'])
  ok('首个 token 前遇到 402 自动切换账户')

  // 10. account test
  const bad = await admin('POST', '/accounts', { name: 'bad', apiKey: 'key-bad' })
  const tested = await admin('POST', `/accounts/${enc(bad.account.id)}/test`, {})
  assert.equal(tested.authorized, false)
  ok('账户 Key 测试能识别鉴权失败')

  // 11. request keys
  const created = await admin('POST', '/keys', { name: 'client2' })
  assert(created.key.startsWith('sk-cline-'))
  response = await listModels(created.key)
  assert.equal(response.status, 200)
  await admin('PATCH', `/keys/${enc(created.record.id)}`, { enabled: false })
  response = await listModels(created.key)
  assert.equal(response.status, 401)
  await admin('PATCH', `/keys/${enc(created.record.id)}`, { enabled: true })
  ok('新增/停用/启用接入密钥')

  // 12. settings
  await admin('PATCH', '/settings', { quotaGuard: { enabled: true, threshold: 95, refreshMs: 60_000 } })
  const state = await admin('GET', '/state')
  assert.equal(state.settings.quotaGuard.threshold, 95)
  assert(state.keys.some((key) => key.name === 'client2'))
  ok('设置持久化与状态快照')

  // 12b. opt-in public dashboard with masked accounts
  response = await fetch(`${base}/public/api/state`)
  assert.equal(response.status, 404)
  await admin('PATCH', '/settings', { publicDashboard: true })
  const publicPage = await fetch(`${base}/public`)
  assert.equal(publicPage.status, 200)
  assert((await publicPage.text()).includes('公开状态'))
  response = await fetch(`${base}/public/api/state`)
  assert.equal(response.status, 200)
  const shared = await response.json()
  assert.equal(shared.enabled, true)
  assert(shared.today.requests >= 1)
  assert.equal(shared.accounts[0].name, 'ma***')
  assert.equal(shared.accounts[0].id, undefined)
  assert.equal(shared.accounts[0].hint, undefined)
  assert.equal(shared.accounts[0].baseURL, undefined)
  assert.equal(shared.accounts[0].quota.limits.length >= 3, true)
  assert.equal(state.settings.publicDashboard, false)
  await admin('PATCH', '/settings', { publicDashboard: false })
  response = await fetch(`${base}/public/api/state`)
  assert.equal(response.status, 404)
  ok('公开展示页开关、打码账户与今日统计')

  // 13. round-robin across healthy accounts
  const alt = await admin('POST', '/accounts', { name: 'alt', apiKey: 'key-alt' })
  await admin('POST', `/accounts/${enc(alt.account.id)}/usage`, { days: 0 })
  await admin('PATCH', `/accounts/${enc(bad.account.id)}`, { enabled: false })
  await admin('PATCH', '/settings', { accountMode: 'roundrobin' })
  mock.reset()
  for (let index = 0; index < 4; index += 1) {
    const reply = await chat({ model: modelId, messages: [{ role: 'user', content: `rr-${index}` }] })
    assert.equal(reply.status, 200)
  }
  const used = new Set(mock.state.requests.filter((request) => request.path.endsWith('/chat/completions')).map((request) => request.key))
  assert(used.has('key-main'))
  assert(used.has('key-alt'))
  ok('轮询模式在多个健康账户之间分摊请求')

  // 14. restart persistence
  await gateway.close()
  gateway = null
  gateway2 = await createGateway({ dataDir, env, port: 0, host: '127.0.0.1' })
  assert.equal(gateway2.adminToken, adminToken)
  response = await fetch(`http://127.0.0.1:${gateway2.port}/v1/models`, { headers: { Authorization: `Bearer ${apiKey}` } })
  assert.equal(response.status, 200)
  const persisted = await fetch(`http://127.0.0.1:${gateway2.port}/admin/api/stats?days=1`, { headers: { Authorization: `Bearer ${adminToken}` } })
  assert.equal(persisted.status, 200)
  const persistedStats = await persisted.json()
  assert(persistedStats.totals.requests >= 3)
  ok('重启后账户、密钥与统计仍然存在')

  console.log(`\n全部 ${step} 项测试通过\n`)
} finally {
  if (gateway) await gateway.close().catch(() => {})
  if (gateway2) await gateway2.close().catch(() => {})
  await mock.close().catch(() => {})
  fs.rmSync(dataDir, { recursive: true, force: true })
}
