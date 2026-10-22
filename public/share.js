const $ = (selector) => document.querySelector(selector)
const numberFormat = new Intl.NumberFormat('zh-CN')

const QUOTA_LABELS = {
  five_hour: '5 小时',
  weekly: '本周',
  monthly: '本月',
}

const COOL_LABELS = {
  QUOTA: '额度冷却',
  AUTH: '鉴权冷却',
  RATE_LIMIT: '限流冷却',
}

function esc(value) {
  return String(value ?? '')
    .replaceAll('&', '&amp;')
    .replaceAll('<', '&lt;')
    .replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;')
    .replaceAll("'", '&#39;')
}

function fmtNum(value) {
  return numberFormat.format(Number(value) || 0)
}

function clock(ts) {
  const date = new Date(Number(ts) || 0)
  if (Number.isNaN(date.getTime())) return '—'
  return date.toLocaleTimeString('zh-CN', { hour: '2-digit', minute: '2-digit', second: '2-digit', hour12: false })
}

function dayLabel(ts) {
  const date = new Date(Number(ts) || Date.now())
  return date.toLocaleDateString('zh-CN', { year: 'numeric', month: '2-digit', day: '2-digit' })
}

function percentClass(percent) {
  if (percent >= 90) return 'danger'
  if (percent >= 70) return 'warn'
  return ''
}

function todayCards(today) {
  const cards = [
    { label: '今日请求', value: fmtNum(today.requests), foot: `错误 ${fmtNum(today.errors)} 次` },
    { label: '今日 Token', value: fmtNum(today.totalTokens), foot: '输入 + 输出' },
    { label: '输入 Token', value: fmtNum(today.promptTokens), foot: `缓存命中 ${fmtNum(today.cachedTokens)}` },
    { label: '输出 Token', value: fmtNum(today.completionTokens), foot: `推理 ${fmtNum(today.reasoningTokens)}` },
    { label: '错误次数', value: fmtNum(today.errors), foot: today.requests > 0 ? `错误率 ${((today.errors / today.requests) * 100).toFixed(1)}%` : '还没有请求' },
  ]
  $('#today-cards').innerHTML = cards.map((card) => `
    <div class="card">
      <div class="card-label">${esc(card.label)}</div>
      <div class="card-value">${esc(card.value)}</div>
      <div class="card-foot">${esc(card.foot)}</div>
    </div>`).join('')
  $('#today-date').textContent = dayLabel(Date.now())
}

function statusOf(account) {
  if (account.status === 'disabled') return { label: '已停用', cls: 'off', note: '已停用，不参与调度' }
  if (account.status === 'cooling') {
    const until = account.cooling?.until ? `，预计 ${clock(account.cooling.until)} 恢复` : ''
    return { label: '冷却中', cls: 'warn', note: `${COOL_LABELS[account.cooling?.code] ?? '冷却中'}${until}` }
  }
  return { label: '正常', cls: 'ok', note: '服务正常，参与调度' }
}

function quotaHtml(quota) {
  if (!quota || !Array.isArray(quota.limits) || quota.limits.length === 0) {
    return '<div class="muted small">额度暂不可用</div>'
  }
  const rows = quota.limits.map((limit) => {
    const percent = Math.max(0, Math.min(100, Number(limit.percentUsed) || 0))
    const label = QUOTA_LABELS[limit.type] ?? limit.type ?? '额度'
    return `<div class="quota-row">
      <span>${esc(label)}</span>
      <div class="bar"><i class="${percentClass(percent)}" style="width:${percent}%"></i></div>
      <b>${percent.toFixed(0)}%</b>
    </div>`
  }).join('')
  const updated = quota.at ? `额度读取于 ${clock(quota.at)}` : ''
  return `${rows}${updated ? `<div class="muted small" style="margin-top:9px">${esc(updated)}</div>` : ''}`
}

function render(data) {
  todayCards(data.today)

  const summary = data.summary
  $('#account-summary').textContent = `${summary.accounts} 个账户 · ${summary.active} 正常 · ${summary.cooling} 冷却 · ${summary.disabled} 停用`

  if (!Array.isArray(data.accounts) || data.accounts.length === 0) {
    $('#accounts').innerHTML = '<div class="empty">还没有配置账户</div>'
  } else {
    $('#accounts').innerHTML = data.accounts.map((account) => {
      const status = statusOf(account)
      return `<article class="account ${esc(account.status)}">
        <div class="account-head">
          <span class="account-name">${esc(account.name)}</span>
          <span class="pill ${status.cls}">${esc(status.label)}</span>
        </div>
        <div class="account-note">${esc(status.note)}</div>
        ${quotaHtml(account.quota)}
      </article>`
    }).join('')
  }

  $('#updated').textContent = `更新于 ${clock(data.generatedAt)} · 30 秒自动刷新`
  $('#live-dot').classList.remove('off')
  $('#error').hidden = true
}

async function refresh() {
  try {
    const response = await fetch('/public/api/state', { cache: 'no-store', headers: { Accept: 'application/json' } })
    if (!response.ok) throw new Error(response.status === 404 ? '公开状态页未开启' : `读取失败（${response.status}）`)
    render(await response.json())
  } catch (error) {
    $('#updated').textContent = '暂时无法读取公开状态'
    $('#live-dot').classList.add('off')
    const banner = $('#error')
    banner.textContent = `${error?.message ?? error}。请确认公开状态页已开启。`
    banner.hidden = false
  }
}

refresh()
setInterval(refresh, 30_000)
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') refresh()
})
