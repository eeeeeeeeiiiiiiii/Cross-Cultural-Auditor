/**
 * 跨文化审核官 · 前端
 * 原则：不引入任何框架/构建，DOM 直接操作；所有文本用 textContent 注入，不拼 HTML。
 */

/* ────────────────────────── 状态 ────────────────────────── */

const state = {
  markets: [],            // [{id,label,code,locale,language,nativeName,dir}]
  selected: new Set(),
  active: 'us',
  running: false,
  mock: false,
  startedAt: 0,
  controller: null,
  translations: {},       // 用户为每个市场准备的译文 {id: text}
  results: {},            // id -> { status, translation, source, findings, summary, score, ... }
  prefs: null,            // 网页设置：主题 / 字号 / 动效
  logs: [],               // 最近调用日志
  logFilter: 'all',
  settings: null,         // 当前生效的服务商配置
  store: null,            // { provider, profiles } 全部服务商的档案
  fetchedModels: [],      // 服务商真返回的模型（只有它算权威）
  serverModel: null,      // 服务端 .env 里配的模型名，用于角标
}

const CATEGORY_LABEL = {
  skin_race: '肤色与种族',
  religion: '宗教与节日',
  gender: '性别与刻板',
  inclusive: '残障与包容',
  legal: '法律与合规',
  symbol: '符号与意象',
  tone: '语气与礼数',
  literal: '直译失真',
}

const SEV_CLASS = { P0: 's0', P1: 's1', P2: 's2', P3: 's3' }
const SEV_LOWER = { P0: 'p0', P1: 'p1', P2: 'p2', P3: 'p3' }

const EXAMPLES = {
  beauty: '我们的面膜采用天然草本精华，一抹即白，让您爱不释手。女神节送礼首选！',
  tech: '这款耳机采用航空级铝合金，音质震撼，续航长达 48 小时，是年轻人的第一款高端耳机。双十一狂欢价，买就送！',
  tea: '新中式茶饮，古法手作，零添加。喝出东方韵味，做朋友圈最靓的仔。女性用户专享第二杯半价。',
}

/* ────────────────────────── 小工具 ────────────────────────── */

const $ = (id) => document.getElementById(id)

const els = {
  markets: $('markets'),
  modeBadge: $('modeBadge'),
  source: $('source'),
  translation: $('translation'),
  counter: $('counter'),
  aiBtn: $('aiBtn'),
  tone: $('tone'),
  toneCustom: $('toneCustom'),
  runBtn: $('runBtn'),
  tabs: $('tabs'),
  activeMarket: $('activeMarket'),
  transMeta: $('transMeta'),
  trans: $('trans'),
  empty: $('emptyState'),
  verdict: $('verdict'),
  legendNote: $('legendNote'),
  reportMeta: $('reportMeta'),
  scorewrap: $('scorewrap'),
  ring: $('ring'),
  scoreNum: $('scoreNum'),
  levelLabel: $('levelLabel'),
  bars: $('bars'),
  reason: $('reason'),
  cards: $('cards'),
  reportEmpty: $('reportEmpty'),
  safeBtn: $('safeBtn'),
  undoBtn: $('undoBtn'),
  exportBtn: $('exportBtn'),
  copyBtn: $('copyBtn'),
  timing: $('timing'),
  statusbar: $('statusbar'),
  statusText: $('statusText'),
  toast: $('toast'),

  prefsBtn: $('prefsBtn'),
  prefsModal: $('prefsModal'),
  swatches: $('swatches'),
  fsSeg: $('fsSeg'),
  motionSeg: $('motionSeg'),
  resetPrefs: $('resetPrefs'),
  openLogsBtn: $('openLogsBtn'),

  logsModal: $('logsModal'),
  logsMeta: $('logsMeta'),
  logList: $('logList'),
  logFilter: $('logFilter'),
  refreshLogs: $('refreshLogs'),
  clearLogs: $('clearLogs'),

  settingsModal: $('settingsModal'),
  providers: $('providers'),
  baseUrl: $('baseUrl'),
  useProxy: $('useProxy'),
  proxyField: $('proxyField'),
  proxyUrl: $('proxyUrl'),
  apiKey: $('apiKey'),
  peekBtn: $('peekBtn'),
  model: $('model'),
  modelPanel: $('modelPanel'),
  modelToggle: $('modelToggle'),
  modelHint: $('modelHint'),
  fetchModels: $('fetchModels'),
  testBtn: $('testBtn'),
  testResult: $('testResult'),
  saveBtn: $('saveBtn'),
  clearBtn: $('clearBtn'),
}

let toastTimer = null
function toast(message, isError = false) {
  els.toast.textContent = message
  els.toast.classList.toggle('err', Boolean(isError))
  els.toast.hidden = false
  requestAnimationFrame(() => els.toast.classList.add('show'))
  clearTimeout(toastTimer)
  toastTimer = setTimeout(() => {
    els.toast.classList.remove('show')
    setTimeout(() => (els.toast.hidden = true), 240)
  }, isError ? 4200 : 2400)
}

function setStatus(text) {
  els.statusText.textContent = text || ''
  els.statusbar.classList.toggle('idle', !text)
}

const marketOf = (id) => state.markets.find((m) => m.id === id) ?? { id, label: id, code: id, dir: 'ltr' }

/** 与后端一致的确定性打分（演示模式离线时要用） */
function scoreOf(findings = []) {
  const penalty = { P0: 25, P1: 12, P2: 5, P3: 2 }
  const distribution = { P0: 0, P1: 0, P2: 0, P3: 0 }
  let sum = 0
  for (const f of findings) {
    if (distribution[f.severity] === undefined) continue
    distribution[f.severity]++
    sum += penalty[f.severity]
  }
  const score = Math.max(0, Math.min(100, 100 - sum))
  const levels = [
    [90, '安全', 'ok'],
    [70, '需留意', 'p2'],
    [50, '建议修改', 'p1'],
    [30, '高风险', 'p0'],
    [0, '危险', 'p0'],
  ]
  const [, label, tone] = levels.find(([min]) => score >= min) ?? levels.at(-1)
  return { score, level: label, tone, distribution, penalty: sum }
}

/* ────────────────────────── 渲染：顶栏与标签页 ────────────────────────── */

function renderChips() {
  els.markets.replaceChildren(
    ...state.markets.map((m) => {
      const chip = document.createElement('button')
      chip.type = 'button'
      chip.className = 'chip' + (state.selected.has(m.id) ? ' on' : '')
      chip.dataset.id = m.id
      const box = document.createElement('i')
      box.className = 'box'
      box.textContent = state.selected.has(m.id) ? '✓' : ''
      const cc = document.createElement('span')
      cc.className = 'cc'
      cc.textContent = m.code
      chip.append(box, cc, document.createTextNode(m.label))
      return chip
    }),
  )
}

function renderTabs() {
  const ids = state.markets.map((m) => m.id).filter((id) => state.selected.has(id))
  els.tabs.replaceChildren(
    ...ids.map((id) => {
      const m = marketOf(id)
      const r = state.results[id]
      const tab = document.createElement('button')
      tab.type = 'button'
      tab.className = 'tab' + (id === state.active ? ' on' : '')
      tab.dataset.id = id
      tab.append(document.createTextNode(m.label))

      if (r?.status === 'ready' || r?.status === 'partial') {
        const badge = document.createElement('span')
        const n = r.findings?.length ?? 0
        const worst = r.findings?.[0]?.severity
        badge.className = 'badge ' + (n === 0 ? 'ok' : SEV_LOWER[worst] ?? 'ok')
        badge.textContent = n === 0 ? '✓' : String(n)
        tab.append(badge)
      }
      return tab
    }),
  )
}

/* ────────────────────────── 渲染：译文 ────────────────────────── */

/** 计算互不重叠的可定位区间 */
function buildSegments(text, findings = []) {
  const candidates = []
  for (const f of findings) {
    if (!f.targetQuote || !f.suggestions?.length) continue
    const idx = text.indexOf(f.targetQuote)
    if (idx < 0) continue
    candidates.push({ f, start: idx, end: idx + f.targetQuote.length })
  }
  candidates.sort((a, b) => a.start - b.start || b.end - b.start - (a.end - a.start))
  const out = []
  let last = -1
  for (const c of candidates) {
    if (c.start >= last) {
      out.push(c)
      last = c.end
    }
  }
  return out
}

/** 把已采纳的修改合成为最终文本（复制 / 导出用） */
function composeText(r) {
  if (!r?.translation) return ''
  const segs = buildSegments(r.translation, r.findings || [])
  if (!segs.length) return r.translation
  let out = ''
  let cursor = 0
  for (const s of segs) {
    out += r.translation.slice(cursor, s.start)
    out += r.applied?.has(s.f.id) ? s.f.suggestions[0].text : r.translation.slice(s.start, s.end)
    cursor = s.end
  }
  return out + r.translation.slice(cursor)
}

function appliedCount(r) {
  if (!r?.findings) return 0
  const segs = buildSegments(r.translation, r.findings)
  return segs.filter((s) => r.applied?.has(s.f.id)).length
}

function renderTranslation() {
  const r = state.results[state.active]
  const m = marketOf(state.active)

  els.activeMarket.textContent = `${m.label} · ${m.locale}`

  if (!r || r.status === 'idle' || (!r.translation && r.status !== 'translating')) {
    els.trans.hidden = true
    els.verdict.hidden = true
    els.empty.hidden = false
    els.transMeta.textContent = ''
    els.legendNote.textContent = ''
    return
  }

  els.empty.hidden = true
  els.trans.hidden = false
  els.trans.dir = m.dir === 'rtl' ? 'rtl' : 'ltr'
  els.trans.classList.toggle('rtl', m.dir === 'rtl')
  els.trans.classList.toggle('typing', r.status === 'translating')

  const text = r.translation || ''
  const segs = buildSegments(text, r.findings || [])

  if (!segs.length) {
    els.trans.textContent = text
  } else {
    const frag = document.createDocumentFragment()
    let cursor = 0
    for (const seg of segs) {
      frag.append(document.createTextNode(text.slice(cursor, seg.start)))
      const mark = document.createElement('mark')
      mark.className = `hl ${SEV_LOWER[seg.f.severity] ?? 'p3'}`
      mark.dataset.id = seg.f.id
      if (r.applied?.has(seg.f.id)) {
        mark.classList.add('applied')
        const del = document.createElement('del')
        del.textContent = text.slice(seg.start, seg.end)
        const ins = document.createElement('ins')
        ins.textContent = seg.f.suggestions[0].text
        mark.append(del, ins)
      } else {
        mark.textContent = text.slice(seg.start, seg.end)
      }
      frag.append(mark)
      cursor = seg.end
    }
    frag.append(document.createTextNode(text.slice(cursor)))
    els.trans.replaceChildren(frag)
  }

  // 本市场结论条
  if (r.summary && r.status !== 'translating') {
    els.verdict.hidden = false
    els.verdict.classList.toggle('ok', (r.score ?? 100) >= 70)
    els.verdict.replaceChildren()
    const head = document.createElement('div')
    head.className = 'vh'
    const dot = document.createElement('i')
    head.append(dot, document.createTextNode(`本市场结论 · ${m.label}`))
    const body = document.createElement('div')
    body.className = 'vt'
    body.textContent = r.summary
    els.verdict.append(head, body)
  } else {
    els.verdict.hidden = true
  }

  const total = segs.length
  const applied = segs.filter((s) => r.applied?.has(s.f.id)).length
  const originLabel = r.source === 'user' ? '你提供的译文' : r.source === 'ai' ? 'AI 翻译' : m.language
  els.transMeta.textContent = r.status === 'translating' ? 'AI 翻译中…' : originLabel
  els.legendNote.textContent = total && applied ? `已修正 ${applied}/${total} 处` : ''
}

/* ────────────────────────── 渲染：报告 ────────────────────────── */

function renderReport() {
  const r = state.results[state.active]

  if (!r || r.status === 'idle' || r.status === 'translating' || r.status === 'translated') {
    els.scorewrap.hidden = true
    els.reportEmpty.hidden = false
    els.cards.replaceChildren()
    els.reportMeta.textContent =
      r?.status === 'translating' ? '等待译文…' : r?.status === 'translated' ? '正在审查…' : '等待审核'
    els.safeBtn.disabled = true
    els.undoBtn.disabled = true
    els.exportBtn.disabled = true
    els.copyBtn.disabled = !r?.translation
    return
  }

  if (r.status === 'error' || (r.status === 'partial' && !(r.findings || []).length)) {
    els.scorewrap.hidden = true
    els.reportEmpty.hidden = true
    const box = document.createElement('div')
    box.className = 'empty'
    box.append(
      Object.assign(document.createElement('p'), {
        textContent: r.status === 'partial' ? '审查没跑完，译文还能用' : '这个市场翻译失败了',
      }),
      Object.assign(document.createElement('p'), { className: 'dim', textContent: r.error || '未知错误' }),
      Object.assign(document.createElement('p'), {
        className: 'dim',
        textContent: '可以重试，或先复制译文手动检查',
      }),
    )
    els.cards.replaceChildren(box)
    els.reportMeta.textContent = '失败'
    els.safeBtn.disabled = true
    els.undoBtn.disabled = true
    els.exportBtn.disabled = false
    els.copyBtn.disabled = !r.translation
    return
  }

  const findings = r.findings || []
  const s = r.score ?? scoreOf(findings).score
  const level = r.level ?? scoreOf(findings).level
  const tone = r.tone ?? scoreOf(findings).tone
  const colorVar = { ok: '--ok', p0: '--p0', p1: '--p1', p2: '--p2', p3: '--p3' }[tone] || '--p3'

  els.reportEmpty.hidden = true
  els.scorewrap.hidden = false
  els.ring.style.setProperty('--v', String(s))
  els.ring.style.setProperty('--rc', `var(${colorVar})`)
  els.scoreNum.replaceChildren(document.createTextNode(String(s)))
  const small = document.createElement('small')
  small.textContent = '/100'
  els.scoreNum.append(small)

  els.levelLabel.replaceChildren()
  const b = document.createElement('b')
  b.textContent = `${tone === 'ok' ? '●' : '●'} ${level}`
  b.style.color = `var(${colorVar})`
  els.levelLabel.append(b)

  const dist = r.distribution ?? scoreOf(findings).distribution
  const max = Math.max(1, ...Object.values(dist))
  els.bars.replaceChildren(
    ...['P0', 'P1', 'P2', 'P3'].map((sev) => {
      const row = document.createElement('div')
      row.className = 'bar'
      const k = document.createElement('span')
      k.className = 'k'
      k.textContent = sev
      k.style.color = `var(--${SEV_LOWER[sev]})`
      const track = document.createElement('span')
      track.className = 'track'
      const fill = document.createElement('i')
      fill.className = 'fill'
      fill.style.width = `${(dist[sev] / max) * 100}%`
      fill.style.background = `var(--${SEV_LOWER[sev]})`
      track.append(fill)
      const c = document.createElement('span')
      c.className = 'c'
      c.textContent = String(dist[sev])
      row.append(k, track, c)
      return row
    }),
  )

  const sc = scoreOf(findings)
  els.reason.textContent = findings.length ? `累计扣分 ${sc.penalty} 分（P0 −25 / P1 −12 / P2 −5 / P3 −2）` : '未发现需要修改的问题'

  els.reportMeta.textContent = findings.length ? `${findings.length} 条 · ${marketOf(state.active).label}` : '未发现问题'

  els.cards.replaceChildren(...findings.map((f) => renderCard(f, r)))

  els.safeBtn.disabled = !findings.length
  els.exportBtn.disabled = false
  els.copyBtn.disabled = !r.translation

  const applicable = buildSegments(r.translation, findings).length
  const done = appliedCount(r)
  els.safeBtn.textContent = done && done >= applicable ? '✓ 已生成安全版' : '⚡ 一键生成安全版'
  if (done && done >= applicable) els.safeBtn.disabled = true
  els.undoBtn.disabled = !done
  els.undoBtn.textContent = done ? `一键撤销（${done}）` : '一键撤销'
}

function renderCard(f, r) {
  const card = document.createElement('div')
  card.className = `card ${SEV_CLASS[f.severity] ?? ''}`
  card.dataset.id = f.id

  const top = document.createElement('div')
  top.className = 'top'
  const sev = document.createElement('span')
  sev.className = `sev ${SEV_LOWER[f.severity]}`
  sev.textContent = f.severity
  const cat = document.createElement('span')
  cat.className = 'cat'
  cat.textContent = CATEGORY_LABEL[f.category] ?? f.category
  const conf = document.createElement('span')
  conf.className = 'conf'
  conf.textContent = `置信 ${(f.confidence ?? 0).toFixed(2)}`
  top.append(sev, cat, conf)

  const q = document.createElement('div')
  q.className = 'q'
  const src = document.createElement('span')
  src.className = 'src'
  src.textContent = `「${f.sourceQuote || '—'}」`
  const arrow = document.createElement('span')
  arrow.className = 'arrow'
  arrow.textContent = '→'
  q.append(src, arrow, document.createTextNode(f.targetQuote))

  const why = document.createElement('div')
  why.className = 'why'
  why.textContent = f.why || f.issue

  const sugg = document.createElement('div')
  sugg.className = 'sugg'
  const fix = document.createElement('button')
  fix.type = 'button'
  fix.className = 'fix'
  fix.dataset.apply = f.id
  const realSuggestion = f.suggestions?.[0]
  const applied = r.applied?.has(f.id)
  if (applied) {
    fix.classList.add('applied')
    fix.textContent = '↺ 撤销这处修改'
    fix.title = '点击还原为模型给的译文'
  } else {
    fix.textContent = realSuggestion ? `✓ ${realSuggestion.text}` : '✓ 采纳建议'
    if (realSuggestion?.note) {
      const note = document.createElement('span')
      note.className = 'n'
      note.textContent = realSuggestion.note
      fix.append(note)
    }
  }
  sugg.append(fix)

  card.append(top, q, why, sugg)
  return card
}

function renderAll() {
  renderChips()
  renderTabs()
  renderTranslation()
  renderReport()
}

/* ────────────────────────── 交互 ────────────────────────── */

function saveActiveTranslation() {
  const text = els.translation.value
  if (text.trim()) state.translations[state.active] = text
  else delete state.translations[state.active]
}

function syncTranslationInput() {
  const value = state.translations[state.active] || ''
  els.translation.value = value
  // dir 交给内容自己决定（dir="auto"）：空着时占位符是中文，就该左对齐；
  // 粘进阿拉伯语后浏览器会自动切成 RTL，不需要按市场硬设。
  els.translation.classList.toggle('filled', Boolean(value.trim()))
}

function pickMarket(id) {
  if (!state.selected.has(id) || id === state.active) return
  saveActiveTranslation()
  state.active = id
  syncTranslationInput()
  renderAll()
}

function toggleMarket(id) {
  if (state.selected.has(id)) {
    if (state.selected.size === 1) return toast('至少保留一个市场', true)
    state.selected.delete(id)
  } else {
    state.selected.add(id)
  }
  if (!state.selected.has(state.active)) {
    saveActiveTranslation()
    state.active = state.markets.map((m) => m.id).find((x) => state.selected.has(x))
    syncTranslationInput()
  }
  renderAll()
}

function applyOne(findingId) {
  const r = state.results[state.active]
  if (!r?.findings) return
  const f = r.findings.find((x) => x.id === findingId)
  if (!f) return

  // 已采纳的再点一次就是撤销：改动只由 applied 集合推导，删掉即还原
  if (r.applied.has(f.id)) {
    r.applied.delete(f.id)
    renderAll()
    return toast('已撤销这处修改')
  }

  const seg = buildSegments(r.translation, [f])[0]
  if (!seg) return toast('这句在译文里定位不到，需要手动改', true)
  r.applied.add(f.id)
  renderAll()
  toast('已替换这处表述')
}

/** 清空当前市场已采纳的修改，还原成模型给的译文 */
function undoAll() {
  const r = state.results[state.active]
  if (!r?.applied?.size) return
  const n = appliedCount(r)
  r.applied.clear()
  renderAll()
  toast(n ? `已撤销 ${n} 处修改` : '没有可撤销的修改')
}

function applyAll() {
  const r = state.results[state.active]
  if (!r?.findings?.length) return
  const segs = buildSegments(r.translation, r.findings)
  if (!segs.length) return toast('没有可自动替换的片段，请手动处理', true)
  for (const s of segs) r.applied.add(s.f.id)
  renderAll()
  const rest = r.findings.length - segs.length
  toast(rest > 0 ? `已修正 ${segs.length} 处，${rest} 处需手动处理` : `已修正全部 ${segs.length} 处`)
}

/* ────────────────────────── 运行 ────────────────────────── */

function resetResults() {
  state.results = {}
  for (const id of state.selected) {
    state.results[id] = { status: 'idle', translation: '', findings: [], applied: new Set() }
  }
}

async function aiTranslateCurrent() {
  if (state.running) return

  const source = els.source.value.trim()
  if (source.length < 4) return toast('先填中文原文', true)
  if (!state.selected.size) return toast('至少选择一个市场', true)

  const original = els.aiBtn.textContent
  els.aiBtn.disabled = true
  els.aiBtn.textContent = '翻译中…'

  try {
    const res = await fetch('/api/translate', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ source, market: state.active, tone: currentTone() || 'professional', llm: llmPayload() }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `翻译失败（HTTP ${res.status}）`)

    els.translation.value = data.text || ''
    saveActiveTranslation()
    els.translation.classList.toggle('filled', Boolean(els.translation.value.trim()))
    if (state.results[state.active]) {
      delete state.results[state.active]
      renderAll()
    }
    toast('已填入 AI 译文，建议先改两句再审核')
  } catch (err) {
    toast(err.message || '翻译失败', true)
  } finally {
    els.aiBtn.disabled = false
    els.aiBtn.textContent = original
  }
}

async function run() {
  if (state.running) return

  const source = els.source.value.trim()
  if (source.length < 4) return toast('文案太短了，至少 4 个字', true)
  if (els.tone.value === '__custom' && !currentTone()) return toast('自定义语气还没写', true)
  if (source.length > 1200) return toast('文案最多 1200 字', true)
  if (!state.selected.size) return toast('至少选择一个市场', true)

  state.running = true
  state.startedAt = Date.now()
  state.controller = new AbortController()
  els.runBtn.disabled = true
  els.timing.textContent = ''
  saveActiveTranslation()
  resetResults()
  renderAll()
  setStatus(`正在处理 ${state.selected.size} 个市场…`)

  // 只提交用户真的填了的译文；空着的市场由服务端走 AI 翻译
  const translations = {}
  for (const id of state.selected) {
    const text = (state.translations[id] || '').trim()
    if (text) translations[id] = text
  }

  try {
    const res = await fetch('/api/audit', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        source,
        markets: [...state.selected],
        tone: currentTone() || 'professional',
        strictness: 'standard',
        translations,
        llm: llmPayload(),
      }),
      signal: state.controller.signal,
    })

    if (!res.ok) {
      const err = await res.json().catch(() => ({}))
      throw new Error(err.error || `请求失败（HTTP ${res.status}）`)
    }
    if (!res.body) throw new Error('当前环境不支持流式响应')

    await consumeStream(res.body)
  } catch (err) {
    if (err.name !== 'AbortError') {
      toast(err.message || '出错了', true)
      setStatus(null)
    }
  } finally {
    state.running = false
    els.runBtn.disabled = false
    state.controller = null
    if (els.statusbar.hidden === false) setStatus(null)
  }
}

async function consumeStream(body) {
  const reader = body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''

  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    buffer += decoder.decode(value, { stream: true })

    // 事件以空行分隔
    let split
    while ((split = buffer.indexOf('\n\n')) >= 0) {
      const raw = buffer.slice(0, split)
      buffer = buffer.slice(split + 2)
      handleEvent(raw)
    }
  }
}

function handleEvent(raw) {
  let event = 'message'
  const dataLines = []
  for (const line of raw.split('\n')) {
    if (line.startsWith('event:')) event = line.slice(6).trim()
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).trim())
  }
  if (!dataLines.length) return

  let data
  try {
    data = JSON.parse(dataLines.join('\n'))
  } catch {
    return
  }

  switch (event) {
    case 'meta': {
      state.mock = Boolean(data.mock)
      els.modeBadge.hidden = false
      if (state.mock) {
        els.modeBadge.classList.remove('ok')
        els.modeBadge.textContent = '演示数据 · 未配置 API Key'
      } else {
        els.modeBadge.classList.add('ok')
        els.modeBadge.textContent = `运行中 · ${data.model}`
      }
      break
    }

    case 'progress': {
      const m = marketOf(data.market)
      setStatus(data.stage === 'translate' ? `正在翻译 · ${m.label}` : `正在审查 · ${m.label}`)
      break
    }

    case 'translation.delta': {
      const r = state.results[data.market]
      if (!r) return
      r.status = 'translating'
      r.translation += data.text
      if (data.market === state.active) renderTranslation()
      break
    }

    case 'translation.done': {
      const r = state.results[data.market]
      if (!r) return
      r.translation = data.text ?? r.translation
      r.source = data.source || 'ai'
      r.status = 'translated'
      if (data.market === state.active) {
        renderTranslation()
        renderReport()
      }
      break
    }

    case 'translation.error': {
      const r = state.results[data.market]
      if (!r) return
      r.status = 'error'
      r.error = data.message
      toast(`${marketOf(data.market).label}翻译失败：${data.message}`, true)
      if (data.market === state.active) renderAll()
      break
    }

    case 'audit.result': {
      const r = state.results[data.market]
      if (!r) return
      r.status = 'ready'
      r.findings = Array.isArray(data.findings) ? data.findings : []
      r.summary = data.summary || ''
      r.source = data.source || r.source || 'ai'
      r.score = data.score
      r.level = data.level
      r.tone = data.tone
      r.distribution = data.distribution
      // 有结论却一条都落不了地 —— 说明模型引用的片段不在译文里，必须告知用户
      if (!r.findings.length && data.dropped > 0) {
        toast(`${marketOf(data.market).label}：${data.dropped} 条建议无法定位到译文，已忽略`, true)
      }
      if (data.market === state.active) {
        renderTranslation()
        renderReport()
      }
      renderTabs()
      break
    }

    case 'audit.error': {
      const r = state.results[data.market]
      if (!r) return
      r.status = 'partial'
      r.error = data.message
      toast(`${marketOf(data.market).label}审查失败：${data.message}`, true)
      if (data.market === state.active) {
        renderTranslation()
        renderReport()
      }
      break
    }

    case 'error': {
      toast(data.message || '服务端出错', true)
      setStatus(null)
      break
    }

    case 'done': {
      setStatus(null)
      const secs = ((Date.now() - state.startedAt) / 1000).toFixed(1)
      els.timing.textContent = `本次耗时 ${secs}s`
      renderTabs()
      renderTranslation()
      renderReport()
      break
    }
  }
}

/* ────────────────────────── 导出 / 复制 ────────────────────────── */

function buildMarkdown() {
  const now = new Date().toLocaleString('zh-CN', { hour12: false })
  const lines = ['# 跨文化审核官 · 审核报告', '', `生成时间：${now}`, '', '## 中文原文', '', '> ' + els.source.value.trim(), '']

  const ids = state.markets.map((m) => m.id).filter((id) => state.selected.has(id))
  for (const id of ids) {
    const r = state.results[id]
    if (!r?.translation) continue
    const m = marketOf(id)
    const s = r.score ?? scoreOf(r.findings || []).score
    const level = r.level ?? scoreOf(r.findings || []).level

    lines.push(`## ${m.label} · ${m.locale} · ${r.status === 'ready' ? `${s} 分（${level}）` : '仅译文'}`, '')
    if (r.summary) lines.push(`**结论**：${r.summary}`, '')
    const n = appliedCount(r)
    lines.push(`**译文**${n ? `（已应用 ${n} 处修改）` : ''}`, '', composeText(r), '')

    if (r.findings?.length) {
      lines.push('| 级别 | 类别 | 问题 | 原文 | 译文 | 建议 |', '|---|---|---|---|---|---|')
      for (const f of r.findings) {
        const esc = (t) => String(t ?? '').replace(/\|/g, '\\|').replace(/\n/g, ' ')
        lines.push(
          `| ${f.severity} | ${CATEGORY_LABEL[f.category] ?? f.category} | ${esc(f.issue)} | ${esc(f.sourceQuote)} | ${esc(f.targetQuote)} | ${esc(f.suggestions?.[0]?.text)} |`,
        )
      }
      lines.push('')
    } else if (r.status === 'ready') {
      lines.push('未发现需要修改的问题。', '')
    }
  }

  lines.push('---', '', '> 本报告由 AI 生成，仅供参考，不构成法律意见。')
  return lines.join('\n')
}

function downloadMarkdown() {
  const blob = new Blob([buildMarkdown()], { type: 'text/markdown;charset=utf-8' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = `跨文化审核报告-${new Date().toISOString().slice(0, 10)}.md`
  a.click()
  setTimeout(() => URL.revokeObjectURL(url), 1000)
  toast('报告已导出')
}

async function copyTranslation() {
  const r = state.results[state.active]
  if (!r?.translation) return
  const n = appliedCount(r)
  try {
    await navigator.clipboard.writeText(composeText(r))
    toast(n ? `已复制安全版（含 ${n} 处修改）` : '译文已复制')
  } catch {
    toast('浏览器拒绝了剪贴板权限', true)
  }
}

/* ────────────────────────── 网页设置（主题 / 字号 / 动效） ────────────────────────── */

const PREFS_KEY = 'cca.prefs'

const THEMES = [
  { id: 'violet', a: '#7c5cff', b: '#5a7dff', rgb: '124,92,255', ink: '#ded9ff' },
  { id: 'blue', a: '#3b82f6', b: '#22b8cf', rgb: '59,130,246', ink: '#cfe1ff' },
  { id: 'teal', a: '#14b8a6', b: '#34d399', rgb: '20,184,166', ink: '#c8f5ec' },
  { id: 'amber', a: '#f59e0b', b: '#ef4444', rgb: '245,158,11', ink: '#ffe3b8' },
  { id: 'pink', a: '#ec4899', b: '#a855f7', rgb: '236,72,153', ink: '#ffd3e6' },
  { id: 'slate', a: '#7d8aa0', b: '#566173', rgb: '125,138,160', ink: '#dbe3ee' },
]

function defaultPrefs() {
  return { theme: 'violet', fs: 1, motion: 1 }
}

function loadPrefs() {
  try {
    return { ...defaultPrefs(), ...JSON.parse(localStorage.getItem(PREFS_KEY) || '{}') }
  } catch {
    return defaultPrefs()
  }
}

const themeOf = (id) => THEMES.find((t) => t.id === id) || THEMES[0]

function applyPrefs() {
  const t = themeOf(state.prefs.theme)
  const s = document.documentElement.style

  s.setProperty('--accent', t.a)
  s.setProperty('--accent-2', t.b)
  s.setProperty('--accent-rgb', t.rgb)
  s.setProperty('--accent-ink', t.ink)
  s.setProperty('--fs', String(state.prefs.fs))
  document.documentElement.classList.toggle('no-motion', state.prefs.motion === 0)

  // 存解析后的色值：首屏内联脚本不认识 THEMES，只能读现成的
  try {
    localStorage.setItem(
      PREFS_KEY,
      JSON.stringify({
        theme: t.id,
        fs: state.prefs.fs,
        motion: state.prefs.motion,
        accent: { a: t.a, b: t.b, rgb: t.rgb, ink: t.ink },
      }),
    )
  } catch {
    /* 隐私模式 */
  }
}

function renderPrefs() {
  els.swatches.replaceChildren(
    ...THEMES.map((t) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'sw' + (t.id === state.prefs.theme ? ' on' : '')
      btn.style.background = `linear-gradient(135deg,${t.a},${t.b})`
      btn.dataset.theme = t.id
      btn.title = t.id
      btn.setAttribute('aria-label', t.id)
      return btn
    }),
  )

  els.fsSeg.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.fs) === state.prefs.fs)
  })
  els.motionSeg.querySelectorAll('button').forEach((b) => {
    b.classList.toggle('on', Number(b.dataset.motion) === state.prefs.motion)
  })
}

function openPrefs() {
  renderPrefs()
  els.prefsModal.hidden = false
}

function closePrefs() {
  els.prefsModal.hidden = true
}

function closeLogs() {
  els.logsModal.hidden = true
}

/* ────────────────────────── 调用日志面板 ────────────────────────── */

async function openLogs() {
  els.logsModal.hidden = false
  await loadLogs()
}

async function loadLogs() {
  els.logList.replaceChildren(
    Object.assign(document.createElement('div'), { className: 'log-empty', textContent: '加载中…' }),
  )

  try {
    const res = await fetch('/api/logs?limit=60')
    const data = await res.json()
    state.logs = Array.isArray(data.items) ? data.items : []
    els.logsMeta.textContent = `共 ${data.total ?? 0} 条 · 保留最近 ${data.limit ?? '—'} 条`
    renderLogs()
  } catch (err) {
    els.logList.replaceChildren(
      Object.assign(document.createElement('div'), {
        className: 'log-empty',
        textContent: `读取失败：${err.message}`,
      }),
    )
  }
}

function renderLogs() {
  const rows = (state.logs || []).filter((r) => state.logFilter === 'all' || !r.ok)

  if (!rows.length) {
    els.logList.replaceChildren(
      Object.assign(document.createElement('div'), {
        className: 'log-empty',
        textContent: state.logFilter === 'all' ? '还没有调用记录' : '没有失败的调用',
      }),
    )
    return
  }

  els.logList.replaceChildren(...rows.map((r) => renderLogRow(r)))
}

function renderLogRow(r) {
  const row = document.createElement('button')
  row.type = 'button'
  row.className = 'log-row'

  const st = document.createElement('span')
  st.className = 'st ' + (r.ok ? 'ok' : 'err')
  st.textContent = r.ok ? 'OK' : 'ERR'

  const tm = document.createElement('span')
  tm.className = 'tm'
  tm.textContent = (r.ts || '').slice(11, 19)

  const pp = document.createElement('span')
  pp.className = 'pp'
  pp.textContent = r.purpose || '-'

  const mk = document.createElement('span')
  mk.className = 'mk'
  mk.textContent = r.market || '-'

  const ms = document.createElement('span')
  ms.className = 'ms'
  ms.textContent = `${r.ms ?? 0}ms`

  row.append(st, tm, pp, mk, ms)

  row.addEventListener('click', () => {
    const next = row.nextElementSibling
    if (next && next.classList.contains('log-detail')) {
      next.remove()
      return
    }
    els.logList.querySelectorAll('.log-detail').forEach((n) => n.remove())
    els.logList.insertBefore(renderLogDetail(r), row.nextSibling)
  })

  return row
}

function renderLogDetail(r) {
  const box = document.createElement('div')
  box.className = 'log-detail'

  const parts = []
  parts.push(`model: ${r.model || '-'}    endpoint: ${r.endpoint || '-'}`)
  if (r.usage) parts.push(`usage: ${JSON.stringify(r.usage)}`)
  if (r.error) parts.push(`\n【错误】\n${r.error}`)
  parts.push(`\n【system】\n${(r.request && r.request.system) || '（空）'}`)
  parts.push(`\n【user】\n${(r.request && r.request.user) || '（空）'}`)
  parts.push(`\n【返回】\n${r.response || '（空）'}`)

  box.textContent = parts.join('\n')
  return box
}

async function clearLogs() {
  if (!window.confirm('清空全部调用日志？')) return
  try {
    await fetch('/api/logs/clear', { method: 'POST' })
    await loadLogs()
    toast('日志已清空')
  } catch (err) {
    toast(err.message, true)
  }
}

/* ────────────────────────── 模型设置 ────────────────────────── */

// 只存地址：模型名一律以服务商返回的为准，不在前端猜
const PROVIDERS = {
  deepseek: { label: 'DeepSeek', baseUrl: 'https://api.deepseek.com' },
  qwen: { label: '通义千问', baseUrl: 'https://dashscope.aliyuncs.com/compatible-mode/v1' },
  openai: { label: 'OpenAI', baseUrl: 'https://api.openai.com/v1' },
  custom: { label: '自定义', baseUrl: '' },
}

const STORAGE_KEY = 'cca.llm'

/** 每个服务商一份配置：切走时记住，切回来还原 */
function blankProfile(providerId) {
  return {
    baseUrl: PROVIDERS[providerId]?.baseUrl ?? '',
    apiKey: '',
    model: '',
    useProxy: false,
    proxyUrl: '',
  }
}

/** 已知的过期模型名，读盘时顺手清掉，避免一打开就顶着个错名字 */
const STALE_MODELS = new Set([
  'deepseek-chat',
  'deepseek-reasoner',
  'qwen-plus',
  'qwen-max',
  'qwen-turbo',
  'gpt-4o',
  'gpt-4o-mini',
  'gpt-4.1-mini',
])

/** 读盘：{ provider, profiles } —— 兼容旧的单配置格式 */
function loadStore() {
  const fallback = { provider: 'deepseek', profiles: {} }
  try {
    const raw = localStorage.getItem(STORAGE_KEY)
    if (!raw) return fallback
    const data = JSON.parse(raw)

    if (!data.profiles) {
      const pid = data.provider || 'deepseek'
      return {
        provider: pid,
        profiles: {
          [pid]: {
            baseUrl: data.baseUrl || blankProfile(pid).baseUrl,
            apiKey: data.apiKey || '',
            model: STALE_MODELS.has(String(data.model || '').trim()) ? '' : data.model || '',
            useProxy: Boolean(data.useProxy),
            proxyUrl: data.proxyUrl || '',
          },
        },
      }
    }

    return { provider: data.provider || 'deepseek', profiles: data.profiles || {} }
  } catch {
    return fallback
  }
}

function persistStore() {
  try {
    localStorage.setItem(STORAGE_KEY, JSON.stringify(state.store))
  } catch {
    /* 隐私模式下写不进去，不影响本次使用 */
  }
}

/** 取某个服务商的配置，没存过就给一份空白（地址用官方默认） */
function profileFor(providerId) {
  const saved = state.store?.profiles?.[providerId] ?? {}
  const profile = { ...blankProfile(providerId), ...saved }
  if (STALE_MODELS.has(String(profile.model).trim())) profile.model = ''
  return profile
}

/** 把某个服务商的配置设为当前生效 */
function applyProfile(providerId) {
  state.settings = { provider: providerId, ...profileFor(providerId) }
}

/** 真正发请求时用的地址：开了代理且填了地址就用代理 */
function effectiveBaseUrl(s) {
  if (!s) return ''
  return (s.useProxy && s.proxyUrl.trim()) || s.baseUrl.trim()
}

/** 随请求下发给后端；没填密钥就不传，让服务端走 .env 或演示数据 */
function llmPayload() {
  const s = state.settings
  if (!s || !s.apiKey.trim()) return undefined
  return { baseUrl: effectiveBaseUrl(s), apiKey: s.apiKey.trim(), model: s.model.trim() }
}

function updateBadge() {
  const s = state.settings
  const badge = els.modeBadge
  badge.hidden = false

  if (s?.apiKey?.trim()) {
    badge.classList.add('ok')
    badge.textContent = `${PROVIDERS[s.provider]?.label ?? '自定义'} · ${s.model || '未命名模型'}`
    return
  }
  if (state.serverModel) {
    badge.classList.add('ok')
    badge.textContent = `服务端 · ${state.serverModel}`
    return
  }
  badge.classList.remove('ok')
  badge.textContent = '未配置密钥 · 演示数据'
}

function renderProviders(active) {
  els.providers.replaceChildren(
    ...Object.entries(PROVIDERS).map(([id, p]) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'pv' + (id === active ? ' on' : '')
      btn.dataset.pv = id
      btn.textContent = p.label
      return btn
    }),
  )
}

/** 服务商真实返回的列表才算数（预设只是猜的，不能拿来判对错） */
function setFetchedModels(models) {
  state.fetchedModels = Array.isArray(models) ? models : []
  renderModelPanel()
}

/** 面板只显示服务商真返回的列表 —— 没有就不显示任何模型名，不拿预设冒充事实 */
function renderModelPanel() {
  const list = state.fetchedModels

  if (!list.length) {
    const empty = document.createElement('div')
    empty.className = 'picker-empty'
    empty.textContent = '暂无列表'
    els.modelPanel.replaceChildren(empty)
    return
  }

  const current = els.model.value.trim()
  els.modelPanel.replaceChildren(
    ...list.map((m) => {
      const btn = document.createElement('button')
      btn.type = 'button'
      btn.className = 'picker-item' + (m === current ? ' on' : '')
      btn.dataset.model = m
      btn.textContent = m
      return btn
    }),
  )
}

function toggleModelPanel(force) {
  const show = typeof force === 'boolean' ? force : els.modelPanel.hidden
  if (!show) {
    els.modelPanel.hidden = true
    return
  }
  renderModelPanel()
  els.modelPanel.hidden = false
}

/** 只有拿到服务商返回的真实列表，才有资格判「这个名字不能用」 */
function checkModelMatch() {
  const current = els.model.value.trim()
  if (!state.fetchedModels.length || !current || state.fetchedModels.includes(current)) {
    resetModelHint()
    return
  }
  els.modelHint.className = 'hint bad'
  els.modelHint.textContent = `「${current}」不在服务商返回的列表里`
}

/** 表单 → 配置对象 */
function formProfile() {
  return {
    baseUrl: els.baseUrl.value.trim(),
    apiKey: els.apiKey.value.trim(),
    model: els.model.value.trim(),
    useProxy: els.useProxy.checked,
    proxyUrl: els.proxyUrl.value.trim(),
  }
}

/** 配置对象 → 表单 */
function fillForm(p) {
  els.baseUrl.value = p.baseUrl
  els.apiKey.value = p.apiKey
  els.model.value = p.model
  els.useProxy.checked = p.useProxy
  els.proxyUrl.value = p.proxyUrl
  els.proxyField.hidden = !p.useProxy
  els.apiKey.type = 'password'
  els.peekBtn.textContent = '显示'
}

function openSettings() {
  // 每次打开都以磁盘为准，取消就等于没改
  state.store = loadStore()
  applyProfile(state.store.provider)

  const s = state.settings
  renderProviders(s.provider)
  state.fetchedModels = []
  fillForm(s)
  els.testResult.textContent = ''
  els.testResult.className = 'test-result'
  resetModelHint()
  renderModelPanel()
  toggleModelPanel(false)
  els.settingsModal.hidden = false
  setTimeout(() => els.apiKey.focus(), 40)
}

function closeSettings() {
  els.settingsModal.hidden = true
  els.modelPanel.hidden = true
}


function readForm() {
  return { provider: state.settings.provider, ...formProfile() }
}

function showTestResult(text, kind) {
  els.testResult.textContent = text
  els.testResult.className = 'test-result' + (kind ? ' ' + kind : '')
}

async function testConnection() {
  const f = readForm()
  if (!f.model) return showTestResult('先填模型名', 'bad')
  if (!f.apiKey) return showTestResult('先填 API 密钥', 'bad')
  const baseUrl = (f.useProxy && f.proxyUrl) || f.baseUrl
  if (!/^https?:\/\//i.test(baseUrl)) return showTestResult('接口地址要以 http(s):// 开头', 'bad')

  const label = els.testBtn.textContent
  els.testBtn.disabled = true
  els.testBtn.textContent = '测试中…'
  showTestResult('正在连接…')

  try {
    const res = await fetch('/api/llm/test', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ llm: { baseUrl, apiKey: f.apiKey, model: f.model } }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    if (data.ok) showTestResult(`✓ 连接正常 · ${data.ms}ms`, 'ok')
    else showTestResult(`✗ ${data.error}`, 'bad')
  } catch (err) {
    showTestResult(`✗ ${err.message}`, 'bad')
  } finally {
    els.testBtn.disabled = false
    els.testBtn.textContent = label
  }
}

async function fetchModelList() {
  const f = readForm()
  if (!f.apiKey) return showTestResult('先填 API 密钥', 'bad')
  const baseUrl = (f.useProxy && f.proxyUrl) || f.baseUrl
  if (!/^https?:\/\//i.test(baseUrl)) return showTestResult('接口地址要以 http(s):// 开头', 'bad')

  const btn = els.fetchModels
  const label = btn.textContent
  btn.disabled = true
  btn.textContent = '拉取中…'
  resetModelHint()

  try {
    const res = await fetch('/api/llm/models', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        llm: { baseUrl, apiKey: f.apiKey, model: f.model || 'placeholder' },
      }),
    })
    const data = await res.json().catch(() => ({}))
    if (!res.ok) throw new Error(data.error || `HTTP ${res.status}`)
    if (!data.ok) throw new Error(data.error)

    const models = data.models || []
    setFetchedModels(models)

    const current = els.model.value.trim()
    if (models.length && current && !models.includes(current)) {
      els.modelHint.className = 'hint bad'
      els.modelHint.textContent = `「${current}」不在服务商返回的列表里`
    }
    // 拉完直接把列表展开，省一次点击
    toggleModelPanel(true)
  } catch (err) {
    els.modelHint.className = 'hint bad'
    els.modelHint.textContent = err.message
  } finally {
    btn.disabled = false
    btn.textContent = label
  }
}

function resetModelHint() {
  els.modelHint.className = 'hint'
  els.modelHint.textContent = ''
}

/** 清掉本机保存的所有服务商配置（含密钥），表单回到空白 */
function clearStoredSettings() {
  if (!window.confirm('清除本机保存的所有服务商配置？密钥会一起删掉，需要重新填。')) return

  try {
    localStorage.removeItem(STORAGE_KEY)
  } catch {
    /* 隐私模式 */
  }

  state.store = { provider: 'deepseek', profiles: {} }
  applyProfile('deepseek')
  renderProviders('deepseek')
  fillForm(state.settings)
  state.fetchedModels = []
  toggleModelPanel(false)
  resetModelHint()
  renderModelPanel()
  els.testResult.textContent = ''
  els.testResult.className = 'test-result'
  updateBadge()
  toast('已清除本机保存的配置')
}

function saveSettings() {
  const f = formProfile()
  // 没填密钥时模型留空也无所谓（会走演示数据）；要真调模型就必须有模型名
  if (!f.model && f.apiKey) return toast('先填模型名', true)
  if (f.useProxy && !/^https?:\/\//i.test(f.proxyUrl)) return toast('代理地址要以 http(s):// 开头', true)
  if (f.baseUrl && !/^https?:\/\//i.test(f.baseUrl)) return toast('接口地址要以 http(s):// 开头', true)

  // 当前服务商写回它自己的档案，其余服务商的档案原样保留
  state.store.profiles[state.settings.provider] = f
  state.store.provider = state.settings.provider
  persistStore()

  state.settings = { provider: state.store.provider, ...f }
  closeSettings()
  updateBadge()

  // 换了模型，之前的结果作废
  if (Object.keys(state.results).length) {
    state.results = {}
    renderAll()
  }
  toast(f.apiKey ? '已保存' : '已保存 · 未填密钥，仍走演示数据')
}

/* ────────────────────────── 演示模式 ────────────────────────── */

async function loadDemo() {
  try {
    const fx = await fetch('/fixtures/demo.json').then((r) => r.json())
    els.source.value = fx.source
    updateCounter()
    state.selected = new Set(Object.keys(fx.markets))
    state.active = Object.keys(fx.markets)[0]
    state.results = {}
    state.translations = {}

    for (const [id, data] of Object.entries(fx.markets)) {
      const findings = (data.audit.findings || []).map((f, i) => ({
        ...f,
        id: `f${i}`,
        suggestions: f.suggestions || [],
      }))
      // 演示里把预置译文当作「用户自己准备的译文」，走主路径
      state.translations[id] = data.translation
      state.results[id] = {
        status: 'ready',
        translation: data.translation,
        source: 'user',
        findings,
        summary: data.audit.summary || '',
        ...scoreOf(findings),
        applied: new Set(),
      }
    }

    syncTranslationInput()
    els.modeBadge.hidden = false
    els.modeBadge.textContent = '演示模式 · 预置结果'
    els.timing.textContent = '演示数据'
    renderAll()
  } catch (err) {
    toast('演示数据加载失败：' + err.message, true)
  }
}

/* ────────────────────────── 初始化 ────────────────────────── */

/** 当前语气：预设值，或用户自己写的那句话 */
function currentTone() {
  if (els.tone.value !== '__custom') return els.tone.value
  return els.toneCustom.value.trim().slice(0, 40)
}
function updateCounter() {
  const n = els.source.value.trim().length
  els.counter.textContent = String(n)
  els.counter.parentElement?.classList.toggle('over', n > 1200)
}

function bindEvents() {
  els.source.addEventListener('input', () => {
    updateCounter()
    if (state.running) return

    // 原文变了，各市场的译文就不再是它的译文，必须一起作废。
    // 否则会拿旧原文的译文去审新原文——比不审更糟，因为结论看起来还很"专业"。
    if (Object.keys(state.translations).length) {
      state.translations = {}
      syncTranslationInput()
      toast('原文已改，旧译文已清空，请重新翻译或粘贴')
    }
    if (Object.keys(state.results).length) {
      state.results = {}
      renderAll()
    }
  })

  els.translation.addEventListener('input', () => {
    saveActiveTranslation()
    els.translation.classList.toggle('filled', Boolean(els.translation.value.trim()))
    // 只作废当前市场的结果，其他市场的审查结论仍然有效
    if (state.results[state.active] && !state.running) {
      delete state.results[state.active]
      renderAll()
    }
  })

  els.aiBtn.addEventListener('click', aiTranslateCurrent)

  els.runBtn.addEventListener('click', run)

  document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
      if (!els.logsModal.hidden) {
        closeLogs()
        return
      }
      if (!els.prefsModal.hidden) {
        closePrefs()
        return
      }
    }
    if (e.key === 'Escape' && !els.settingsModal.hidden) {
      // 先收下拉，再关弹窗
      if (!els.modelPanel.hidden) {
        toggleModelPanel(false)
        return
      }
      closeSettings()
      return
    }
    if ((e.metaKey || e.ctrlKey) && e.key === 'Enter' && els.settingsModal.hidden) {
      e.preventDefault()
      run()
    }
  })

  els.markets.addEventListener('click', (e) => {
    const chip = e.target.closest('.chip')
    if (chip) toggleMarket(chip.dataset.id)
  })

  els.tabs.addEventListener('click', (e) => {
    const tab = e.target.closest('.tab')
    if (tab) pickMarket(tab.dataset.id)
  })

  els.cards.addEventListener('click', (e) => {
    const btn = e.target.closest('[data-apply]')
    if (btn && !btn.disabled) applyOne(btn.dataset.apply)
  })

  // 报告卡 → 译文高亮
  els.cards.addEventListener('mouseover', (e) => {
    const card = e.target.closest('.card')
    if (!card) return
    const mark = els.trans.querySelector(`mark[data-id="${card.dataset.id}"]`)
    if (mark) mark.classList.add('flash')
  })
  els.cards.addEventListener('mouseout', (e) => {
    const card = e.target.closest('.card')
    if (!card) return
    els.trans.querySelectorAll('mark.flash').forEach((m) => m.classList.remove('flash'))
  })

  // 译文高亮 → 报告卡
  els.trans.addEventListener('mouseover', (e) => {
    const mark = e.target.closest('mark[data-id]')
    if (!mark) return
    const card = els.cards.querySelector(`.card[data-id="${mark.dataset.id}"]`)
    if (!card) return
    card.classList.add('flash')
    card.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })
  els.trans.addEventListener('mouseout', () => {
    els.cards.querySelectorAll('.card.flash').forEach((c) => c.classList.remove('flash'))
  })

  els.trans.addEventListener('click', (e) => {
    const mark = e.target.closest('mark[data-id]')
    if (!mark) return
    const card = els.cards.querySelector(`.card[data-id="${mark.dataset.id}"]`)
    card?.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
  })

  els.safeBtn.addEventListener('click', applyAll)
  els.undoBtn.addEventListener('click', undoAll)
  els.exportBtn.addEventListener('click', downloadMarkdown)
  els.copyBtn.addEventListener('click', copyTranslation)

  document.querySelectorAll('.exbtn').forEach((btn) => {
    btn.addEventListener('click', () => {
      const hadTranslation = Object.keys(state.translations).length > 0
      els.source.value = EXAMPLES[btn.dataset.ex] || ''
      updateCounter()
      // 换示例等于换原文，所有译文和结果一起作废
      state.translations = {}
      state.results = {}
      syncTranslationInput()
      renderAll()
      els.source.focus()
      if (hadTranslation) toast('已换示例，旧译文已清空')
    })
  })

  els.tone.addEventListener('change', () => {
    const custom = els.tone.value === '__custom'
    els.toneCustom.hidden = !custom
    if (custom) els.toneCustom.focus()
  })

  /* ── 网页设置 ── */
  document.querySelectorAll('[data-close-prefs]').forEach((n) => n.addEventListener('click', closePrefs))
  document.querySelectorAll('[data-close-logs]').forEach((n) => n.addEventListener('click', closeLogs))

  els.swatches.addEventListener('click', (e) => {
    const btn = e.target.closest('.sw')
    if (!btn) return
    state.prefs.theme = btn.dataset.theme
    applyPrefs()
    renderPrefs()
  })

  els.fsSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-fs]')
    if (!btn) return
    state.prefs.fs = Number(btn.dataset.fs)
    applyPrefs()
    renderPrefs()
  })

  els.motionSeg.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-motion]')
    if (!btn) return
    state.prefs.motion = Number(btn.dataset.motion)
    applyPrefs()
    renderPrefs()
  })

  els.resetPrefs.addEventListener('click', () => {
    state.prefs = defaultPrefs()
    applyPrefs()
    renderPrefs()
    toast('已恢复默认')
  })

  els.openLogsBtn.addEventListener('click', () => {
    closePrefs()
    openLogs()
  })

  els.logFilter.addEventListener('click', (e) => {
    const btn = e.target.closest('button[data-filter]')
    if (!btn) return
    state.logFilter = btn.dataset.filter
    els.logFilter.querySelectorAll('button').forEach((b) => b.classList.toggle('on', b === btn))
    renderLogs()
  })

  els.refreshLogs.addEventListener('click', loadLogs)
  els.clearLogs.addEventListener('click', clearLogs)

  /* ── 模型设置 ── */  els.prefsBtn.addEventListener('click', openPrefs)
  // 角标也当入口：写着「未配置密钥」，点它就能配
  els.modeBadge.title = '点击配置模型'
  els.modeBadge.addEventListener('click', openSettings)

  document.querySelectorAll('[data-close]').forEach((n) => n.addEventListener('click', closeSettings))

  els.settingsModal.addEventListener('click', (e) => {
    if (e.target.closest('[data-close]')) closeSettings()
  })

  els.providers.addEventListener('click', (e) => {
    const btn = e.target.closest('.pv')
    if (!btn) return
    const id = btn.dataset.pv
    if (id === state.settings.provider) return

    // 把当前表单存进它自己的档案，切回来时还原（含密钥、地址、模型）
    state.store.profiles[state.settings.provider] = formProfile()

    applyProfile(id)
    renderProviders(id)
    fillForm(state.settings)
    state.fetchedModels = []
    toggleModelPanel(false)
    resetModelHint()
    renderModelPanel()
  })

  els.useProxy.addEventListener('change', () => {
    els.proxyField.hidden = !els.useProxy.checked
    if (els.useProxy.checked) els.proxyUrl.focus()
  })


  els.peekBtn.addEventListener('click', () => {
    const hidden = els.apiKey.type === 'password'
    els.apiKey.type = hidden ? 'text' : 'password'
    els.peekBtn.textContent = hidden ? '隐藏' : '显示'
  })

  els.testBtn.addEventListener('click', testConnection)
  els.fetchModels.addEventListener('click', fetchModelList)

  els.modelToggle.addEventListener('click', () => toggleModelPanel())

  els.modelPanel.addEventListener('click', (e) => {
    const item = e.target.closest('.picker-item')
    if (!item) return
    els.model.value = item.dataset.model
    toggleModelPanel(false)
    checkModelMatch()
  })

  els.model.addEventListener('change', checkModelMatch)

  // 点空白处收起模型下拉
  document.addEventListener('click', (e) => {
    if (!els.modelPanel.hidden && !e.target.closest('.picker')) toggleModelPanel(false)
  })
  els.saveBtn.addEventListener('click', saveSettings)
  els.clearBtn.addEventListener('click', clearStoredSettings)
}

async function init() {
  state.prefs = loadPrefs()
  applyPrefs()
  state.store = loadStore()
  applyProfile(state.store.provider)
  bindEvents()

  try {
    const list = await fetch('/api/markets').then((r) => r.json())
    state.markets = Array.isArray(list) ? list : []
  } catch {
    state.markets = [
      { id: 'us', label: '美国', code: 'US', locale: 'en-US', language: 'English', dir: 'ltr' },
      { id: 'mena', label: '中东', code: 'SA', locale: 'ar-SA', language: 'Arabic', dir: 'rtl' },
      { id: 'sea', label: '东南亚', code: 'ID', locale: 'id-ID', language: 'Indonesian', dir: 'ltr' },
    ]
  }

  // 服务端 .env 有没有配 key，决定角标默认显示什么
  try {
    const health = await fetch('/api/health').then((r) => r.json())
    state.serverModel = health.mock ? null : health.model
  } catch {
    state.serverModel = null
  }
  updateBadge()

  state.selected = new Set(state.markets.map((m) => m.id))
  state.active = state.markets[0]?.id || 'us'

  syncTranslationInput()
  renderAll()

  // 调试/演示入口：?prefs=1 打开网页设置，?logs=1 打开日志，?settings=1 打开模型设置
  const qs = new URLSearchParams(location.search)
  if (qs.has('prefs')) openPrefs()
  if (qs.has('logs')) openLogs()

  // 支持 ?settings=1 直接打开设置（方便截图 / 远程指导），并展开模型列表
  if (new URLSearchParams(location.search).has('settings')) {
    openSettings()
    toggleModelPanel(true)
  }

  if (new URLSearchParams(location.search).has('demo')) {
    await loadDemo()
    const params = new URLSearchParams(location.search)
    // 演示彩排用：?demo=1&apply=1 直接展示"安全版"，&tab=mena 直接切到某市场
    const tab = params.get('tab')
    if (tab && state.results[tab]) {
      state.active = tab
      syncTranslationInput()
    }
    renderAll()
    if (params.has('apply')) applyAll()
  }

  // 不带 demo 也能指定初始市场：?tab=mena
  const tabParam = new URLSearchParams(location.search).get('tab')
  if (tabParam && state.selected.has(tabParam) && tabParam !== state.active) {
    state.active = tabParam
    syncTranslationInput()
    renderAll()
  }

  // 录屏/彩排用：?autorun=1 打开即跑一遍（输入框为空时自动填美妆示例）
  const params2 = new URLSearchParams(location.search)
  if (params2.has('autorun') && !state.running) {
    if (!els.source.value.trim()) {
      els.source.value = EXAMPLES.beauty
      updateCounter()
    }
    run()
  }
}

init()
