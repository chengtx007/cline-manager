const TOKEN_KEY = 'cline-manager-admin-token'

const S = {
  token: localStorage.getItem(TOKEN_KEY) || '',
  data: null,
  tab: 'overview',
  stats: null,
  statsDays: 7,
  statsError: '',
  modelFilter: '',
  expanded: new Set(),
  validateResults: {},
  testResults: {},
  busy: new Set(),
  loadingStats: false,
}

const $ = (selector) => document.querySelector(selector)
const view = $('#view')

class AuthError extends Error {}

/* ── helpers ───────────────────────────────────────────────────────────── */

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

/**
 * Copy text, falling back to execCommand when the async Clipboard API is
 * missing or refuses. A plain-HTTP admin page (e.g. http://192.168.x.x:8787)
 * has no Clipboard API at all, and a browser that denies the permission
 * rejects writeText — both used to surface as "复制失败".
 */
async function copyToClipboard(text) {
  if (navigator.clipboard?.writeText) {
    try {
      await navigator.clipboard.writeText(text)
      return true
    } catch {
      // Fall through to the selection-based fallback.
    }
  }
  if (typeof document.execCommand !== 'function') return false
  const area = document.createElement('textarea')
  area.value = String(text)
  area.setAttribute('readonly', '')
  area.style.position = 'fixed'
  area.style.top = '-1000px'
  area.style.opacity = '0'
  document.body.appendChild(area)
  const selection = document.getSelection()
  const previous = selection !== null && selection.rangeCount > 0 ? selection.getRangeAt(0) : null
  area.select()
  area.setSelectionRange(0, area.value.length)
  let copied = false
  try {
    copied = document.execCommand('copy')
  } catch {
    copied = false
  }
  area.remove()
  if (selection !== null && previous !== null) {
    selection.removeAllRanges()
    selection.addRange(previous)
  }
  return copied
}

function fmtNum(value) {
  const number = Number(value ?? 0)
  if (!Number.isFinite(number)) return '0'
  if (Math.abs(number) >= 1e9) return `${(number / 1e9).toFixed(2)}B`
  if (Math.abs(number) >= 1e6) return `${(number / 1e6).toFixed(2)}M`
  if (Math.abs(number) >= 1e4) return `${(number / 1e3).toFixed(1)}k`
  return Math.round(number).toLocaleString('zh-CN')
}

function fmtTime(ts) {
  if (!ts) return '—'
  try {
    return new Date(ts).toLocaleString('zh-CN', { hour12: false })
  } catch {
    return '—'
  }
}

function fmtAgo(ts) {
  if (!ts) return '—'
  const seconds = Math.max(0, Math.round((Date.now() - ts) / 1000))
  if (seconds < 60) return `${seconds} 秒前`
  if (seconds < 3600) return `${Math.round(seconds / 60)} 分钟前`
  if (seconds < 86400) return `${Math.round(seconds / 3600)} 小时前`
  return `${Math.round(seconds / 86400)} 天前`
}

function quotaLabel(type) {
  const key = String(type).toLowerCase().replace(/[^a-z0-9]/g, '')
  if (key.startsWith('fivehour') || key.startsWith('5hour')) return '5 小时'
  if (key === 'weekly' || key === 'week') return '本周'
  if (key === 'monthly' || key === 'month') return '本月'
  if (key === 'daily' || key === 'day') return '今日'
  return String(type)
}

function percentClass(percent) {
  if (percent >= 90) return 'danger'
  if (percent >= 70) return 'warn'
  return ''
}

function resetSummary(limits) {
  const upcoming = limits
    .map((limit) => Date.parse(limit.resetsAt))
    .filter((value) => Number.isFinite(value) && value > Date.now())
    .sort((left, right) => left - right)
  if (upcoming.length === 0) return '重置时间未知'
  return `下次重置：${fmtTime(upcoming[0])}`
}

function toast(message, kind = 'ok') {
  const node = document.createElement('div')
  node.className = `toast ${kind}`
  node.textContent = message
  $('#toasts').appendChild(node)
  setTimeout(() => node.remove(), 3800)
}

async function api(path, { method = 'GET', body } = {}) {
  const response = await fetch(`/admin/api${path}`, {
    method,
    headers: {
      Authorization: `Bearer ${S.token}`,
      ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
    },
    ...(body === undefined ? {} : { body: JSON.stringify(body) }),
  })
  if (response.status === 401) throw new AuthError('unauthorized')
  let payload = {}
  try {
    payload = await response.json()
  } catch { /* empty body */ }
  if (!response.ok) throw new Error(payload.error || payload.message || `HTTP ${response.status}`)
  return payload
}

/* ── login & shell ─────────────────────────────────────────────────────── */

function showLogin(message = '') {
  $('#login').classList.remove('hidden')
  $('#app').classList.add('hidden')
  $('#login-error').textContent = message
}

function showApp() {
  $('#login').classList.add('hidden')
  $('#app').classList.remove('hidden')
}

async function loadState({ quiet = false } = {}) {
  try {
    S.data = await api('/state')
    if (S.data.settings.effectiveAccountId !== undefined) {
      const effective = S.data.accounts.find((account) => account.id === S.data.settings.effectiveAccountId)
      $('#effective-account').textContent = effective ? effective.name : '—'
    }
    $('#upstream-pill').textContent = S.data.settings.baseURL
    $('#upstream-pill').title = S.data.settings.baseURL
    renderView()
    return true
  } catch (error) {
    if (error instanceof AuthError) {
      if (!quiet) showLogin('登录已失效，请重新输入管理员令牌')
      return false
    }
    if (!quiet) toast(error.message, 'err')
    return false
  }
}

async function login(token) {
  S.token = token
  try {
    S.data = await api('/state')
    localStorage.setItem(TOKEN_KEY, token)
    showApp()
    updateChrome()
    renderView()
  } catch (error) {
    S.token = ''
    localStorage.removeItem(TOKEN_KEY)
    showLogin(error instanceof AuthError ? '管理员令牌不正确' : error.message)
  }
}

function logout() {
  S.token = ''
  S.data = null
  localStorage.removeItem(TOKEN_KEY)
  showLogin()
}

const TITLES = {
  overview: ['概览', '服务运行状态与今日用量'],
  accounts: ['账户', 'Cline API Key、额度与自动切换'],
  models: ['模型与钉住', '开关模型、探测上游服务商并固定路由'],
  keys: ['接入密钥', '用于调用 /v1 的网关 API Key'],
  stats: ['用量统计', '按模型、账户和接入密钥拆分 token'],
  settings: ['设置', '调度、额度守卫、超时与上游地址'],
}

function updateChrome() {
  for (const item of document.querySelectorAll('.nav-item')) {
    item.classList.toggle('active', item.dataset.tab === S.tab)
  }
  const [title, subtitle] = TITLES[S.tab] ?? TITLES.overview
  $('#page-title').textContent = title
  $('#page-subtitle').textContent = subtitle
  if (S.data) {
    const effective = S.data.accounts.find((account) => account.id === S.data.settings.effectiveAccountId)
    $('#effective-account').textContent = effective ? effective.name : '—'
    $('#upstream-pill').textContent = S.data.settings.baseURL
  }
}

function renderView() {
  updateChrome()
  if (!S.data) return
  switch (S.tab) {
    case 'accounts': renderAccounts(); break
    case 'models': renderModels(); break
    case 'keys': renderKeys(); break
    case 'settings': renderSettings(); break
    default: renderOverview()
  }
}

/* ── overview ──────────────────────────────────────────────────────────── */

function quotaBars(quota) {
  if (!quota || quota.ok !== true || !Array.isArray(quota.limits) || quota.limits.length === 0) {
    return `<div class="muted small">${esc(quota?.error || '尚未读取额度')}</div>`
  }
  const rows = quota.limits.map((limit) => {
    const percent = Math.max(0, Math.min(100, Number(limit.percentUsed) || 0))
    return `<div class="quota-row">
      <span class="q-label">${esc(quotaLabel(limit.type))}</span>
      <div class="bar"><i class="${percentClass(percent)}" style="width:${percent}%"></i></div>
      <span class="q-pct">${percent.toFixed(0)}%</span>
    </div>`
  }).join('')
  return `<div class="quota-grid">${rows}</div><div class="quota-meta">${esc(resetSummary(quota.limits))}</div>`
}

function renderOverview() {
  const { overview, accounts, models } = S.data
  const enabledModels = models.filter((model) => model.enabled).length
  const enabledAccounts = accounts.filter((account) => account.enabled).length
  const recent = overview.recent ?? []

  view.innerHTML = `
    <div class="cards">
      <div class="card"><div class="card-label">今日请求</div><div class="card-value">${fmtNum(overview.today.requests)}</div><div class="card-foot">错误 ${fmtNum(overview.today.errors)} 次</div></div>
      <div class="card"><div class="card-label">今日 Token</div><div class="card-value">${fmtNum(overview.today.totalTokens)}</div><div class="card-foot">输入 ${fmtNum(overview.today.promptTokens)} · 输出 ${fmtNum(overview.today.completionTokens)}</div></div>
      <div class="card"><div class="card-label">累计请求</div><div class="card-value">${fmtNum(overview.total.requests)}</div><div class="card-foot">累计 Token ${fmtNum(overview.total.totalTokens)}</div></div>
      <div class="card"><div class="card-label">已启用</div><div class="card-value">${enabledAccounts} / ${accounts.length}</div><div class="card-foot">账户 · 模型 ${enabledModels} / ${models.length}</div></div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><h2>账户额度</h2><button class="btn ghost small" data-action="goto-accounts">管理账户</button></div>
        <div class="panel-body">
          ${accounts.length === 0 ? '<div class="empty">还没有账户，请先添加 Cline API Key。</div>' : accounts.map((account) => `
            <div style="padding:10px 0;border-bottom:1px solid rgba(38,52,73,.5)">
              <div style="display:flex;align-items:center;justify-content:space-between;gap:10px;margin-bottom:6px">
                <strong style="font-size:13px">${esc(account.name)}</strong>
                <span class="badge ${account.enabled ? 'ok' : 'danger'}">${account.enabled ? '启用' : '停用'}</span>
              </div>
              ${quotaBars(account.quota)}
            </div>`).join('')}
        </div>
      </div>

      <div class="panel">
        <div class="panel-head"><h2>最近请求</h2><span class="sub">保留最近 500 条</span></div>
        <div class="panel-body flush">
          <div class="table-wrap">
            <table class="table">
              <thead><tr><th>时间</th><th>模型</th><th>账户</th><th>Token</th><th>状态</th></tr></thead>
              <tbody>
                ${recent.length === 0 ? '<tr><td colspan="5"><div class="empty">还没有请求记录</div></td></tr>' : recent.map((row) => `
                  <tr>
                    <td class="nowrap muted small">${esc(fmtTime(row.ts))}</td>
                    <td class="model-id truncate" title="${esc(row.model)}">${esc(row.model)}</td>
                    <td>${esc(row.accountName || '—')}</td>
                    <td class="num">${fmtNum(row.totalTokens)}</td>
                    <td>${row.error ? `<span class="badge danger" title="${esc(row.error)}">失败</span>` : (row.adherence === 'not-adopted' || row.adherence === 'violated') ? `<span class="badge danger" title="期望 ${esc(row.expected || '?')}，实际由 ${esc(row.provider || '未知')} 服务">钉住未生效</span>` : '<span class="badge ok">成功</span>'}</td>
                  </tr>`).join('')}
              </tbody>
            </table>
          </div>
        </div>
      </div>
    </div>

    <div id="overview-stats">
      <div class="empty">正在读取用量统计…</div>
    </div>`
  loadOverviewStats()
}

/* ── accounts ──────────────────────────────────────────────────────────── */

function accountStatus(account) {
  const cooling = account.cooling && account.cooling.until > Date.now()
  const tags = []
  tags.push(`<label class="switch" style="margin-right:6px;vertical-align:middle"><input type="checkbox" data-action="toggle-account" data-id="${esc(account.id)}" ${account.enabled ? 'checked' : ''}><span></span></label>`)
  tags.push(`<span class="badge ${account.enabled ? 'ok' : 'danger'}">${account.enabled ? '启用' : '停用'}</span>`)
  if (cooling) tags.push(`<span class="badge warn" title="${esc(account.cooling.code)}">冷却至 ${esc(fmtTime(account.cooling.until))}</span>`)
  if (account.quota && account.quota.ok === false) tags.push('<span class="badge warn">额度读取失败</span>')
  return tags.join(' ')
}

function renderAccounts() {
  const accounts = S.data.accounts
  view.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div><h2>账户池</h2><div class="sub">模式：${S.data.settings.accountMode === 'roundrobin' ? '轮询' : '单账户'} · 额度守卫：${S.data.settings.quotaGuard.enabled ? `开启（${S.data.settings.quotaGuard.threshold}%）` : '关闭'}</div></div>
        <div class="toolbar">
          <button class="btn ghost small" data-action="refresh-all-usage">刷新全部额度</button>
          <button class="btn primary small" data-action="add-account">添加账户</button>
        </div>
      </div>
      <div class="panel-body flush">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>账户</th><th>API Key</th><th style="width:280px">额度</th><th>状态</th><th class="num">累计请求 / Token</th><th></th></tr></thead>
            <tbody>
              ${accounts.length === 0 ? '<tr><td colspan="6"><div class="empty">还没有账户。添加一个 Cline Pass API Key 后即可开始代理。</div></td></tr>' : accounts.map((account) => `
                <tr>
                  <td>
                    <strong>${esc(account.name)}</strong>
                    <div class="small muted">${esc(account.baseURL || '默认上游')} · 并发 ${account.maxConcurrent || '不限'}</div>
                  </td>
                  <td class="mono">${esc(account.hint || '未配置')}</td>
                  <td>${quotaBars(account.quota)}</td>
                  <td>${accountStatus(account)}</td>
                  <td class="num">${fmtNum(account.stats.requests)}<div class="small muted">${fmtNum(account.stats.totalTokens)}</div></td>
                  <td>
                    <div class="actions">
                      <button class="btn small ghost" data-action="test-account" data-id="${esc(account.id)}">测试</button>
                      <button class="btn small ghost" data-action="refresh-account" data-id="${esc(account.id)}">刷新额度</button>
                      <button class="btn small ghost" data-action="daily-account" data-id="${esc(account.id)}">用量明细</button>
                      <button class="btn small ghost" data-action="edit-account" data-id="${esc(account.id)}">编辑</button>
                      <button class="btn small danger" data-action="delete-account" data-id="${esc(account.id)}">删除</button>
                    </div>
                  </td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>自动切换规则</h2></div>
      <div class="panel-body muted small">
        请求在首个 token 输出前遇到 401/403（Key 失效）、402 或额度耗尽、429 限流时，会立即把该账户移出本次请求并切换到下一个账户，
        同时按冷却时间暂时停用该账户。每 5 分钟（可配置）读取一次官方额度；达到阈值的账户会排在可用账户之后，只有全部账户都不可用时才会尝试。
      </div>
    </div>`
}

function openFormModal({ title, fields, submitText = '保存', wide = false, onSubmit }) {
  $('#modal-root').innerHTML = `
    <div class="modal-overlay">
      <form class="modal ${wide ? 'wide' : ''}" id="modal-form">
        <div class="modal-head"><h3>${esc(title)}</h3><button type="button" class="icon-btn" data-close>×</button></div>
        <div class="modal-body">${fields}</div>
        <div class="modal-foot">
          <button type="button" class="btn ghost" data-close>取消</button>
          <button type="submit" class="btn primary">${esc(submitText)}</button>
        </div>
      </form>
    </div>`
  const overlay = $('#modal-root .modal-overlay')
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('[data-close]')) closeModal()
  })
  $('#modal-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const submit = event.target.querySelector('button[type="submit"]')
    submit.disabled = true
    try {
      const result = await onSubmit(new FormData(event.target))
      if (result !== 'keep-open') closeModal()
    } catch (error) {
      toast(error.message, 'err')
    } finally {
      submit.disabled = false
    }
  })
}

function closeModal() {
  $('#modal-root').innerHTML = ''
}

function accountModal(account) {
  openFormModal({
    title: account ? `编辑账户 · ${account.name}` : '添加 Cline 账户',
    submitText: account ? '保存' : '添加',
    fields: `
      <label class="field"><span>名称</span><input name="name" value="${esc(account?.name ?? '')}" placeholder="main" required></label>
      <label class="field"><span>Cline API Key</span><input name="apiKey" type="password" value="" placeholder="${account ? '留空表示不修改' : '粘贴 Cline Pass API Key'}" ${account ? '' : 'required'}></label>
      <label class="field"><span>上游 Base URL（可选）</span><input name="baseURL" value="${esc(account?.baseURL ?? '')}" placeholder="${esc(S.data.settings.baseURL)}"><span class="hint">留空使用全局上游地址。</span></label>
      <label class="field"><span>并发上限</span><input name="maxConcurrent" type="number" min="0" max="512" value="${esc(account?.maxConcurrent ?? 16)}"><span class="hint">该账户同时保持的上游流数量，0 表示不限。</span></label>
      <label class="field" style="grid-template-columns:auto 1fr;align-items:center"><span class="switch"><input type="checkbox" name="enabled" ${account?.enabled === false ? '' : 'checked'}><span></span></span><span>启用该账户</span></label>`,
    onSubmit: async (form) => {
      const payload = {
        name: String(form.get('name') ?? '').trim(),
        apiKey: String(form.get('apiKey') ?? '').trim(),
        baseURL: String(form.get('baseURL') ?? '').trim(),
        maxConcurrent: Number(form.get('maxConcurrent') ?? 16),
        enabled: form.get('enabled') === 'on',
      }
      if (account) {
        await api(`/accounts/${encodeURIComponent(account.id)}`, { method: 'PATCH', body: payload })
      } else {
        await api('/accounts', { method: 'POST', body: payload })
      }
      await loadState()
      toast(account ? '账户已更新' : '账户已添加')
    },
  })
}

async function showDailyUsage(account) {
  try {
    const response = await api(`/accounts/${encodeURIComponent(account.id)}/usage`, { method: 'POST', body: { days: 30 } })
    const quota = response.quota ?? {}
    const daily = quota.daily ?? {}
    const rows = Array.isArray(daily.rows) ? [...daily.rows].sort((a, b) => String(b.date).localeCompare(String(a.date))) : []
    const totals = rows.reduce((sum, row) => {
      sum.tokens += Number(row.totalTokens ?? 0)
      sum.cost += Number(row.costUsd ?? 0)
      return sum
    }, { tokens: 0, cost: 0 })
    const profile = quota.profile ?? {}
    $('#modal-root').innerHTML = `
      <div class="modal-overlay">
        <div class="modal wide">
          <div class="modal-head"><h3>用量明细 · ${esc(account.name)}</h3><button class="icon-btn" data-close>×</button></div>
          <div class="modal-body">
            <div class="cards" style="grid-template-columns:repeat(3,1fr)">
              <div class="card"><div class="card-label">最近 30 天 Token</div><div class="card-value" style="font-size:20px">${fmtNum(totals.tokens)}</div></div>
              <div class="card"><div class="card-label">最近 30 天费用</div><div class="card-value" style="font-size:20px">$${totals.cost.toFixed(2)}</div></div>
              <div class="card"><div class="card-label">账户</div><div class="card-value" style="font-size:15px">${esc(profile.name || profile.email || account.name)}</div><div class="card-foot">${esc(profile.id || '')}</div></div>
            </div>
            <div class="quota-grid" style="margin-bottom:16px">${quota.limits?.map((limit) => {
              const percent = Math.max(0, Math.min(100, Number(limit.percentUsed) || 0))
              return `<div class="quota-row"><span class="q-label">${esc(quotaLabel(limit.type))}</span><div class="bar"><i class="${percentClass(percent)}" style="width:${percent}%"></i></div><span class="q-pct">${percent.toFixed(0)}%</span></div>`
            }).join('') || '<div class="muted small">没有额度窗口数据</div>'}</div>
            ${daily.ok === false ? `<div class="badge warn" style="margin-bottom:10px">官方用量明细不可用：${esc(daily.error)}</div>` : ''}
            <div class="table-wrap" style="max-height:45vh;overflow:auto">
              <table class="table">
                <thead><tr><th>日期</th><th>模型</th><th class="num">输入</th><th class="num">输出</th><th class="num">合计</th><th class="num">费用</th></tr></thead>
                <tbody>
                  ${rows.length === 0 ? '<tr><td colspan="6"><div class="empty">官方接口没有返回明细</div></td></tr>' : rows.map((row) => `
                    <tr><td class="nowrap">${esc(row.date)}</td><td class="model-id">${esc(row.model)}</td><td class="num">${fmtNum(row.promptTokens)}</td><td class="num">${fmtNum(row.completionTokens)}</td><td class="num">${fmtNum(row.totalTokens)}</td><td class="num">$${Number(row.costUsd ?? 0).toFixed(3)}</td></tr>`).join('')}
                </tbody>
              </table>
            </div>
          </div>
          <div class="modal-foot"><button class="btn ghost" data-close>关闭</button></div>
        </div>
      </div>`
    const overlay = $('#modal-root .modal-overlay')
    overlay.addEventListener('click', (event) => {
      if (event.target === overlay || event.target.closest('[data-close]')) closeModal()
    })
  } catch (error) {
    toast(error.message, 'err')
  }
}

/* ── models & pins ─────────────────────────────────────────────────────── */

function channelsOf(model) {
  const discovered = model.discovered ?? {}
  const values = [
    ...(Array.isArray(discovered.upstreams) ? discovered.upstreams : []),
    ...Object.values(discovered.channels ?? {}).flat(),
  ]
  return [...new Set(values.filter(Boolean))]
}

function pinSummary(pin) {
  if (!pin || !Array.isArray(pin.upstreams) || pin.upstreams.length === 0) {
    return pin?.exclude?.length ? `自动（排除 ${pin.exclude.length}）` : '自动'
  }
  return `${pin.pinMode === 'preferred' ? '优先' : '严格'}：${pin.upstreams.join(' → ')}`
}

function renderModels() {
  const models = S.data.models
  view.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div><h2>模型与上游钉住</h2><div class="sub">开关控制是否出现在 /v1/models；展开每行可探测并固定服务商。</div></div>
        <div class="toolbar">
          <button class="btn ghost small" data-action="refresh-models">刷新上游目录</button>
          <button class="btn primary small" data-action="add-model">手动添加模型</button>
          <div class="search"><input id="model-search" placeholder="搜索模型…" value="${esc(S.modelFilter)}"></div>
        </div>
      </div>
      <div class="panel-body flush"><div id="models-list">${modelsTable()}</div></div>
    </div>`
  $('#model-search')?.addEventListener('input', (event) => {
    S.modelFilter = event.target.value
    const list = $('#models-list')
    if (list) list.innerHTML = modelsTable()
  })
}

function modelsTable() {
  const needle = S.modelFilter.trim().toLowerCase()
  const models = S.data.models.filter((model) => needle === '' || model.id.toLowerCase().includes(needle))
  if (models.length === 0) return '<div class="empty">没有匹配的模型。可以刷新上游目录或手动添加。</div>'
  const rows = models.map((model) => {
    const discovered = model.discovered ?? {}
    const lastPin = model.lastPin
    const pinBroken = lastPin && lastPin.expected && (lastPin.adherence === 'not-adopted' || lastPin.adherence === 'violated')
    const expanded = S.expanded.has(model.id)
    return `
      <tr class="model-row ${expanded ? 'expanded' : ''}">
        <td style="width:60px"><label class="switch"><input type="checkbox" data-action="toggle-model" data-id="${esc(model.id)}" ${model.enabled ? 'checked' : ''}><span></span></label></td>
        <td><div class="model-id truncate" title="${esc(model.id)}">${esc(model.id)}</div><div class="small muted">${model.enabled ? '已开放' : '已关闭'}</div></td>
        <td>${esc(pinSummary(model.pin))}</td>
        <td>${discovered.lastProvider ? `<span class="badge accent">${esc(discovered.lastProvider)}</span>` : '<span class="badge">未探测</span>'}${pinBroken ? `<span class="badge danger" title="最近一次带钉住的请求没有落在 ${esc(lastPin.expected)}">钉住未生效</span>` : ''}</td>
        <td>${discovered.pipeline ? `<span class="badge">${esc(discovered.pipeline)}</span>` : '<span class="muted small">—</span>'}</td>
        <td style="text-align:right"><button class="btn small ghost" data-action="expand-model" data-id="${esc(model.id)}">${expanded ? '收起' : '钉住设置'}</button></td>
      </tr>
      ${expanded ? `<tr><td colspan="6" style="padding:0">${pinPanel(model)}</td></tr>` : ''}`
  }).join('')
  return `<div class="table-wrap"><table class="table" style="table-layout:fixed">
    <thead><tr><th style="width:60px">开启</th><th style="width:34%">模型</th><th style="width:22%">钉住</th><th style="width:14%" title="探测请求不带钉住，这里只是最近一次探测或请求看到的服务商；确认钉住请展开后点「测试钉住」">最近服务商</th><th style="width:10%">链路</th><th></th></tr></thead>
    <tbody>${rows}</tbody>
  </table></div>`
}

function pinPanel(model) {
  const pin = model.pin
  const discovered = model.discovered ?? {}
  const channels = channelsOf(model)
  const selected = pin.upstreams ?? []
  const excluded = pin.exclude ?? []
  const validation = S.validateResults[model.id]
  const test = S.testResults[model.id]
  const lastPin = model.lastPin
  const pinBad = lastPin && lastPin.expected && (lastPin.adherence === 'not-adopted' || lastPin.adherence === 'violated')
  const pinOk = lastPin && lastPin.expected && (lastPin.adherence === 'adopted' || lastPin.adherence === 'fallback')
  const pinSource = lastPin?.source === 'live' ? '最近请求' : lastPin?.source === 'test' ? '测试' : lastPin?.source === 'validate' ? '校验' : '检查'
  const testHtml = test
    ? `<div class="${test.ok ? 'pin-hint' : 'pin-warning'}">测试钉住${test.ok ? '生效' : '未生效'}：期望 ${esc(test.expected || '自动')}，实际由 ${esc(test.actual || '未知')} 服务${test.account ? ` · 账户 ${esc(test.account)}` : ''}${test.ok ? '' : ` · ${esc(test.note || '')}`}</div>`
    : ''
  const warnings = []
  if (excluded.length > 0 && channels.length === 0) warnings.push('还没有服务商列表，排除项无法编译成允许列表，请先探测。')

  const selectedChips = selected.length === 0
    ? '<span class="muted small">自动选择（不钉住）</span>'
    : selected.map((name, index) => `
      <span class="chip on">${esc(name)}
        <span class="move" data-action="pin-move" data-id="${esc(model.id)}" data-index="${index}" data-dir="up" title="上移">↑</span>
        <span class="move" data-action="pin-move" data-id="${esc(model.id)}" data-index="${index}" data-dir="down" title="下移">↓</span>
        <span class="x" data-action="pin-toggle" data-id="${esc(model.id)}" data-kind="upstream" data-name="${esc(name)}" title="移除">×</span>
      </span>`).join('')

  const channelChips = channels.length === 0
    ? '<span class="muted small">点击「探测」获取服务商列表</span>'
    : channels.map((name) => `<span class="chip ${selected.includes(name) ? 'on' : ''}" data-action="pin-toggle" data-id="${esc(model.id)}" data-kind="upstream" data-name="${esc(name)}">${esc(name)}</span>`).join('')

  const excludeChips = channels.length === 0
    ? '<span class="muted small">暂无</span>'
    : channels.map((name) => `<span class="chip ${excluded.includes(name) ? 'excluded' : ''}" data-action="pin-toggle" data-id="${esc(model.id)}" data-kind="exclude" data-name="${esc(name)}">${esc(name)}</span>`).join('')

  const validationHtml = validation && validation.length > 0
    ? `<div class="validate-results">${validation.map((row) => `
        <div class="row">
          <span class="mono">${esc(row.upstream)}</span>
          <span class="badge ${row.status === 'ok' ? 'ok' : row.status === 'not-adopted' ? 'danger' : 'warn'}">${esc(row.status)}</span>
          <span class="muted">${esc(row.note || '')} · ${row.ms}ms</span>
        </div>`).join('')}</div>`
    : ''

  return `<div class="pin-panel" data-model="${esc(model.id)}">
    <div class="pin-grid">
      <div>
        <label class="field"><span>钉住模式</span>
          <select data-role="pin-mode" data-id="${esc(model.id)}">
            <option value="strict" ${pin.pinMode === 'strict' ? 'selected' : ''}>严格 strict（只允许指定服务商）</option>
            <option value="preferred" ${pin.pinMode === 'preferred' ? 'selected' : ''}>优先 preferred（按顺序回退）</option>
          </select>
        </label>
        <label class="field"><span>路由排序</span>
          <select data-role="pin-sort" data-id="${esc(model.id)}">
            <option value="" ${!pin.sort ? 'selected' : ''}>不指定</option>
            <option value="cost" ${pin.sort === 'cost' ? 'selected' : ''}>成本 cost</option>
            <option value="ttft" ${pin.sort === 'ttft' ? 'selected' : ''}>首字延迟 ttft</option>
            <option value="tps" ${pin.sort === 'tps' ? 'selected' : ''}>吞吐 tps</option>
          </select>
        </label>
        <label class="field"><span>写入拼写</span>
          <select data-role="pin-spelling" data-id="${esc(model.id)}">
            <option value="both" ${pin.spelling !== 'detected' ? 'selected' : ''}>两种都写（推荐）</option>
            <option value="detected" ${pin.spelling === 'detected' ? 'selected' : ''}>只写已探测链路</option>
          </select>
        </label>
        <div class="pin-hint">网关会自行决定走 OpenRouter（direct）还是 Vercel（planner），两种拼写同时写可避免换链路后钉住失效。</div>
      </div>
      <div>
        <div class="small muted">已选服务商（按顺序尝试）</div>
        <div class="chips">${selectedChips}</div>
        <div class="small muted" style="margin-top:14px">探测到的服务商（点击添加）</div>
        <div class="chips">${channelChips}</div>
        <div class="small muted" style="margin-top:14px">排除服务商（点击排除）</div>
        <div class="chips">${excludeChips}</div>
      </div>
    </div>
    <div class="toolbar" style="margin-top:16px">
      <button class="btn small primary" data-action="probe-model" data-id="${esc(model.id)}">探测</button>
      <button class="btn small" data-action="validate-model" data-id="${esc(model.id)}">校验</button>
      <button class="btn small" data-action="test-pin" data-id="${esc(model.id)}">测试钉住</button>
      ${pinBad ? `<span class="badge danger" title="${esc(pinSource)} · ${esc(fmtAgo(lastPin.at))}">钉住未生效 · 实际 ${esc(lastPin.actual || '未知')}</span>` : ''}
      ${pinOk ? `<span class="badge ok" title="${esc(pinSource)} · ${esc(fmtAgo(lastPin.at))}">钉住已生效 · ${esc(lastPin.actual || lastPin.expected)}</span>` : ''}
      <span class="badge">链路：${esc(discovered.pipeline || '未知')}</span>
      ${discovered.canonicalSlug ? `<span class="badge">slug：${esc(discovered.canonicalSlug)}</span>` : ''}
      ${discovered.probedAt ? `<span class="badge">探测于 ${esc(fmtAgo(discovered.probedAt))}</span>` : ''}
    </div>
    <div class="pin-hint">「探测」发的是不带钉住的请求，只用来发现渠道，服务商列可以是任意一个；要确认钉住是否真的生效，请点「测试钉住」。</div>
    ${testHtml}
    ${warnings.map((warning) => `<div class="pin-warning">${esc(warning)}</div>`).join('')}
    ${validationHtml}
  </div>`
}

function findModel(id) {
  return S.data.models.find((model) => model.id === id)
}

async function savePin(model, pin) {
  const previous = JSON.stringify(model.pin)
  model.pin = pin
  renderModels()
  try {
    await api(`/models/${encodeURIComponent(model.id)}`, { method: 'PATCH', body: { pin } })
  } catch (error) {
    toast(error.message, 'err')
    model.pin = JSON.parse(previous)
    renderModels()
  }
}

/* ── keys ──────────────────────────────────────────────────────────────── */

function renderKeys() {
  const keys = S.data.keys
  view.innerHTML = `
    <div class="panel">
      <div class="panel-head">
        <div><h2>接入密钥</h2><div class="sub">客户端使用 <code>Authorization: Bearer &lt;key&gt;</code> 或 <code>x-api-key</code> 调用 /v1。</div></div>
        <button class="btn primary small" data-action="add-key">新建密钥</button>
      </div>
      <div class="panel-body flush">
        <div class="table-wrap">
          <table class="table">
            <thead><tr><th>名称</th><th>Key</th><th>状态</th><th class="num">请求 / Token</th><th>创建时间</th><th></th></tr></thead>
            <tbody>
              ${keys.length === 0 ? '<tr><td colspan="6"><div class="empty">还没有接入密钥</div></td></tr>' : keys.map((key) => `
                <tr>
                  <td><strong>${esc(key.name)}</strong></td>
                  <td class="mono">${esc(key.hint)}</td>
                  <td>
                    <label class="switch"><input type="checkbox" data-action="toggle-key" data-id="${esc(key.id)}" ${key.enabled ? 'checked' : ''}><span></span></label>
                    <span class="badge ${key.enabled ? 'ok' : 'danger'}">${key.enabled ? '启用' : '停用'}</span>
                  </td>
                  <td class="num">${fmtNum(key.stats.requests)}<div class="small muted">${fmtNum(key.stats.totalTokens)}</div></td>
                  <td class="small muted nowrap">${esc(fmtTime(key.createdAt))}</td>
                  <td><div class="actions"><button class="btn small danger" data-action="delete-key" data-id="${esc(key.id)}">删除</button></div></td>
                </tr>`).join('')}
            </tbody>
          </table>
        </div>
      </div>
    </div>`
}

function showSecret(key) {
  $('#modal-root').innerHTML = `
    <div class="modal-overlay">
      <div class="modal">
        <div class="modal-head"><h3>接入密钥已创建</h3><button class="icon-btn" data-close>×</button></div>
        <div class="modal-body">
          <p class="muted small">这个密钥只会显示一次，请立即复制保存。</p>
          <div class="secret-box" id="secret-value">${esc(key)}</div>
          <button class="btn primary block" id="copy-secret">复制密钥</button>
        </div>
        <div class="modal-foot"><button class="btn ghost" data-close>关闭</button></div>
      </div>
    </div>`
  const overlay = $('#modal-root .modal-overlay')
  overlay.addEventListener('click', (event) => {
    if (event.target === overlay || event.target.closest('[data-close]')) closeModal()
  })
  $('#copy-secret').addEventListener('click', async () => {
    const copied = await copyToClipboard(key)
    if (copied) {
      toast('已复制到剪贴板')
      return
    }
    toast('复制失败，已选中密钥，请按 Ctrl+C 复制', 'err')
    const box = $('#secret-value')
    if (box !== null) {
      const range = document.createRange()
      range.selectNodeContents(box)
      const selection = window.getSelection()
      if (selection !== null) {
        selection.removeAllRanges()
        selection.addRange(range)
      }
    }
  })
}

/* ── stats ─────────────────────────────────────────────────────────────── */

function chartSVG(series) {
  const width = 800
  const height = 180
  const pad = { left: 48, right: 12, top: 14, bottom: 26 }
  const plotWidth = width - pad.left - pad.right
  const plotHeight = height - pad.top - pad.bottom
  const max = Math.max(1, ...series.map((point) => point.totalTokens))
  const step = plotWidth / Math.max(1, series.length)
  const barWidth = Math.min(42, step * 0.62)
  const grid = [0, 0.25, 0.5, 0.75, 1].map((ratio) => {
    const y = pad.top + plotHeight * (1 - ratio)
    return `<line x1="${pad.left}" y1="${y}" x2="${width - pad.right}" y2="${y}" stroke="rgba(143,161,186,.15)" stroke-width="1"/>
      <text x="${pad.left - 8}" y="${y + 4}" text-anchor="end" fill="#8fa1ba" font-size="10">${fmtNum(max * ratio)}</text>`
  }).join('')
  const bars = series.map((point, index) => {
    const x = pad.left + step * index + (step - barWidth) / 2
    const promptHeight = (point.promptTokens / max) * plotHeight
    const completionHeight = (point.completionTokens / max) * plotHeight
    const labelEvery = Math.max(1, Math.ceil(series.length / 8))
    const label = index % labelEvery === 0 || index === series.length - 1
      ? `<text x="${x + barWidth / 2}" y="${height - 8}" text-anchor="middle" fill="#8fa1ba" font-size="9">${point.date.slice(5)}</text>`
      : ''
    return `<g>
      <title>${point.date} · 输入 ${fmtNum(point.promptTokens)} · 输出 ${fmtNum(point.completionTokens)}</title>
      <rect x="${x}" y="${pad.top + plotHeight - promptHeight}" width="${barWidth}" height="${Math.max(0, promptHeight)}" fill="#38bdf8" rx="2"/>
      <rect x="${x}" y="${pad.top + plotHeight - promptHeight - completionHeight}" width="${barWidth}" height="${Math.max(0, completionHeight)}" fill="#4fd1c5" rx="2"/>
      ${label}
    </g>`
  }).join('')
  return `<svg class="chart" viewBox="0 0 ${width} ${height}" preserveAspectRatio="none">${grid}${bars}</svg>
    <div class="legend"><span><i style="background:#38bdf8"></i>输入 Token</span><span><i style="background:#4fd1c5"></i>输出 Token</span></div>`
}

async function loadStats() {
  if (S.loadingStats) return
  S.loadingStats = true
  S.statsError = ''
  try {
    S.stats = await api(`/stats?days=${S.statsDays}`)
  } catch (error) {
    S.statsError = error instanceof AuthError ? '登录已失效' : error.message
    if (!(error instanceof AuthError)) toast(error.message, 'err')
  } finally {
    S.loadingStats = false
  }
}

function statsSectionHtml(stats) {
  const totals = stats.totals
  return `
    <div class="toolbar" style="margin:22px 0 16px">
      <div class="tabs">
        ${[1, 7, 30, 90].map((days) => `<button class="${S.statsDays === days ? 'active' : ''}" data-action="stats-days" data-days="${days}">${days === 1 ? '今天' : `${days} 天`}</button>`).join('')}
      </div>
      <button class="btn ghost small" data-action="reload-stats">刷新</button>
      <span class="muted small">${esc(stats.from)} 至 ${esc(stats.to)}</span>
    </div>

    <div class="cards">
      <div class="card"><div class="card-label">请求</div><div class="card-value">${fmtNum(totals.requests)}</div><div class="card-foot">错误 ${fmtNum(totals.errors)} 次</div></div>
      <div class="card"><div class="card-label">输入 Token</div><div class="card-value">${fmtNum(totals.promptTokens)}</div><div class="card-foot">缓存命中 ${fmtNum(totals.cachedTokens)}</div></div>
      <div class="card"><div class="card-label">输出 Token</div><div class="card-value">${fmtNum(totals.completionTokens)}</div><div class="card-foot">推理 ${fmtNum(totals.reasoningTokens)}</div></div>
      <div class="card"><div class="card-label">合计 Token</div><div class="card-value">${fmtNum(totals.totalTokens)}</div><div class="card-foot">按模型与接入 Key 拆分见下表</div></div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>每日 Token</h2><span class="sub">本地统计，来自上游 usage 帧</span></div>
      <div class="panel-body">${chartSVG(stats.series)}</div>
    </div>

    <div class="grid-2">
      <div class="panel">
        <div class="panel-head"><h2>按模型</h2></div>
        <div class="panel-body flush"><div class="table-wrap"><table class="table">
          <thead><tr><th>模型</th><th class="num">请求</th><th class="num">输入</th><th class="num">输出</th><th class="num">合计</th></tr></thead>
          <tbody>${stats.byModel.length === 0 ? '<tr><td colspan="5"><div class="empty">暂无数据</div></td></tr>' : stats.byModel.map((row) => `
            <tr><td class="model-id truncate" title="${esc(row.name)}">${esc(row.name)}</td><td class="num">${fmtNum(row.requests)}</td><td class="num">${fmtNum(row.promptTokens)}</td><td class="num">${fmtNum(row.completionTokens)}</td><td class="num">${fmtNum(row.totalTokens)}</td></tr>`).join('')}</tbody>
        </table></div></div>
      </div>

      <div class="panel">
        <div class="panel-head"><h2>按接入密钥</h2></div>
        <div class="panel-body flush"><div class="table-wrap"><table class="table">
          <thead><tr><th>密钥</th><th class="num">请求</th><th class="num">输入</th><th class="num">输出</th><th class="num">合计</th></tr></thead>
          <tbody>${stats.byKey.length === 0 ? '<tr><td colspan="5"><div class="empty">暂无数据</div></td></tr>' : stats.byKey.map((row) => `
            <tr><td>${esc(row.name)}</td><td class="num">${fmtNum(row.requests)}</td><td class="num">${fmtNum(row.promptTokens)}</td><td class="num">${fmtNum(row.completionTokens)}</td><td class="num">${fmtNum(row.totalTokens)}</td></tr>`).join('')}</tbody>
        </table></div></div>
      </div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>按账户</h2></div>
      <div class="panel-body flush"><div class="table-wrap"><table class="table">
        <thead><tr><th>账户</th><th class="num">请求</th><th class="num">错误</th><th class="num">输入</th><th class="num">输出</th><th class="num">合计</th></tr></thead>
        <tbody>${stats.byAccount.length === 0 ? '<tr><td colspan="6"><div class="empty">暂无数据</div></td></tr>' : stats.byAccount.map((row) => `
          <tr><td>${esc(row.name)}</td><td class="num">${fmtNum(row.requests)}</td><td class="num">${fmtNum(row.errors)}</td><td class="num">${fmtNum(row.promptTokens)}</td><td class="num">${fmtNum(row.completionTokens)}</td><td class="num">${fmtNum(row.totalTokens)}</td></tr>`).join('')}</tbody>
      </table></div></div>
    </div>

    <div class="panel">
      <div class="panel-head"><h2>请求明细</h2><span class="sub">最近 ${stats.recent.length} 条</span></div>
      <div class="panel-body flush"><div class="table-wrap"><table class="table">
        <thead><tr><th>时间</th><th>模型</th><th>账户</th><th>密钥</th><th>服务商</th><th class="num">Token</th><th class="num">耗时</th><th>状态</th></tr></thead>
        <tbody>${stats.recent.length === 0 ? '<tr><td colspan="8"><div class="empty">暂无请求</div></td></tr>' : stats.recent.map((row) => `
          <tr>
            <td class="small muted nowrap">${esc(fmtTime(row.ts))}</td>
            <td class="model-id truncate" title="${esc(row.model)}">${esc(row.model)}</td>
            <td>${esc(row.accountName || '—')}</td>
            <td>${esc(row.keyName || '—')}</td>
            <td class="small">${esc(row.provider || '—')}</td>
            <td class="num">${fmtNum(row.totalTokens)}</td>
            <td class="num">${row.ms}ms</td>
            <td>${row.error ? `<span class="badge danger" title="${esc(row.error)}">失败</span>` : '<span class="badge ok">成功</span>'}</td>
          </tr>`).join('')}</tbody>
      </table></div></div>
    </div>`
}

async function loadOverviewStats() {
  const mount = $('#overview-stats')
  if (!mount) return
  if (S.stats && !S.statsError) mount.innerHTML = statsSectionHtml(S.stats)
  else mount.innerHTML = '<div class="empty">正在读取用量统计…</div>'
  await loadStats()
  const current = $('#overview-stats')
  if (!current) return
  if (S.statsError) {
    current.innerHTML = `<div class="panel"><div class="panel-body"><div class="empty">统计读取失败：${esc(S.statsError)}</div><button class="btn primary" data-action="reload-stats" style="margin:12px auto 0;display:block">重试</button></div></div>`
    return
  }
  current.innerHTML = S.stats ? statsSectionHtml(S.stats) : '<div class="empty">暂无统计数据</div>'
}

/* ── settings ──────────────────────────────────────────────────────────── */

function renderSettings() {
  const settings = S.data.settings
  const enabledAccounts = S.data.accounts.filter((account) => account.enabled)
  view.innerHTML = `
    <form class="panel" id="settings-form">
      <div class="panel-head"><h2>服务设置</h2><span class="sub">保存后立即生效（端口与监听地址需改配置文件并重启）</span></div>
      <div class="panel-body">
        <div class="grid-2">
          <div>
            <label class="field"><span>上游 Base URL</span><input name="baseURL" value="${esc(settings.baseURL)}"><span class="hint">默认 https://api.cline.bot/api/v1</span></label>
            <label class="field"><span>账户调度模式</span>
              <select name="accountMode">
                <option value="roundrobin" ${settings.accountMode === 'roundrobin' ? 'selected' : ''}>轮询 round-robin</option>
                <option value="single" ${settings.accountMode === 'single' ? 'selected' : ''}>单账户 single</option>
              </select>
            </label>
            <label class="field"><span>单账户模式下优先使用的账户</span>
              <select name="activeAccountId">
                <option value="">自动（第一个可用账户）</option>
                ${enabledAccounts.map((account) => `<option value="${esc(account.id)}" ${settings.activeAccountId === account.id ? 'selected' : ''}>${esc(account.name)}</option>`).join('')}
              </select>
            </label>
            <label class="field" style="grid-template-columns:auto 1fr;align-items:center">
              <span class="switch"><input type="checkbox" name="allowUnknownModels" ${settings.allowUnknownModels ? 'checked' : ''}><span></span></span>
              <span>允许未知模型（不在目录中的模型直接转发）</span>
            </label>
            <label class="field" style="grid-template-columns:auto 1fr;align-items:center">
              <span class="switch"><input type="checkbox" name="cors" ${settings.cors ? 'checked' : ''}><span></span></span>
              <span>为 /v1 开启 CORS</span>
            </label>
            <label class="field" style="grid-template-columns:auto 1fr;align-items:center">
              <span class="switch"><input type="checkbox" name="publicDashboard" ${settings.publicDashboard ? 'checked' : ''}><span></span></span>
              <span>开启公开展示页（无需管理员令牌）</span>
            </label>
            <div class="hint" style="margin:-2px 0 12px">公开地址：<a href="/public" target="_blank" rel="noreferrer">/public</a> · 只展示打码后的账户名、账号状态和今日汇总，不含 Key、完整账户名或请求内容。</div>
            <label class="field" style="grid-template-columns:auto 1fr;align-items:center">
              <span class="switch"><input type="checkbox" name="stripModelPrefix" ${settings.stripModelPrefix ? 'checked' : ''}><span></span></span>
              <span>去掉 /v1 模型名的 cline-pass/ 前缀</span>
            </label>
            <div class="hint" style="margin:-2px 0 12px">开启后 /v1/models 与 /v1 响应里的 model 返回短名（如 glm-5.3）；后台仍用完整 ID 管理钉住，两种写法都可以请求。</div>
          </div>
          <div>
            <label class="field" style="grid-template-columns:auto 1fr;align-items:center">
              <span class="switch"><input type="checkbox" name="quotaEnabled" ${settings.quotaGuard.enabled ? 'checked' : ''}><span></span></span>
              <span>额度守卫（达到阈值时优先使用其他账户）</span>
            </label>
            <div class="grid-2">
              <label class="field"><span>额度阈值（%）</span><input name="quotaThreshold" type="number" min="1" max="100" value="${esc(settings.quotaGuard.threshold)}"></label>
              <label class="field"><span>额度刷新间隔（秒）</span><input name="quotaRefresh" type="number" min="30" value="${Math.round(settings.quotaGuard.refreshMs / 1000)}"></label>
            </div>
            <div class="grid-2">
              <label class="field"><span>额度耗尽冷却（分钟）</span><input name="coolQuota" type="number" min="0" value="${Math.round(settings.cooldown.quotaMs / 60000)}"></label>
              <label class="field"><span>鉴权失败冷却（分钟）</span><input name="coolAuth" type="number" min="0" value="${Math.round(settings.cooldown.authMs / 60000)}"></label>
            </div>
            <label class="field"><span>限流冷却（秒）</span><input name="coolRate" type="number" min="0" value="${Math.round(settings.cooldown.rateLimitMs / 1000)}"></label>
            <div class="grid-2">
              <label class="field"><span>连接超时（秒）</span><input name="connectTimeout" type="number" min="5" value="${Math.round(settings.timeouts.connectTimeoutMs / 1000)}"></label>
              <label class="field"><span>非流式总超时（秒）</span><input name="requestTimeout" type="number" min="10" value="${Math.round(settings.timeouts.requestTimeoutMs / 1000)}"></label>
            </div>
            <label class="field"><span>流空闲超时（秒）</span><input name="idleTimeout" type="number" min="10" value="${Math.round(settings.timeouts.idleTimeoutMs / 1000)}"></label>
          </div>
        </div>
      </div>
      <div class="modal-foot" style="border-top:1px solid var(--line)">
        <button class="btn primary" type="submit">保存设置</button>
      </div>
    </form>`

  $('#settings-form').addEventListener('submit', async (event) => {
    event.preventDefault()
    const form = event.target
    const number = (name) => Number(form.elements[name].value)
    try {
      await api('/settings', {
        method: 'PATCH',
        body: {
          baseURL: form.elements.baseURL.value.trim(),
          accountMode: form.elements.accountMode.value,
          activeAccountId: form.elements.activeAccountId.value,
          allowUnknownModels: form.elements.allowUnknownModels.checked,
          cors: form.elements.cors.checked,
          publicDashboard: form.elements.publicDashboard.checked,
          stripModelPrefix: form.elements.stripModelPrefix.checked,
          quotaGuard: {
            enabled: form.elements.quotaEnabled.checked,
            threshold: number('quotaThreshold'),
            refreshMs: number('quotaRefresh') * 1000,
          },
          cooldown: {
            quotaMs: number('coolQuota') * 60000,
            authMs: number('coolAuth') * 60000,
            rateLimitMs: number('coolRate') * 1000,
          },
          timeouts: {
            connectTimeoutMs: number('connectTimeout') * 1000,
            requestTimeoutMs: number('requestTimeout') * 1000,
            idleTimeoutMs: number('idleTimeout') * 1000,
          },
        },
      })
      await loadState()
      toast('设置已保存')
    } catch (error) {
      toast(error.message, 'err')
    }
  })
}

/* ── delegated actions ─────────────────────────────────────────────────── */

view.addEventListener('click', async (event) => {
  const target = event.target.closest('[data-action]')
  if (!target) return
  const action = target.dataset.action
  const id = target.dataset.id

  try {
    if (action === 'goto-accounts') {
      S.tab = 'accounts'
      renderView()
      return
    }

    if (action === 'add-account') {
      accountModal(null)
      return
    }
    if (action === 'edit-account') {
      accountModal(S.data.accounts.find((account) => account.id === id))
      return
    }
    if (action === 'delete-account') {
      const account = S.data.accounts.find((entry) => entry.id === id)
      if (!confirm(`确定删除账户「${account?.name ?? id}」？该操作不可撤销。`)) return
      await api(`/accounts/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await loadState()
      toast('账户已删除')
      return
    }
    if (action === 'test-account') {
      target.disabled = true
      target.textContent = '测试中…'
      const result = await api(`/accounts/${encodeURIComponent(id)}/test`, { method: 'POST', body: {} })
      toast(result.ok ? `鉴权正常（${result.ms}ms，模型 ${result.model}）` : `测试失败：${result.error}`, result.ok ? 'ok' : 'err')
      return
    }
    if (action === 'refresh-account') {
      target.disabled = true
      const result = await api(`/accounts/${encodeURIComponent(id)}/usage`, { method: 'POST', body: { days: 0 } })
      S.data.accounts = S.data.accounts.map((account) => account.id === id ? result.account : account)
      renderAccounts()
      toast(result.quota.ok ? '额度已刷新' : `额度读取失败：${result.quota.error}`, result.quota.ok ? 'ok' : 'err')
      return
    }
    if (action === 'refresh-all-usage') {
      for (const account of S.data.accounts) {
        await api(`/accounts/${encodeURIComponent(account.id)}/usage`, { method: 'POST', body: { days: 0 } }).catch(() => {})
      }
      await loadState()
      toast('全部账户额度已刷新')
      return
    }
    if (action === 'daily-account') {
      const account = S.data.accounts.find((entry) => entry.id === id)
      if (account) await showDailyUsage(account)
      return
    }
    if (action === 'add-key') {
      openFormModal({
        title: '新建接入密钥',
        submitText: '创建',
        fields: '<label class="field"><span>名称</span><input name="name" placeholder="例如：lobe-chat" required></label><div class="muted small">创建后会显示一次完整密钥，请复制保存。</div>',
        onSubmit: async (form) => {
          const result = await api('/keys', { method: 'POST', body: { name: String(form.get('name') ?? '').trim() } })
          await loadState()
          showSecret(result.key)
          return 'keep-open'
        },
      })
      return
    }
    if (action === 'delete-key') {
      if (!confirm('确定删除这个接入密钥？使用它的客户端会立即失去访问权限。')) return
      await api(`/keys/${encodeURIComponent(id)}`, { method: 'DELETE' })
      await loadState()
      toast('密钥已删除')
      return
    }
    if (action === 'refresh-models') {
      target.disabled = true
      const result = await api('/models/refresh', { method: 'POST', body: {} })
      await loadState()
      toast(result.added.length > 0 ? `新增 ${result.added.length} 个模型` : '模型目录已是最新')
      return
    }
    if (action === 'add-model') {
      openFormModal({
        title: '手动添加模型',
        submitText: '添加',
        fields: '<label class="field"><span>模型 ID</span><input name="id" placeholder="cline-pass/..." required></label><label class="field" style="grid-template-columns:auto 1fr;align-items:center"><span class="switch"><input type="checkbox" name="enabled" checked><span></span></span><span>立即开放</span></label>',
        onSubmit: async (form) => {
          await api('/models', { method: 'POST', body: { id: String(form.get('id') ?? '').trim(), enabled: form.get('enabled') === 'on' } })
          await loadState()
          toast('模型已添加')
        },
      })
      return
    }
    if (action === 'expand-model') {
      if (S.expanded.has(id)) S.expanded.delete(id)
      else S.expanded.add(id)
      const list = $('#models-list')
      if (list) list.innerHTML = modelsTable()
      return
    }
    if (action === 'pin-toggle') {
      const model = findModel(id)
      if (!model) return
      const pin = { ...model.pin, upstreams: [...model.pin.upstreams], exclude: [...model.pin.exclude] }
      const name = target.dataset.name
      const kind = target.dataset.kind
      if (kind === 'upstream') {
        if (pin.upstreams.includes(name)) pin.upstreams = pin.upstreams.filter((value) => value !== name)
        else {
          pin.upstreams.push(name)
          pin.exclude = pin.exclude.filter((value) => value !== name)
        }
      } else {
        if (pin.exclude.includes(name)) pin.exclude = pin.exclude.filter((value) => value !== name)
        else {
          pin.exclude.push(name)
          pin.upstreams = pin.upstreams.filter((value) => value !== name)
        }
      }
      await savePin(model, pin)
      return
    }
    if (action === 'pin-move') {
      const model = findModel(id)
      if (!model) return
      const index = Number(target.dataset.index)
      const direction = target.dataset.dir === 'up' ? -1 : 1
      const list = [...model.pin.upstreams]
      const next = index + direction
      if (next < 0 || next >= list.length) return
      const [item] = list.splice(index, 1)
      list.splice(next, 0, item)
      await savePin(model, { ...model.pin, upstreams: list })
      return
    }
    if (action === 'probe-model') {
      target.disabled = true
      target.textContent = '探测中…'
      const response = await api(`/models/${encodeURIComponent(id)}/probe`, { method: 'POST', body: {} })
      await loadState()
      const result = response.result
      toast(result.ok ? `探测完成：${result.upstreams.length} 个服务商，链路 ${result.pipeline || '未知'}，当前由 ${result.lastProvider || '未知'} 服务` : `探测失败：${result.error}`, result.ok ? 'ok' : 'err')
      return
    }
    if (action === 'validate-model') {
      target.disabled = true
      target.textContent = '校验中…'
      const response = await api(`/models/${encodeURIComponent(id)}/validate`, { method: 'POST', body: {} })
      S.validateResults[id] = response.results
      await loadState()
      const ok = response.results.filter((row) => row.status === 'ok').length
      toast(`校验完成：${ok}/${response.results.length} 个服务商钉住生效`, ok > 0 ? 'ok' : 'err')
      return
    }
    if (action === 'test-pin') {
      target.disabled = true
      target.textContent = '测试中…'
      const response = await api(`/models/${encodeURIComponent(id)}/test`, { method: 'POST', body: {} })
      S.testResults[id] = response
      await loadState({ quiet: true })
      toast(response.ok
        ? `钉住生效：由 ${response.actual || response.expected} 服务`
        : (response.note || `钉住未生效：实际由 ${response.actual || '未知'} 服务`),
      response.ok ? 'ok' : 'err')
      return
    }
    if (action === 'stats-days') {
      S.statsDays = Number(target.dataset.days)
      S.stats = null
      S.statsError = ''
      await loadOverviewStats()
      return
    }
    if (action === 'reload-stats') {
      S.stats = null
      S.statsError = ''
      await loadOverviewStats()
      return
    }
  } catch (error) {
    if (error instanceof AuthError) {
      showLogin('登录已失效，请重新输入管理员令牌')
      return
    }
    toast(error.message, 'err')
  }
})

view.addEventListener('change', async (event) => {
  const target = event.target
  try {
    if (target.matches('[data-action="toggle-model"]')) {
      const id = target.dataset.id
      await api(`/models/${encodeURIComponent(id)}`, { method: 'PATCH', body: { enabled: target.checked } })
      const model = findModel(id)
      if (model) model.enabled = target.checked
      toast(target.checked ? '模型已开放' : '模型已关闭')
      return
    }
    if (target.matches('[data-action="toggle-account"]')) {
      const id = target.dataset.id
      await api(`/accounts/${encodeURIComponent(id)}`, { method: 'PATCH', body: { enabled: target.checked } })
      await loadState()
      return
    }
    if (target.matches('[data-action="toggle-key"]')) {
      const id = target.dataset.id
      await api(`/keys/${encodeURIComponent(id)}`, { method: 'PATCH', body: { enabled: target.checked } })
      await loadState()
      toast(target.checked ? '密钥已启用' : '密钥已停用')
      return
    }
    if (target.matches('[data-role^="pin-"]')) {
      const id = target.dataset.id
      const model = findModel(id)
      if (!model) return
      const field = target.dataset.role === 'pin-mode' ? 'pinMode' : target.dataset.role === 'pin-sort' ? 'sort' : 'spelling'
      await savePin(model, { ...model.pin, [field]: target.value })
      return
    }
  } catch (error) {
    if (error instanceof AuthError) {
      showLogin('登录已失效，请重新输入管理员令牌')
      return
    }
    toast(error.message, 'err')
  }
})

/* ── boot ──────────────────────────────────────────────────────────────── */

$('#login-form').addEventListener('submit', (event) => {
  event.preventDefault()
  const token = $('#login-token').value.trim()
  if (token) login(token)
})

$('#logout-btn').addEventListener('click', logout)

for (const item of document.querySelectorAll('.nav-item')) {
  item.addEventListener('click', () => {
    S.tab = item.dataset.tab
    renderView()
  })
}

$('#refresh-btn').addEventListener('click', () => loadState())

setInterval(() => {
  if (S.token && S.data && $('#modal-root').children.length === 0) loadState({ quiet: true })
}, 30000)

if (S.token) {
  login(S.token)
} else {
  showLogin()
}
