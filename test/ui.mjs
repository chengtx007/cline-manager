import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { JSDOM, VirtualConsole } from 'jsdom'
import { createGateway } from '../src/app.js'
import { startMockUpstream } from './mock-upstream.mjs'

const sleep = (ms) => new Promise((resolve) => setTimeout(resolve, ms))
const here = path.dirname(fileURLToPath(import.meta.url))

const mock = await startMockUpstream()
const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'cline-manager-ui-'))
const env = { PATH: process.env.PATH, CLINE_BASE_URL: mock.url, CLINE_RECOMMENDED_URL: mock.recommendedURL }
let gateway

try {
  gateway = await createGateway({ dataDir, env, port: 0, host: '127.0.0.1' })
  const base = `http://127.0.0.1:${gateway.port}`
  const adminToken = gateway.adminToken
  const apiKey = gateway.bootstrap.createdKey

  const admin = async (method, apiPath, body) => {
    const response = await fetch(`${base}/admin/api${apiPath}`, {
      method,
      headers: { Authorization: `Bearer ${adminToken}`, ...(body === undefined ? {} : { 'Content-Type': 'application/json' }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    })
    assert.equal(response.ok, true, `${method} ${apiPath} -> ${response.status}`)
    return response.json()
  }

  await admin('POST', '/accounts', { name: 'ui-main', apiKey: 'key-main' })
  await fetch(`${base}/v1/chat/completions`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
    body: JSON.stringify({ model: 'cline-pass/glm-5.3', messages: [{ role: 'user', content: 'ui' }] }),
  })

  const html = fs.readFileSync(path.join(here, '..', 'public', 'admin.html'), 'utf8')
  const appJS = fs.readFileSync(path.join(here, '..', 'public', 'app.js'), 'utf8')
  const errors = []
  const virtualConsole = new VirtualConsole()
  virtualConsole.on('jsdomError', (error) => errors.push(error))
  virtualConsole.on('error', (...args) => errors.push(new Error(args.join(' '))))

  const dom = new JSDOM(html, { url: `${base}/admin`, runScripts: 'outside-only', pretendToBeVisual: true, virtualConsole })
  const { window } = dom
  window.fetch = (input, init) => {
    const url = String(input).startsWith('http') ? String(input) : new URL(String(input), base).toString()
    return fetch(url, init)
  }
  window.confirm = () => true
  window.scrollTo = () => {}
  window.localStorage.setItem('cline-manager-admin-token', adminToken)
  window.eval(appJS)
  await sleep(400)

  const document = window.document
  const text = () => document.querySelector('#view')?.textContent ?? ''
  const click = (selector) => {
    const node = document.querySelector(selector)
    assert(node, `missing element: ${selector}`)
    node.click()
  }

  assert.equal(document.querySelector('#app').classList.contains('hidden'), false)
  assert(text().includes('今日请求'), 'overview did not render')
  assert(text().includes('ui-main'), 'overview account card missing')
  console.log('  ✓ 登录并渲染概览')

  click('.nav-item[data-tab="accounts"]')
  await sleep(80)
  assert(text().includes('账户池'))
  assert(text().includes('ui-main'))
  console.log('  ✓ 账户页渲染')

  click('.nav-item[data-tab="models"]')
  await sleep(80)
  assert(text().includes('模型与上游钉住'))
  click('[data-action="expand-model"]')
  await sleep(80)
  assert(document.querySelector('.pin-panel'), 'pin panel did not open')
  assert(text().includes('严格 strict'))
  console.log('  ✓ 模型页与钉住面板')

  click('.nav-item[data-tab="keys"]')
  await sleep(80)
  assert(text().includes('接入密钥'))
  click('[data-action="add-key"]')
  await sleep(50)
  const nameInput = document.querySelector('#modal-form input[name="name"]')
  assert(nameInput, 'key creation modal missing')
  nameInput.value = 'ui-client'
  document.querySelector('#modal-form').dispatchEvent(new window.Event('submit', { bubbles: true, cancelable: true }))
  await sleep(300)
  const secret = document.querySelector('#secret-value')?.textContent ?? ''
  assert(secret.startsWith('sk-cline-'), `secret modal missing (${secret})`)
  console.log('  ✓ 新建接入密钥并展示一次性密钥')

  click('.nav-item[data-tab="overview"]')
  await sleep(700)
  assert(text().includes('每日 Token'), 'overview stats did not render')
  assert(text().includes('cline-pass/glm-5.3'), 'overview stats model row missing')
  assert(text().includes('ui-client') || text().includes('default'), 'overview stats key row missing')
  console.log('  ✓ 首页概览合并用量统计')

  click('.nav-item[data-tab="settings"]')
  await sleep(80)
  assert(document.querySelector('#settings-form'), 'settings form missing')
  assert(text().includes('额度守卫'))
  assert(document.querySelector('#settings-form input[name="publicDashboard"]'), 'public dashboard toggle missing')
  console.log('  ✓ 设置页渲染')

  assert.equal(errors.length, 0, `browser errors: ${errors.map((error) => error.message ?? error).join('; ')}`)
  window.close()
  console.log('\nUI 测试全部通过\n')
} finally {
  if (gateway) await gateway.close().catch(() => {})
  await mock.close().catch(() => {})
  fs.rmSync(dataDir, { recursive: true, force: true })
}
