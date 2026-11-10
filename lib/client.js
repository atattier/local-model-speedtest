// 模型测速插件 —— 浏览器半身（桌面版 / 网页版 / dsh-go 网页界面）
// 模型名旁 ⚡ 测单个；分组标题右侧的「测本组」一次测完同渠道全部模型。
// 数据由 host 半身 /plugins/local-model-speedtest/catalog 与 /bench 提供。
window.__ModuleLoader__.load({
  id: 'local-model-speedtest',
  factory: (require) => {
    var module = { exports: {} }
    var exports = module.exports
    Object.defineProperty(exports, Symbol.toStringTag, { value: 'Module' })

    const react = require('react')

    const CATALOG_PATH = '/plugins/local-model-speedtest/catalog'
    const BENCH_PATH = '/plugins/local-model-speedtest/bench'
    const EXPLAIN_PATH = '/plugins/local-model-speedtest/explain'
    const META_PATH = '/plugins/local-model-speedtest/meta'
    const UPDATE_PATH = '/plugins/local-model-speedtest/update'
    const STORE_KEY = 'dsh-model-speedtest:v1'
    const EXPLAIN_MODEL_KEY = 'dsh-model-speedtest:explain-model:v1'
    // 测速是取样式的，正常几秒内返回；这里的超时只兜底挂死的请求（略大于 host 的 22/26 秒）。
    const TIMEOUT_MS = 32000
    const EXPLAIN_TIMEOUT_MS = 95000
    const EXPLAIN_CACHE_MAX = 50
    // 与 host 保持一致：1 小时内的结果算新鲜，更久的只作参考。
    const STALE_MS = 60 * 60 * 1000
    // 报错解释只给 DSH 桌面端（Electron）用；网页版 / 手机端不出现按钮。
    const isDesktopClient = (() => {
      try {
        if (/Electron/i.test(navigator.userAgent || '')) return true
        if (window.process && window.process.versions && window.process.versions.electron) return true
        if (window.__DSH_DESKTOP__ === true || window.dshDesktop === true) return true
      } catch {}
      return false
    })()
    // 手机端（dsh-go 网页界面）不渲染 conversation.input.model.label 插槽，
    // 才需要 DOM 注入的 ⚡ / 悬浮按钮 / 菜单入口。桌面端和网页版走插槽，
    // 再塞一份就成了两个小闪电。所有手机端补丁都必须先过这道门。
    const isMobileClient = (() => {
      try {
        if (isDesktopClient) return false
        const ua = navigator.userAgent || ''
        if (/Android|iPhone|iPad|iPod|Mobile|HarmonyOS|OpenHarmony/i.test(ua)) return true
        if (window.__DSH_MOBILE__ === true || window.dshGoMobile === true) return true
        if (navigator.maxTouchPoints > 0 && window.matchMedia
          && window.matchMedia('(hover: none) and (pointer: coarse)').matches
          && Math.min(window.innerWidth || 9999, window.innerHeight || 9999) < 900) return true
      } catch {}
      return false
    })()

    function loadStore() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        const obj = raw ? JSON.parse(raw) : {}
        if (!obj || typeof obj !== 'object') return {}
        // 1.3.0 的 host 半身有个变量遮蔽 bug，会让所有测速报这个错。
        // 升级后自动清掉这批假失败，免得用户挨个重点 ⚡。
        let dirty = false
        for (const key of Object.keys(obj)) {
          const entry = obj[key]
          if (entry && entry.error && /updateCache is not a function/.test(String(entry.error))) {
            delete obj[key]
            dirty = true
          }
        }
        if (dirty) {
          try { window.localStorage.setItem(STORE_KEY, JSON.stringify(obj)) } catch {}
        }
        return obj
      } catch { return {} }
    }
    let store = loadStore()
    function saveStore() {
      try { window.localStorage.setItem(STORE_KEY, JSON.stringify(store)) } catch {}
    }
    function keyOf(providerId, modelId) { return `${providerId}|${modelId}` }

    // ---------- 功能开关（设置页的每张控制面板） ----------
    const SETTINGS_KEY = 'dsh-model-speedtest:settings:v1'
    const DEFAULT_SETTINGS = {
      speedTest: true,   // 模型名旁的 ⚡ 与结果药丸
      groupTest: true,   // 分组标题右侧的「测本组」
      segmentTest: true, // 大分组每 N 个一条「测这一段」
      segmentSize: 20,   // 每段模型数
      meta: true,        // 视觉/文本 + 上下文长度
      explain: true,     // 报错旁的「大白话解释」
    }
    function loadSettings() {
      try {
        const raw = window.localStorage.getItem(SETTINGS_KEY)
        const obj = raw ? JSON.parse(raw) : {}
        const merged = { ...DEFAULT_SETTINGS, ...(obj && typeof obj === 'object' ? obj : {}) }
        const size = Number(merged.segmentSize)
        merged.segmentSize = Number.isFinite(size) && size >= 5 && size <= 100 ? Math.round(size) : DEFAULT_SETTINGS.segmentSize
        for (const key of ['speedTest', 'groupTest', 'segmentTest', 'meta', 'explain']) merged[key] = Boolean(merged[key])
        return merged
      } catch { return { ...DEFAULT_SETTINGS } }
    }
    let settings = loadSettings()
    const settingsListeners = new Set()
    function saveSettings() {
      try { window.localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings)) } catch {}
    }
    function setSetting(key, value) {
      if (settings[key] === value) return
      settings = { ...settings, [key]: value }
      saveSettings()
      applySettings()
      for (const fn of settingsListeners) { try { fn() } catch {} }
      emitChange()
    }
    function resetSettings() {
      settings = { ...DEFAULT_SETTINGS }
      saveSettings()
      applySettings()
      for (const fn of settingsListeners) { try { fn() } catch {} }
      emitChange()
    }
    function subscribeSettings(fn) { settingsListeners.add(fn); return () => settingsListeners.delete(fn) }

    const listeners = new Set()
    function emitChange() {
      for (const fn of listeners) { try { fn() } catch {} }
      // 只更新分组/分段按钮与面板；模型行 ⚡ 交给低频扫描，避免每次测速
      // 都遍历上百行写 DOM（那是菜单卡死的主犯）。
      withSilentMutations(() => {
        syncGroupButtons()
        syncSegmentButtons()
        syncFloatingPanel()
      })
    }
    function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }
    function readEntry(providerId, modelId) { return store[keyOf(providerId, modelId)] }

    // 正在测的模型 key（单个 + 分组共用，避免重复点击）
    const inFlight = new Set()
    // 分组标题右侧的「测本组」按钮（DOM 注入；React 菜单没有分组标题 slot）
    const groupButtons = new Set()
    // 大分组每 N 个模型（默认 20）插入一条「测这一段」分隔行
    const segmentRows = new Set()
    const segProgress = new Map()
    let groupObserver = null
    // 分组目录缓存：{ [providerId]: { name, models:[{id,name}] } }
    let catalog = null
    let catalogPromise = null

    function fmtMs(ms) {
      if (!Number.isFinite(ms) || ms <= 0) return '—'
      return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
    }
    function fmtTps(tps) {
      if (!Number.isFinite(tps) || tps <= 0) return '—'
      return `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} tok/s`
    }
    function fmtAge(at) {
      if (!at) return ''
      const mins = Math.floor((Date.now() - at) / 60000)
      if (mins < 1) return '刚刚'
      if (mins < 60) return `${mins} 分钟前`
      const hours = Math.floor(mins / 60)
      if (hours < 24) return `${hours} 小时前`
      return `${Math.floor(hours / 24)} 天前`
    }
    function isStale(entry) {
      return Boolean(entry && entry.at && Date.now() - entry.at > STALE_MS)
    }
    function fmtReasoning(entry) {
      return entry && Number(entry.reasoningMs) > 0 ? ` · 思考 ${fmtMs(entry.reasoningMs)}` : ''
    }

    // 渠道报错基本是英文，直接挂在 tooltip 上新手看不懂。
    // 这里按常见错误翻译成「怎么了 + 怎么办」，原文仍附在后面方便排查。
    function explainBenchError(raw) {
      const text = String(raw || '').trim()
      if (!text) return { short: '失败', reason: '没有拿到具体原因，点 ⚡ 再试一次看看' }
      const has = (re) => re.test(text) || re.test(text.toLowerCase())
      if (has(/超时|timeout|timed out|abort/i)) {
        return { short: '超时', reason: '渠道迟迟没有回应（等了 15–22 秒）。可能是网络慢、渠道排队，或这个模型暂时卡住了；过一会儿再测，或换一个模型' }
      }
      if (/bun/i.test(text)) {
        return { short: '缺 Bun', reason: '这条免费车道要在本机装 Bun 才能跑。装好 Bun 后重试，或换一个不需要 Bun 的模型' }
      }
      if (has(/api.?key|unauthorized|invalid_api_key|authentication|permission|forbidden|\b401\b|\b403\b/i)) {
        return { short: '没权限', reason: '这个渠道的密钥无效、过期或没有权限。检查渠道设置里的 API Key，或换一个渠道' }
      }
      if (has(/\b429\b|rate.?limit|too many requests|频次|限流/i)) {
        return { short: '限流', reason: '请求太频繁或额度被打满，渠道暂时拒绝。等一两分钟再测' }
      }
      if (has(/insufficient|quota|balance|billing|payment|余额|额度/i)) {
        return { short: '额度不足', reason: '这个渠道的额度/余额不够了。充值或换一个免费渠道再测' }
      }
      if (has(/model.?not.?found|no such model|does not exist|\b404\b/i)) {
        return { short: '无此模型', reason: '这个渠道里找不到这个模型，可能已经下架或改名。换一个模型试试' }
      }
      if (has(/context.?(length|window)|too long|max.?tokens|token.?limit/i)) {
        return { short: '内容太长', reason: '这次请求超过了模型能接受的长度上限。换一个上下文更大的模型，或缩短内容' }
      }
      if (has(/\b5\d\d\b|server error|bad gateway|service unavailable|internal error/i)) {
        return { short: '服务器错', reason: '渠道自己的服务器出错了，通常过一会儿会恢复。稍后再测，或换一个渠道' }
      }
      if (has(/econn|enotfound|getaddrinfo|fetch failed|network|连接|dns|ssl|certificate/i)) {
        return { short: '网络不通', reason: '连不上这个渠道：检查网络是否正常、代理是否开着，或稍后重试' }
      }
      if (has(/empty|no content|没有返回/i)) {
        return { short: '空回复', reason: '模型没有返回任何内容。可能是渠道临时故障，重测一次或换一个模型' }
      }
      return { short: '失败', reason: '渠道返回了这个错误，完整内容见下方原文' }
    }

    // 测速失败时统一用这个：一行中文说明 + 原始报错，悬停就能看懂。
    function benchErrorTitle(raw) {
      const { reason } = explainBenchError(raw)
      return `测速失败：${reason}\n原始报错：${String(raw || '（空）')}\n点 ⚡ 重试`
    }

    async function fetchCatalog() {
      if (catalog) return catalog
      if (catalogPromise) return catalogPromise
      catalogPromise = (async () => {
        const res = await fetch(CATALOG_PATH, { credentials: 'same-origin' })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = await res.json()
        const byId = {}
        for (const g of (body && body.groups) || []) byId[g.provider] = g
        catalog = byId
        return catalog
      })().finally(() => { catalogPromise = null })
      return catalogPromise
    }

    // ---------- 模型能力：视觉 / 文本 + 上下文长度 ----------
    // DSH 的模型菜单目录只带 id/name/description/reasoning，inputModalities 与
    // context 被剥掉了；这里向 host 单独换一次，按 provider|model 缓存。
    const META_BATCH = 200
    const metaCache = new Map()
    const metaPending = new Set()
    let metaTimer = null

    function fmtContext(tokens) {
      if (!Number.isFinite(tokens) || tokens <= 0) return ''
      if (tokens >= 1e6) {
        const millions = tokens / 1e6
        return `${millions >= 10 ? Math.round(millions) : String(Math.round(millions * 10) / 10)}M`
      }
      if (tokens >= 1000) {
        const thousands = tokens / 1000
        return `${thousands >= 100 ? Math.round(thousands) : String(Math.round(thousands * 10) / 10)}K`
      }
      return String(tokens)
    }

    /** 视觉/文本与上下文的展示文案；没数据时返回 null（整段不渲染）。 */
    function describeCapability(meta) {
      if (!meta) return null
      const parts = []
      const titles = []
      if (meta.vision === true) {
        parts.push('👁️ 视觉')
        titles.push('视觉模型：能看图')
      } else if (meta.vision === false) {
        parts.push('📄 文本')
        titles.push('文本模型：不能看图')
      }
      if (Number.isFinite(meta.contextWindow) && meta.contextWindow > 0) {
        parts.push(fmtContext(meta.contextWindow))
        titles.push(`上下文 ${meta.contextWindow.toLocaleString('en-US')} tokens`)
      }
      if (parts.length === 0) return null
      return { text: parts.join(' · '), title: titles.join(' · ') }
    }

    function readMeta(providerId, modelId) {
      return metaCache.get(keyOf(providerId, modelId))
    }

    function requestMeta(providerId, modelId) {
      const key = keyOf(providerId, modelId)
      if (metaCache.has(key) || metaPending.has(key)) return
      metaPending.add(key)
      if (!metaTimer) metaTimer = setTimeout(flushMeta, 40)
    }

    function flushMeta() {
      metaTimer = null
      if (metaPending.size === 0) return
      const items = []
      for (const key of metaPending) {
        const cut = key.indexOf('|')
        items.push({ provider: key.slice(0, cut), model: key.slice(cut + 1) })
      }
      metaPending.clear()
      for (let i = 0; i < items.length; i += META_BATCH) {
        const chunk = items.slice(i, i + META_BATCH)
        fetch(META_PATH, {
          method: 'POST',
          credentials: 'same-origin',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ items: chunk }),
        }).then((res) => (res.ok ? res.json() : null)).then((body) => {
          let changed = false
          for (const item of (body && body.items) || []) {
            metaCache.set(keyOf(item.provider, item.model), {
              vision: item.vision === true ? true : item.vision === false ? false : null,
              contextWindow: Number.isFinite(item.contextWindow) && item.contextWindow > 0 ? item.contextWindow : null,
            })
            changed = true
          }
          if (changed) {
            emitChange()
            // 能力数据刚到，立刻刷一次手机菜单里的能力药丸（只改药丸，
            // 不重跑测速状态，避免每次测速都遍历上百行造成卡顿）。
            syncRowUiMetaOnly()
            syncPanelCaps()
          }
        }).catch(() => {})
      }
    }

    /** 只更新已注入的能力药丸，不动 ⚡ 与结果药丸。 */
    function syncRowUiMetaOnly() {
      if (!settings.meta) return
      for (const [label, item] of rowUi) {
        if (!label.isConnected || !item.meta) continue
        const cached = readMeta(item.providerId, item.modelId)
        const capEl = item.meta
        if (!cached) { capEl.style.display = 'none'; continue }
        const cap = describeCapability(cached)
        if (!cap) { capEl.style.display = 'none'; continue }
        if (capEl.textContent !== cap.text) capEl.textContent = cap.text
        capEl.title = cap.title
        capEl.style.display = ''
      }
    }

    // 客户端目录里若已带能力字段（新版本 DSH），直接用，省一次请求。
    function capabilityFromModel(model) {
      if (!model) return null
      const modalities = Array.isArray(model.inputModalities) ? model.inputModalities : null
      const window = model.context && Number.isFinite(model.context.contextWindow) ? model.context.contextWindow : null
      if (!modalities && !window) return null
      return { vision: modalities ? modalities.includes('image') : null, contextWindow: window }
    }

    // ---------- 桌面端：报错处的「大白话解释」 ----------
    const explainCache = new Map()
    const errorButtons = new Set()
    let activeExplainer = null
    let errorObserver = null

    function loadExplainModel() {
      try {
        const raw = window.localStorage.getItem(EXPLAIN_MODEL_KEY)
        const obj = raw ? JSON.parse(raw) : null
        if (obj && obj.provider && obj.model) {
          return { provider: String(obj.provider), model: String(obj.model) }
        }
      } catch {}
      return null
    }

    function saveExplainModel(providerId, modelId) {
      try {
        window.localStorage.setItem(
          EXPLAIN_MODEL_KEY,
          JSON.stringify({ provider: providerId, model: modelId }),
        )
      } catch {}
    }

    /** 渠道名里常带「· x0.0」这类倍率后缀，解释模型下拉框里去掉更清爽。 */
    function cleanModelName(name) {
      return String(name || '').replace(/\s*·\s*x\d+(?:\.\d+)?\s*$/i, '').trim()
    }

    function allCatalogModels() {
      const out = []
      if (!catalog) return out
      for (const group of Object.values(catalog)) {
        for (const model of (group.models || [])) {
          out.push({
            provider: group.provider,
            providerName: group.name,
            id: model.id,
            name: cleanModelName(model.name || model.id),
            free: model.free === true,
          })
        }
      }
      return out
    }

    function looksFree(model) {
      if (model.free) return true
      const hay = `${model.id || ''} ${model.name || ''} ${model.providerName || ''}`
      return /(^|[-_./\s])free([-_./\s]|$)/i.test(hay) || /免费/.test(hay)
    }

    /** 整个渠道就是免费渠道（比如 Our Free Model）时，优先级较高。 */
    function providerLooksFree(model) {
      const hay = `${model.provider || ''} ${model.providerName || ''}`
      return /(^|[-_./\s])free([-_./\s]|$)/i.test(hay) || /免费/.test(hay)
    }

    /**
     * 默认：用户上次选的；否则优先挑“限时免费”这种明确标注的免费模型，
     * 再挑免费渠道里的模型，再退到第一个免费/任意模型。
     * “限时免费”通常是渠道直接提供的免费额度，比聚合器转发的 free 车道更稳。
     */
    function pickExplainModel() {
      const all = allCatalogModels()
      const saved = loadExplainModel()
      if (saved) {
        const hit = all.find((m) => m.provider === saved.provider && m.id === saved.model)
        if (hit) return hit
      }
      const free = all.filter(looksFree)
      const limitedFree = free.find((m) => /限时免费/.test(`${m.name || ''} ${m.id || ''}`))
      return limitedFree || free.find(providerLooksFree) || free[0] || all[0] || null
    }

    function explainCacheKey(providerId, modelId, message, code) {
      return `${providerId}\u0000${modelId}\u0000${code}\u0000${message}`
    }

    async function fetchExplanation(providerId, modelId, message, code, signal) {
      const key = explainCacheKey(providerId, modelId, message, code)
      const cached = explainCache.get(key)
      if (cached) return cached
      const res = await fetch(EXPLAIN_PATH, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        credentials: 'same-origin',
        body: JSON.stringify({ provider: providerId, model: modelId, message, code }),
        signal,
      })
      if (!res.ok) throw new Error(`HTTP ${res.status}`)
      const body = await res.json()
      if (!body || body.ok !== true) throw new Error((body && body.error) || '解释失败')
      const text = String(body.text || '').trim()
      if (!text) throw new Error('模型没有返回内容')
      explainCache.set(key, text)
      if (explainCache.size > EXPLAIN_CACHE_MAX) {
        const first = explainCache.keys().next().value
        if (first !== undefined) explainCache.delete(first)
      }
      return text
    }

    function placeExplainPanel(panel, anchor) {
      if (!panel.isConnected) document.body.appendChild(panel)
      panel.style.visibility = 'hidden'
      const margin = 8
      const rect = anchor.getBoundingClientRect()
      const width = panel.offsetWidth
      const height = panel.offsetHeight
      const left = Math.min(
        Math.max(margin, rect.left),
        Math.max(margin, window.innerWidth - width - margin),
      )
      let top = rect.bottom + 6
      if (top + height > window.innerHeight - margin) {
        top = Math.max(margin, rect.top - height - 6)
      }
      panel.style.left = `${Math.round(left)}px`
      panel.style.top = `${Math.round(top)}px`
      panel.style.visibility = 'visible'
    }

    function closeExplainer() {
      const state = activeExplainer
      if (!state) return
      activeExplainer = null
      state.seq += 1
      if (state.controller) {
        try { state.controller.abort() } catch {}
        state.controller = null
      }
      if (state.cleanup) {
        try { state.cleanup() } catch {}
        state.cleanup = null
      }
      if (state.panel) state.panel.remove()
    }

    async function requestExplain(state, force) {
      if (!state.model || activeExplainer !== state) return
      const body = state.body
      const select = state.select
      const seq = ++state.seq
      if (state.controller) {
        try { state.controller.abort() } catch {}
      }
      const controller = new AbortController()
      state.controller = controller
      const timer = setTimeout(() => controller.abort(), EXPLAIN_TIMEOUT_MS)
      if (force) {
        explainCache.delete(explainCacheKey(
          state.model.provider,
          state.model.id,
          state.info.message,
          state.info.code,
        ))
      }
      body.textContent = '正在让模型用大白话解释…'
      body.style.color = ''
      select.disabled = true
      try {
        const text = await fetchExplanation(
          state.model.provider,
          state.model.id,
          state.info.message,
          state.info.code,
          controller.signal,
        )
        if (activeExplainer !== state || seq !== state.seq) return
        body.textContent = text
      } catch (error) {
        if (activeExplainer !== state || seq !== state.seq) return
        const raw = String((error && error.message) || error || '解释失败')
        const friendly = /abort/i.test(raw) || /cancel/i.test(raw)
          ? '解释超时，换一个模型或再试一次。'
          : raw
        body.textContent = `解释失败：${friendly}\n可以换下面一个模型再试。`
        body.style.color = 'var(--dsw-alias-state-error-primary, #e05561)'
      } finally {
        clearTimeout(timer)
        if (activeExplainer === state && seq === state.seq) {
          state.controller = null
          select.disabled = false
        }
      }
    }

    function fillExplainModelSelect(state, models, selected) {
      const select = state.select
      select.textContent = ''
      const byProvider = new Map()
      for (const model of models) {
        if (!byProvider.has(model.provider)) {
          byProvider.set(model.provider, { name: model.providerName || model.provider, models: [] })
        }
        byProvider.get(model.provider).models.push(model)
      }
      for (const [providerId, group] of byProvider) {
        const optgroup = document.createElement('optgroup')
        optgroup.label = group.name || providerId
        for (const model of group.models) {
          const option = document.createElement('option')
          const isFree = looksFree(model)
          const saysFree = /(^|[-_./\s])free([-_./\s]|$)/i.test(model.name || '')
            || /免费/.test(model.name || '')
          option.value = `${model.provider}\u0000${model.id}`
          option.textContent = `${model.name}${isFree && !saysFree ? ' · 免费' : ''}`
          option.title = `${model.name} · ${model.providerName || model.provider}${
            isFree ? '（免费）' : ''
          }`
          if (selected && model.provider === selected.provider && model.id === selected.id) {
            option.selected = true
          }
          optgroup.appendChild(option)
        }
        select.appendChild(optgroup)
      }
      select.disabled = false
      select.addEventListener('change', () => {
        const [providerId, modelId] = String(select.value || '').split('\u0000')
        if (!providerId || !modelId) return
        const hit = allCatalogModels().find((m) => m.provider === providerId && m.id === modelId)
        if (!hit) return
        state.model = hit
        saveExplainModel(providerId, modelId)
        requestExplain(state)
      })
    }

    async function openExplainer(anchor, info) {
      if (activeExplainer && activeExplainer.anchor === anchor) {
        closeExplainer()
        return
      }
      closeExplainer()
      const state = {
        anchor,
        info,
        panel: null,
        body: null,
        select: null,
        model: null,
        controller: null,
        seq: 0,
        cleanup: null,
      }
      activeExplainer = state

      const panel = document.createElement('div')
      panel.setAttribute('data-speedtest-explain-panel', '')
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-label', '用大白话解释这次报错')
      panel.style.cssText = [
        'position:fixed', 'z-index:2147483000',
        'width:min(380px, calc(100vw - 24px))',
        'max-height:min(60vh, 520px)', 'overflow:auto',
        'padding:12px', 'border-radius:12px',
        'background:var(--dsw-alias-bg-module-platform, #ffffff)',
        'color:var(--dsw-alias-label-primary, #1f2329)',
        'border:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12))',
        'box-shadow:var(--dsw-elevation-prominent, 0 12px 40px rgba(0,0,0,.18))',
        'font-size:12px', 'line-height:18px', 'text-align:left',
      ].join(';')

      const head = document.createElement('div')
      head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:8px;'
      const title = document.createElement('span')
      title.textContent = '这次报错是什么意思'
      title.style.cssText = 'font-weight:600;font-size:13px;'
      const close = document.createElement('button')
      close.type = 'button'
      close.textContent = '×'
      close.title = '关闭'
      close.setAttribute('aria-label', '关闭')
      close.style.cssText = 'border:0;background:transparent;color:inherit;font-size:18px;line-height:18px;cursor:pointer;padding:0 4px;opacity:.6;'
      close.addEventListener('click', closeExplainer)
      head.append(title, close)

      const modelRow = document.createElement('div')
      modelRow.style.cssText = 'display:flex;align-items:center;gap:6px;margin-bottom:8px;font-size:11px;color:var(--dsw-alias-label-secondary, #666);'
      const modelLabel = document.createElement('span')
      modelLabel.textContent = '解释用模型'
      modelLabel.style.cssText = 'flex:none;'
      const select = document.createElement('select')
      select.setAttribute('aria-label', '选择解释报错的模型')
      select.style.cssText = 'min-width:0;flex:1;font-size:11px;padding:2px 4px;border-radius:6px;border:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.15));background:transparent;color:inherit;'
      select.disabled = true
      const loadingOption = document.createElement('option')
      loadingOption.textContent = '读取中…'
      select.appendChild(loadingOption)
      modelRow.append(modelLabel, select)

      const body = document.createElement('div')
      body.setAttribute('aria-live', 'polite')
      body.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;color:var(--dsw-alias-label-primary, #1f2329);'
      body.textContent = '正在读取模型列表…'

      const tip = document.createElement('div')
      tip.style.cssText = 'margin-top:10px;padding:6px 8px;border-radius:6px;background:var(--dsw-alias-bg-l2, rgba(128,128,128,.1));font-size:11px;line-height:16px;color:var(--dsw-alias-label-secondary, #666);'
      tip.textContent = '💡 也可以直接截图这段报错，发给网页版的免费 AI 问一下，不消耗这里的额度。'

      const foot = document.createElement('div')
      foot.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-top:10px;padding-top:8px;border-top:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.08));font-size:10px;line-height:14px;color:var(--dsw-alias-label-tertiary, #999);'
      const note = document.createElement('span')
      note.textContent = '报错内容会发送给所选模型'
      const retry = document.createElement('button')
      retry.type = 'button'
      retry.textContent = '重新解释'
      retry.style.cssText = 'flex:none;border:1px solid currentColor;background:transparent;color:var(--dsw-alias-label-secondary, #666);border-radius:5px;padding:0 6px;font-size:10px;line-height:18px;cursor:pointer;'
      retry.addEventListener('click', () => { if (state.model) requestExplain(state, true) })
      foot.append(note, retry)

      panel.append(head, modelRow, body, tip, foot)
      state.panel = panel
      state.body = body
      state.select = select
      placeExplainPanel(panel, anchor)

      const onPointerDown = (event) => {
        if (activeExplainer !== state) return
        if (state.panel && state.panel.contains(event.target)) return
        if (anchor.contains(event.target)) return
        closeExplainer()
      }
      const onKeyDown = (event) => {
        if (event.key === 'Escape') closeExplainer()
      }
      const onReflow = () => {
        if (activeExplainer === state && state.panel) placeExplainPanel(state.panel, anchor)
      }
      document.addEventListener('pointerdown', onPointerDown, true)
      document.addEventListener('keydown', onKeyDown, true)
      window.addEventListener('resize', onReflow)
      window.addEventListener('scroll', onReflow, true)
      state.cleanup = () => {
        document.removeEventListener('pointerdown', onPointerDown, true)
        document.removeEventListener('keydown', onKeyDown, true)
        window.removeEventListener('resize', onReflow)
        window.removeEventListener('scroll', onReflow, true)
      }

      let models = []
      try {
        await fetchCatalog()
        models = allCatalogModels()
      } catch (error) {
        if (activeExplainer !== state) return
        body.textContent = `读取模型列表失败：${String((error && error.message) || error)}`
        body.style.color = 'var(--dsw-alias-state-error-primary, #e05561)'
        return
      }
      if (activeExplainer !== state) return
      if (models.length === 0) {
        body.textContent = '没有可用模型，无法解释。'
        return
      }
      const selected = pickExplainModel()
      state.model = selected
      fillExplainModelSelect(state, models, selected)
      requestExplain(state)
    }

    function errorInfoForRow(rowEl) {
      const row = rowEl.querySelector('[role="status"]') || rowEl
      const copy = row.querySelector('[class*="turnErrorCopy"]') || row
      const titleEl = copy.querySelector('[class*="turnErrorTitle"]')
      const messageEl = copy.querySelector('[class*="turnErrorMessage"]')
      const codeEl = row.querySelector(':scope > code') || row.querySelector('code')
      return {
        row,
        copy,
        titleEl,
        title: titleEl ? titleEl.textContent.trim() : '',
        message: messageEl ? messageEl.textContent.trim() : '',
        code: codeEl ? codeEl.textContent.trim() : '',
      }
    }

    function addErrorButton(rowEl) {
      const info = errorInfoForRow(rowEl)
      if (!info.message) return null
      if (info.code === 'INTERRUPTED' || info.code === 'ACCOUNT_SIGNED_OUT') return null
      if (info.row.querySelector('[data-speedtest-explain]')) return null
      const button = document.createElement('button')
      button.type = 'button'
      button.setAttribute('data-speedtest-explain', '')
      button.textContent = '大白话解释'
      button.title = '让模型用大白话解释这次报错'
      button.setAttribute('aria-label', '用大白话解释这次报错')
      button.style.cssText = [
        'display:inline-flex', 'align-items:center', 'justify-content:center',
        'margin-inline-start:6px', 'padding:0 6px',
        'font-size:11px', 'line-height:16px', 'font-weight:500',
        'border:1px solid currentColor', 'border-radius:5px',
        'background:transparent', 'color:var(--dsw-alias-label-secondary, #666)',
        'cursor:pointer', 'white-space:nowrap', 'vertical-align:1px',
        'opacity:0.85',
      ].join(';')
      button.addEventListener('mousedown', (event) => {
        event.preventDefault()
        event.stopPropagation()
      })
      button.addEventListener('click', (event) => {
        event.preventDefault()
        event.stopPropagation()
        openExplainer(button, errorInfoForRow(rowEl)).catch(() => {})
      })
      if (info.titleEl && info.titleEl.parentNode === info.copy) {
        info.titleEl.insertAdjacentElement('afterend', button)
      } else {
        info.copy.appendChild(button)
      }
      const item = { el: button, row: rowEl }
      errorButtons.add(item)
      return item
    }

    function injectErrorButtons() {
      if (!document.body) return
      for (const rowEl of document.querySelectorAll('[data-chat-flow-kind="turn-error"]')) {
        if (rowEl.querySelector('[data-speedtest-explain]')) continue
        addErrorButton(rowEl)
      }
      for (const item of errorButtons) {
        if (!item.el.isConnected) errorButtons.delete(item)
      }
    }

    function removeErrorButtons() {
      for (const item of errorButtons) item.el.remove()
      errorButtons.clear()
    }

    function installErrorExplainer() {
      if (!isDesktopClient) return
      if (!document.body) {
        document.addEventListener('DOMContentLoaded', installErrorExplainer, { once: true })
        return
      }
      const previous = window.__dshModelSpeedtestExplainUi
      if (previous && typeof previous.dispose === 'function') {
        try { previous.dispose() } catch {}
      }
      if (errorObserver) { errorObserver.disconnect(); errorObserver = null }
      // 设置页里关掉这个功能：撤掉按钮和观察器，不再往对话里注入。
      if (!settings.explain) {
        window.__dshModelSpeedtestExplainUi = null
        closeExplainer()
        removeErrorButtons()
        return
      }
      let scheduled = false
      const schedule = () => {
        if (scheduled) return
        scheduled = true
        Promise.resolve().then(() => {
          scheduled = false
          injectErrorButtons()
        })
      }
      errorObserver = new MutationObserver((mutations) => {
        for (const mutation of mutations) {
          if (mutation.type === 'attributes') {
            if (mutation.target.nodeType === 1
              && mutation.target.matches('[data-chat-flow-kind="turn-error"]')) {
              schedule()
              return
            }
            continue
          }
          for (const node of mutation.addedNodes) {
            if (node.nodeType !== 1) continue
            if (node.matches('[data-chat-flow-kind="turn-error"]')
              || node.querySelector('[data-chat-flow-kind="turn-error"]')
              || (node.closest && node.closest('[data-chat-flow-kind="turn-error"]'))) {
              schedule()
              return
            }
          }
        }
      })
      errorObserver.observe(document.body, {
        // 只盯报错节点的出现；childList 会因为我们自己注入的按钮被触发，
        // 但回调里只认 data-chat-flow-kind="turn-error"，不匹配直接跳过，
        // 不会形成自激循环。
        childList: true,
        subtree: true,
        attributes: true,
        attributeFilter: ['data-chat-flow-kind'],
      })
      injectErrorButtons()
      window.__dshModelSpeedtestExplainUi = {
        dispose() {
          if (errorObserver) { errorObserver.disconnect(); errorObserver = null }
          closeExplainer()
          for (const item of errorButtons) item.el.remove()
          errorButtons.clear()
        },
      }
    }

    async function bench(providerId, modelId) {
      const controller = new AbortController()
      const timer = setTimeout(() => controller.abort(), TIMEOUT_MS)
      try {
        const res = await fetch(BENCH_PATH, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          credentials: 'same-origin',
          body: JSON.stringify({ provider: providerId, model: modelId }),
          signal: controller.signal,
        })
        if (!res.ok) throw new Error(`HTTP ${res.status}`)
        const body = await res.json()
        if (!body || body.ok !== true) throw new Error((body && body.error) || '测速失败')
        return {
          firstMs: body.firstMs,
          contentFirstMs: body.contentFirstMs,
          reasoningMs: body.reasoningMs,
          isReasoning: body.isReasoning,
          tps: body.tps,
          tokens: body.tokens,
          at: Date.now(),
        }
      } finally {
        clearTimeout(timer)
      }
    }

    async function runTest(providerId, modelId) {
      const key = keyOf(providerId, modelId)
      if (inFlight.has(key)) return
      inFlight.add(key)
      const prev = store[key]
      store[key] = { ...(prev || {}), running: true, startedAt: Date.now(), error: undefined }
      emitChange()
      try {
        const r = await bench(providerId, modelId)
        store[key] = { ...r, running: false }
      } catch (error) {
        const message = String((error && error.message) || error || '失败')
        store[key] = {
          running: false,
          error: message === 'The user aborted a request.' ? '超时' : message,
          at: Date.now(),
        }
      } finally {
        inFlight.delete(key)
        saveStore()
        emitChange()
      }
    }

    /** 并发 3 测一批模型，逐个写入结果（取样测速单次很快，没必要排太久）。 */
    async function runModels(providerId, modelIds, runKey, onProgress) {
      if (inFlight.has(runKey)) return
      inFlight.add(runKey)
      emitChange()
      let cursor = 0
      let finished = 0
      const worker = async () => {
        while (cursor < modelIds.length) {
          const modelId = modelIds[cursor++]
          const key = keyOf(providerId, modelId)
          inFlight.add(key)
          store[key] = { ...(store[key] || {}), running: true, startedAt: Date.now(), error: undefined }
          emitChange()
          try {
            const r = await bench(providerId, modelId)
            store[key] = { ...r, running: false }
          } catch (error) {
            const message = String((error && error.message) || error || '失败')
            store[key] = { running: false, error: message === 'The user aborted a request.' ? '超时' : message, at: Date.now() }
          } finally {
            inFlight.delete(key)
            saveStore()
            emitChange()
          }
          finished += 1
          if (onProgress) onProgress(finished, modelIds.length)
        }
      }
      try {
        await Promise.all([worker(), worker(), worker()])
      } finally {
        inFlight.delete(runKey)
        emitChange()
      }
    }

    /** 一次测完同分组全部模型，串行逐个测，结果实时显示。 */
    async function runGroup(providerId) {
      const groupKey = `group:${providerId}`
      if (inFlight.has(groupKey)) return
      let group
      try {
        const c = await fetchCatalog()
        group = c[providerId]
      } catch (error) {
        return
      }
      if (!group || !group.models || group.models.length === 0) return
      await runModels(providerId, group.models.map((m) => m.id), groupKey)
    }

    /** 测菜单里某一段（每 20 个一段），模型列表直接取自当前 DOM，跟看到的顺序一致。 */
    async function runSegment(item) {
      if (inFlight.has(item.runKey)) return
      const ids = item.modelIds.slice()
      if (ids.length === 0) return
      segProgress.set(item.runKey, { done: 0, total: ids.length })
      try {
        await runModels(item.providerId, ids, item.runKey, (done, total) => {
          segProgress.set(item.runKey, { done, total })
          emitChange()
        })
      } finally {
        segProgress.delete(item.runKey)
        emitChange()
      }
    }

    function setIfChanged(el, prop, value) {
      if (el[prop] !== value) el[prop] = value
    }
    function setAttrIfChanged(el, name, value) {
      if (el.getAttribute(name) !== value) el.setAttribute(name, value)
    }
    function setStyleIfChanged(el, prop, value) {
      if (el.style[prop] !== value) el.style[prop] = value
    }
    function updateGroupButton(item) {
      const running = inFlight.has(`group:${item.providerId}`)
      const text = running ? '测本组…' : '测本组'
      if (item.el.textContent !== text) item.el.textContent = text
      setIfChanged(item.el, 'title', running ? '正在测试这个分组的全部模型' : '一次测完这个分组的全部模型')
      setAttrIfChanged(item.el, 'aria-busy', running ? 'true' : 'false')
      setStyleIfChanged(item.el, 'cursor', running ? 'progress' : 'pointer')
      setStyleIfChanged(item.el, 'opacity', running ? '0.6' : '')
      setIfChanged(item.el, 'className', running ? 'lsm-group lsm-group--busy' : 'lsm-group')
    }

    function syncGroupButtons() {
      for (const item of groupButtons) {
        if (!item.el.isConnected || !item.heading.isConnected) { groupButtons.delete(item); continue }
        updateGroupButton(item)
      }
    }

    function addGroupButton(heading, providerId) {
      for (const candidate of groupButtons) {
        if (candidate.heading === heading) return candidate
      }
      const el = document.createElement('span')
      el.setAttribute('data-speedtest-group', providerId)
      el.setAttribute('role', 'button')
      el.setAttribute('tabindex', '0')
      el.setAttribute('aria-label', '测本组')
      el.className = 'lsm-group'
      const activate = (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (!inFlight.has(`group:${providerId}`)) runGroup(providerId)
      }
      el.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation() })
      el.addEventListener('click', activate)
      el.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') activate(event)
      })
      // 标题原本是一行文字；改成两端对齐后，按钮贴在右侧，文字仍靠左。
      heading.style.display = 'flex'
      heading.style.alignItems = 'center'
      heading.style.justifyContent = 'space-between'
      heading.style.gap = '8px'
      heading.appendChild(el)
      const item = { el, heading, providerId }
      groupButtons.add(item)
      updateGroupButton(item)
      return item
    }

    function removeGroupButtons() {
      for (const item of groupButtons) item.el.remove()
      groupButtons.clear()
    }

    function injectGroupButtons() {
      if (!document.body) return
      // 桌面端不塞菜单里的「⚡ 测速」入口；顺手清掉热更新前留下的。
      if (!isMobileClient) removeMenuEntries()
      if (!settings.speedTest || !settings.groupTest) {
        removeGroupButtons()
        removeMenuEntries()
        return
      }
      for (const section of document.querySelectorAll('[data-menu-group]')) {
        const heading = section.querySelector(':scope > [data-menu-group-heading]')
        if (!heading) continue
        // 只认模型菜单：分组里必须有带 provider/model 属性的模型行。
        const label = section.querySelector('[data-model-id][data-provider-id]')
        if (!label) continue
        const providerId = label.getAttribute('data-provider-id')
        if (!providerId) continue
        if (heading.querySelector('[data-speedtest-group]')) continue
        addGroupButton(heading, providerId)
        // 「⚡ 测速」入口是给手机上打不开面板的场景准备的，桌面端有设置页，不塞。
        if (isMobileClient) addMenuSpeedEntry(heading, providerId)
      }
      syncGroupButtons()
    }

    // 模型选择菜单里的「⚡ 测速」入口：就在分组标题上，不用去点悬浮按钮
    const menuEntries = new Set()
    function addMenuSpeedEntry(heading, providerId) {
      if (menuEntries.has(heading)) return
      const el = document.createElement('span')
      el.setAttribute('data-speedtest-menu-entry', providerId)
      el.setAttribute('role', 'button')
      el.setAttribute('tabindex', '0')
      el.setAttribute('aria-label', '打开模型测速面板')
      el.className = 'lsm-menu-entry'
      el.textContent = '⚡ 测速'
      const activate = (e) => {
        e.preventDefault(); e.stopPropagation()
        openFloatingPanel()
      }
      el.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
      el.addEventListener('click', activate)
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') activate(e) })
      heading.appendChild(el)
      menuEntries.add(heading)
    }
    function removeMenuEntries() {
      for (const h of menuEntries) {
        const el = h.querySelector && h.querySelector('[data-speedtest-menu-entry]')
        if (el) el.remove()
      }
      menuEntries.clear()
    }

    // ---------- 大分组分段测试：每 20 个模型一条「测这一段」 ----------
    function segmentLabel(item) {
      return item.start === item.end ? `测第 ${item.start + 1} 个` : `测 ${item.start + 1}–${item.end + 1}`
    }

    function updateSegmentButton(item) {
      const running = inFlight.has(item.runKey)
      const progress = segProgress.get(item.runKey)
      const count = item.end - item.start + 1
      const text = running
        ? `⚡ 测试中 ${progress ? progress.done : 0}/${progress ? progress.total : count}`
        : `⚡ ${segmentLabel(item)}`
      if (item.btn.textContent !== text) item.btn.textContent = text
      setIfChanged(item.btn, 'className', running ? 'lsm-seg-btn lsm-seg-btn--busy' : 'lsm-seg-btn')
      setIfChanged(item.btn, 'title', running
        ? '正在测试这一段模型'
        : `测第 ${item.start + 1} 到 ${item.end + 1} 个模型（共 ${count} 个）`)
      setAttrIfChanged(item.btn, 'aria-busy', running ? 'true' : 'false')
      setStyleIfChanged(item.btn, 'cursor', running ? 'progress' : 'pointer')
    }

    function syncSegmentButtons() {
      for (const item of segmentRows) {
        if (!item.row.isConnected) { segmentRows.delete(item); continue }
        updateSegmentButton(item)
      }
    }

    /** 这个模型是否正在某段的队列里排队测（避免单点 ⚡ 和分段测试撞在一起）。 */
    function queuedInSegment(providerId, modelId) {
      for (const item of segmentRows) {
        if (item.providerId !== providerId) continue
        if (!inFlight.has(item.runKey)) continue
        if (item.modelIds.includes(modelId)) return true
      }
      return false
    }

    function createSegmentRow(providerId, start, end, modelIds) {
      const row = document.createElement('div')
      row.className = 'lsm-seg'
      row.setAttribute('data-speedtest-seg', `${providerId}:${start}`)
      row.setAttribute('role', 'presentation')
      const btn = document.createElement('span')
      btn.className = 'lsm-seg-btn'
      btn.setAttribute('role', 'button')
      btn.setAttribute('tabindex', '0')
      btn.setAttribute('aria-label', `测第 ${start + 1} 到 ${end + 1} 个模型`)
      const item = { row, btn, providerId, start, end, modelIds, runKey: `seg:${providerId}:${start}` }
      row.__lsmSegItem = item
      const activate = (event) => {
        event.preventDefault()
        event.stopPropagation()
        runSegment(item)
      }
      btn.addEventListener('mousedown', (event) => { event.preventDefault(); event.stopPropagation() })
      btn.addEventListener('click', activate)
      btn.addEventListener('keydown', (event) => {
        if (event.key === 'Enter' || event.key === ' ') activate(event)
      })
      row.appendChild(btn)
      updateSegmentButton(item)
      return item
    }

    // 菜单里的模型行是 section 的直接子 BUTTON，模型 id 挂在按钮内部的 span 上。
    function readModelId(rowEl) {
      const label = rowEl && rowEl.querySelector ? rowEl.querySelector('[data-model-id][data-provider-id]') : null
      return label ? label.getAttribute('data-model-id') : ''
    }

    // ---------- 模型行 ⚡ + 结果药丸（DOM 注入版，只在插槽缺席时兜底） ----------
    // 有的手机版模型菜单不渲染 React 的 conversation.input.model.label 插槽，
    // 这时 SpeedTestLabel 永远不出现。这里直接往模型行 DOM 里塞一份。
    // 判断依据是「这一行有没有插槽画的 UI」而不是 UA：插槽一旦画出来就撤掉自己那份，
    // 否则同一行会出现两个 ⚡ 和两个药丸。
    const rowUi = new Map()   // label span -> { bolt, pill, providerId, modelId, row }

    function makeBolt(providerId, modelId) {
      const el = document.createElement('span')
      el.className = 'lsm-bolt lsm-dom-bolt'
      el.setAttribute('data-speedtest-bolt', `${providerId}|${modelId}`)
      el.setAttribute('role', 'button')
      el.setAttribute('tabindex', '0')
      el.textContent = '⚡'
      const activate = (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (inFlight.has(keyOf(providerId, modelId)) || queuedInSegment(providerId, modelId)) return
        runTest(providerId, modelId)
      }
      el.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
      el.addEventListener('click', activate)
      el.addEventListener('keydown', (e) => { if (e.key === 'Enter' || e.key === ' ') activate(e) })
      return el
    }

    function syncRowUi() {
      for (const [label, item] of rowUi) {
        if (!label.isConnected) { rowUi.delete(label); continue }
        const providerId = item.providerId
        const modelId = item.modelId
        const entry = readEntry(providerId, modelId)
        const key = keyOf(providerId, modelId)
        const running = inFlight.has(key) || Boolean(entry && entry.running)
        const groupRunning = inFlight.has(`group:${providerId}`)
        const failed = entry && entry.error
        const done = entry && !entry.error && Number.isFinite(entry.firstMs)
        const stale = done && isStale(entry)
        const shownFirst = done && Number(entry.contentFirstMs) > 0 ? entry.contentFirstMs : done ? entry.firstMs : 0

        let cls = 'lsm-bolt lsm-dom-bolt'
        if (running) cls += ' lsm-bolt--run'
        else if (failed) cls += ' lsm-bolt--fail'
        else if (done) cls += ' lsm-bolt--done'
        item.bolt.className = cls
        item.bolt.style.opacity = groupRunning && !running ? '0.45' : ''
        item.bolt.style.pointerEvents = groupRunning && !running ? 'none' : ''

        const elapsed = running && entry && entry.startedAt ? Date.now() - entry.startedAt : 0
        let text = ''
        let pillCls = 'lsm-pill lsm-dom-pill'
        if (failed) {
          const { short } = explainBenchError(entry.error)
          text = `✗ ${short}`
          pillCls += ' lsm-pill--bad'
          item.pill.title = benchErrorTitle(entry.error)
          item.bolt.title = benchErrorTitle(entry.error)
        } else if (running) {
          item.pill.title = '测速中…'
          item.bolt.title = '测速中…'
          text = elapsed >= 700 ? `${(elapsed / 1000).toFixed(1)}s` : '测速中'
          pillCls += ' lsm-pill--run'
        } else if (done) {
          const shownReasoning = Number(entry.reasoningMs) > 0 ? ` · 思考 ${fmtMs(entry.reasoningMs)}` : ''
          item.pill.title = `首字 ${fmtMs(shownFirst)}${shownReasoning} · ${fmtTps(entry.tps)} · 点 ⚡ 重测`
          item.bolt.title = item.pill.title
          text = `${fmtMs(shownFirst)} · ${fmtTps(entry.tps)}${stale ? ' ·旧' : ''}`
          pillCls += stale ? ' lsm-pill--stale' : ' lsm-pill--good'
        } else if (!groupRunning) {
          item.pill.title = '还没测过，点 ⚡ 测一下'
          item.bolt.title = item.pill.title
          text = '未测'
          pillCls += ' lsm-pill--idle'
        }
        item.pill.textContent = text
        item.pill.className = pillCls
        item.pill.style.display = text ? '' : 'none'

        // 能力药丸：与桌面端 SpeedTestLabel 一样，先看目录自带字段，
        // 没有就走 /meta 批量缓存；空数据不占位。
        const capEl = item.meta
        if (capEl) {
          if (!settings.meta) { capEl.style.display = 'none' }
          else {
            const cached = readMeta(providerId, modelId)
            if (!cached) {
              capEl.style.display = 'none'
              requestMeta(providerId, modelId)
            } else {
              const cap = describeCapability(cached)
              if (!cap) { capEl.style.display = 'none' }
              else {
                if (capEl.textContent !== cap.text) capEl.textContent = cap.text
                capEl.title = cap.title
                capEl.style.display = ''
              }
            }
          }
        }
      }
    }

    function removeRowUi() {
      for (const [, item] of rowUi) {
        item.bolt.remove()
        item.pill.remove()
        if (item.meta && item.meta.remove) item.meta.remove()
      }
      rowUi.clear()
    }

    function removeRowUiItem(item) {
      if (!item) return
      if (item.bolt && item.bolt.remove) item.bolt.remove()
      if (item.pill && item.pill.remove) item.pill.remove()
      if (item.meta && item.meta.remove) item.meta.remove()
    }

    // React 插槽画出来的 ⚡ 带 .lsm-bolt 但没有 .lsm-dom-bolt；
    // 有它就说明这一行已经由插槽负责，DOM 注入必须让位，否则一行两个闪电。
    function rowHasSlotUi(label) {
      return Boolean(label.querySelector('.lsm-bolt:not(.lsm-dom-bolt), .lsm-pill:not(.lsm-dom-pill)'))
    }

    function injectRowUi() {
      if (!document.body) return
      if (!settings.speedTest) { removeRowUi(); return }
      for (const section of document.querySelectorAll('[data-menu-group]')) {
        for (const row of section.children) {
          const label = row.querySelector && row.querySelector('[data-model-id][data-provider-id]')
          if (!label) continue
          const providerId = label.getAttribute('data-provider-id') || ''
          const modelId = label.getAttribute('data-model-id') || ''
          if (!providerId || !modelId) continue
          // 插槽已经画了（桌面端 / 网页版，以及手机上偶尔能画的版本）→ 撤掉自己那份。
          if (rowHasSlotUi(label)) {
            if (rowUi.has(label)) {
              removeRowUiItem(rowUi.get(label))
              rowUi.delete(label)
            }
            continue
          }
          if (rowUi.has(label)) continue
          // 已经注入过（热更新/HMR 场景）也跳过，绝不重复写
          if (label.querySelector('[data-speedtest-bolt]')) continue
          const bolt = makeBolt(providerId, modelId)
          const pill = document.createElement('span')
          pill.className = 'lsm-pill lsm-dom-pill'
          pill.style.marginInlineStart = '4px'
          // 能力药丸：与桌面端 SpeedTestLabel 的 .lsm-meta 完全同一套
          // （👁️ 视觉 · 200K / 📄 文本 · 128K），手机菜单不渲染插槽时由这里兜底。
          const meta = document.createElement('span')
          meta.className = 'lsm-meta lsm-dom-meta'
          meta.setAttribute('data-speedtest-meta', `${providerId}|${modelId}`)
          meta.style.display = 'none'
          label.appendChild(bolt)
          label.appendChild(pill)
          label.appendChild(meta)
          rowUi.set(label, { bolt, pill, meta, providerId, modelId, row })
        }
      }
      syncRowUi()
    }

    // ---------- 手机端：模型行可左右拖动 ----------
    // 名字 + ⚡ + 结果 + 能力药丸挤一行，窄屏会顶出屏幕外。给每个
    // [data-model-id][data-provider-id] 的 label 打标记，靠 CSS 开原生
    // 横向滚动（手指可左右拖，隐藏滚动条）。纯属性、幂等、不新增节点，
    // 不会被低频扫描反复触发，也不碰测速/点击逻辑。
    const HSCROLL_ATTR = 'data-lsm-hscroll'
    const hscrollBound = new WeakSet()
    // 按住左右拖：原生 overflow 滚动在某些 ROM / WebView 上横向手势会被
    // 父级竖向列表抢走，补一层 pointer 拖拽滚动，拖起来更跟手。
    // 只在水平位移超过 6px 后接管；点击 ⚡ / 模型行不受影响。
    function bindHScrollDrag(el) {
      if (hscrollBound.has(el)) return
      hscrollBound.add(el)
      let dragging = false
      let moved = false
      let swallowClick = false   // 拖完那一轮的 click 要吞掉，避免误触测速
      let startX = 0
      let startLeft = 0
      const down = (e) => {
        // 只认主按钮 / 单指触摸，别干扰 ⚡ 上的点击
        if (e.button != null && e.button !== 0) return
        dragging = true
        moved = false
        swallowClick = false
        startX = e.clientX
        startLeft = el.scrollLeft || 0
      }
      const move = (e) => {
        if (!dragging) return
        const dx = e.clientX - startX
        if (Math.abs(dx) > 6) moved = true
        if (!moved) return
        el.scrollLeft = startLeft - dx
        // 接管后阻止默认（避免父级竖向滚动 / 选中文字）
        if (e.cancelable) e.preventDefault()
      }
      const up = () => {
        dragging = false
        swallowClick = moved
        moved = false
      }
      el.addEventListener('pointerdown', down, { passive: true })
      el.addEventListener('pointermove', move, { passive: false })
      el.addEventListener('pointerup', up)
      el.addEventListener('pointercancel', up)
      // click 在 pointerup 之后派发，用独立标志吞掉拖动那一轮
      el.addEventListener('click', (e) => {
        if (!swallowClick) return
        swallowClick = false
        e.preventDefault()
        e.stopPropagation()
      }, true)
    }
    function injectHScroll() {
      if (!document.body || !isMobileClient) return
      // 直接给模型 label 打标记：它就是模型行里承载名字 + ⚡ + 结果 +
      // 能力药丸的那个 span，开横向滚动即可，不动任何父级 DOM 结构。
      // 桌面端 / 网页版不打标，React 重渲染丢了属性由低频扫描补回。
      for (const label of document.querySelectorAll('[data-model-id][data-provider-id]')) {
        if (label.hasAttribute && !label.hasAttribute(HSCROLL_ATTR)) {
          if (label.setAttribute) label.setAttribute(HSCROLL_ATTR, '')
        }
        if (label.addEventListener) bindHScrollDrag(label)
      }
    }
    function removeHScroll() {
      if (!document.body) return
      for (const label of document.querySelectorAll('[' + HSCROLL_ATTR + ']')) {
        if (label.removeAttribute) label.removeAttribute(HSCROLL_ATTR)
      }
    }

    function removeSegmentRows() {
      for (const item of segmentRows) item.row.remove()
      segmentRows.clear()
      segProgress.clear()
    }

    function injectSegmentRows() {
      if (!document.body) return
      if (!settings.speedTest || !settings.segmentTest) {
        removeSegmentRows()
        return
      }
      const segmentSize = settings.segmentSize
      for (const section of document.querySelectorAll('[data-menu-group]')) {
        const rows = [...section.children].filter((el) => readModelId(el) !== '')
        const providerId = rows.length > 0
          ? rows[0].querySelector('[data-model-id][data-provider-id]').getAttribute('data-provider-id')
          : ''
        const existing = new Map()
        for (const el of section.querySelectorAll('[data-speedtest-seg]')) {
          existing.set(el.getAttribute('data-speedtest-seg'), el)
        }
        // 小分组没必要分段；目录被搜索过滤后也按当前可见行重算。
        if (!providerId || rows.length <= segmentSize) {
          for (const el of existing.values()) {
            if (el.__lsmSegItem) segmentRows.delete(el.__lsmSegItem)
            el.remove()
          }
          continue
        }
        const wanted = new Set()
        for (let start = 0; start < rows.length; start += segmentSize) {
          const end = Math.min(start + segmentSize, rows.length) - 1
          const key = `${providerId}:${start}`
          wanted.add(key)
          const modelIds = rows.slice(start, end + 1).map(readModelId)
          // 分隔行放在这一段第一个模型的前面：「测 1–20」在分组开头，
          // 「测 21–40」紧挨着第 21 个模型（也就是 0 基第 20 个）。
          const firstRow = rows[start]
          const el = existing.get(key)
          if (!el || !el.__lsmSegItem) {
            if (el) { el.remove(); segmentRows.delete(el.__lsmSegItem) }
            const item = createSegmentRow(providerId, start, end, modelIds)
            segmentRows.add(item)
            firstRow.before(item.row)
            continue
          }
          const item = el.__lsmSegItem
          const changed = item.end !== end
            || item.modelIds.length !== modelIds.length
            || item.modelIds.some((id, index) => id !== modelIds[index])
          item.end = end
          item.modelIds = modelIds
          if (changed) updateSegmentButton(item)
          // 位置不对才移动，避免无意义的 DOM 抖动；比较用真实兄弟节点。
          if (el.parentNode === section && el.nextElementSibling !== firstRow) firstRow.before(el)
        }
        for (const [key, el] of existing) {
          if (wanted.has(key)) continue
          if (el.__lsmSegItem) segmentRows.delete(el.__lsmSegItem)
          el.remove()
        }
      }
      syncSegmentButtons()
    }

    /** 设置页里改开关后立即生效：按钮/分段/解释按钮跟着增删。 */
    function applySettings() {
      if (!document.body) return
      injectGroupButtons()
      injectSegmentRows()
      injectRowUi()
      injectHScroll()
      installErrorExplainer()
      // 悬浮 ⚡ 圆按钮已移除（入口改为模型菜单分组标题里的「⚡ 测速」）。
      // 关掉测速时把已打开的面板一起收起即可。
      if (!settings.speedTest) closeFloatingPanel()
    }

    // 不用 MutationObserver：菜单展开时 React 高频改 DOM，observer 的异步
    // MutationRecord 会和注入函数自身的写入形成自激循环，把整个界面冻死。
    // 改成低频定时器 + 全幂等注入（没有任何写入会触发回调，天然收敛）。
    let injecting = false
    function withSilentMutations(fn) {
      injecting = true
      try { fn() } finally { injecting = false }
    }
    let scanTimer = null

    function installGroupButtons() {
      if (!document.body) {
        document.addEventListener('DOMContentLoaded', installGroupButtons, { once: true })
        return
      }
      const previous = window.__dshModelSpeedtestGroupUi
      if (previous && typeof previous.dispose === 'function') {
        try { previous.dispose() } catch {}
      }
      if (groupObserver) { groupObserver.disconnect(); groupObserver = null }
      if (scanTimer) { clearInterval(scanTimer); scanTimer = null }
      let lastRowScan = 0
      const scan = (force) => {
        if (injecting) return
        withSilentMutations(() => {
          injectGroupButtons()
          injectSegmentRows()
          // 逐行 ⚡ 只在菜单打开时每 2 秒扫一次，且完全幂等
          const now = Date.now()
          if (force || now - lastRowScan > 2000) {
            lastRowScan = now
            injectRowUi()
            syncRowUi()
            injectHScroll()
          }
        })
      }
      scan(true)
      // 低频扫描跟上菜单展开/搜索过滤；无任何自激回调，天然收敛
      scanTimer = setInterval(() => scan(false), 800)
      window.__dshModelSpeedtestGroupUi = {
        dispose() {
          if (scanTimer) { clearInterval(scanTimer); scanTimer = null }
          if (groupObserver) { groupObserver.disconnect(); groupObserver = null }
          removeRowUi()
          removeHScroll()
          removeMenuEntries()
          for (const item of groupButtons) item.el.remove()
          groupButtons.clear()
          for (const item of segmentRows) item.row.remove()
          segmentRows.clear()
          segProgress.clear()
        },
      }
    }

    function SpeedTestLabel({ provider, model, placement }) {
      const [, force] = react.useState(0)
      react.useEffect(() => subscribe(() => force((n) => n + 1)), [])

      const providerId = provider && provider.id
      const modelId = model && model.id
      if (!providerId || !modelId) return null

      const showSpeed = settings.speedTest
      const showMeta = settings.meta && placement !== 'trigger'
      const entry = readEntry(providerId, modelId)
      const running = inFlight.has(keyOf(providerId, modelId)) || Boolean(entry && entry.running)
      const groupRunning = inFlight.has(`group:${providerId}`)
      const runningSince = showSpeed && running && entry && entry.startedAt ? entry.startedAt : 0
      // 测速进行中每 250ms 刷新一次，让用户看到已经等了多久。
      react.useEffect(() => {
        if (!runningSince) return undefined
        const timer = setInterval(() => force((n) => n + 1), 250)
        return () => clearInterval(timer)
      }, [runningSince])
      const failed = entry && entry.error
      const done = entry && !entry.error && Number.isFinite(entry.firstMs)
      const stale = done && isStale(entry)
      const compact = placement === 'trigger'
      // 视觉/文本 + 上下文长度：只在弹出菜单里显示，触发器上保持简洁。
      let capability = null
      if (showMeta) {
        const direct = capabilityFromModel(model)
        if (direct) {
          capability = describeCapability(direct)
        } else {
          const cached = readMeta(providerId, modelId)
          if (cached) capability = describeCapability(cached)
          else requestMeta(providerId, modelId)
        }
      }
      // 思考模型优先展示正文首字——那才是用户真正看到字的时间。
      const shownFirst = done && Number(entry.contentFirstMs) > 0 ? entry.contentFirstMs : done ? entry.firstMs : 0

      const elapsed = runningSince ? Date.now() - runningSince : 0

      const title = failed
        ? benchErrorTitle(entry.error)
        : running
          ? '测速中…'
          : done
            ? `首字 ${fmtMs(shownFirst)}${fmtReasoning(entry)} · ${fmtTps(entry.tps)}（${entry.tokens || 0} tokens）${
              entry.burst ? ' · 渠道一次性返回了整段回复（可能命中缓存），生成速度无法可靠采样' : ''
            }${stale ? ` · 测于 ${fmtAge(entry.at)}，建议重测` : ''} · 点 ⚡ 重测`
            : '点 ⚡ 测这个模型；「测本组」测同渠道全部，模型多的分组每 20 个有「测这一段」'

      // 每次测速出结果时换 key：bolt 重挂载，弹跳/抖动动画只播一次。
      const stateKey = `${running ? 'r' : failed ? 'f' : done ? 'd' : 'i'}-${entry && entry.at ? entry.at : 0}`

      const boltClass = ['lsm-bolt']
      if (running) boltClass.push('lsm-bolt--run')
      else if (failed) boltClass.push('lsm-bolt--fail')
      else if (done) boltClass.push('lsm-bolt--done')

      const onBolt = (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (running || groupRunning || queuedInSegment(providerId, modelId)) return
        runTest(providerId, modelId)
      }

      const bolt = showSpeed ? react.createElement('span', {
        key: `bolt-${stateKey}`,
        className: boltClass.join(' '),
        role: 'button',
        tabIndex: 0,
        title,
        'aria-label': title,
        'aria-busy': running ? 'true' : undefined,
        onMouseDown: (event) => { event.preventDefault(); event.stopPropagation() },
        onClick: onBolt,
        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') onBolt(event) },
        style: { marginInlineStart: compact ? '4px' : '10px' },
        children: '⚡',
      }) : null

      // 结果药丸：测过就亮出来，没测过写「未测」，失败带短原因。
      let speed = null
      if (showSpeed && failed) {
        // 药丸里只放短词；长报错留给悬停提示，免得把上下文长度挤走。
        const { short } = explainBenchError(entry.error)
        speed = react.createElement('span', {
          key: 'speed',
          className: 'lsm-pill lsm-pill--bad',
          title,
          children: `✗ ${short}`,
        })
      } else if (showSpeed && running) {
        if (elapsed >= 700) {
          speed = react.createElement('span', {
            key: 'speed',
            className: 'lsm-pill lsm-pill--run',
            title,
            children: `${(elapsed / 1000).toFixed(1)}s`,
          })
        }
      } else if (showSpeed && done) {
        speed = react.createElement('span', {
          key: 'speed',
          className: `lsm-pill ${stale ? 'lsm-pill--stale' : 'lsm-pill--good'}`,
          title,
          children: `${fmtMs(shownFirst)} · ${fmtTps(entry.tps)}${stale ? ' ·旧' : ''}`,
        })
      }

      // 没测过的模型点明一下，免得以为插件没干活。
      const idle = showSpeed && !running && !groupRunning && !failed && !done && !compact
      const idlePill = idle
        ? react.createElement('span', {
          key: 'idle',
          className: 'lsm-pill lsm-pill--idle',
          title: '还没测过，点 ⚡ 测一下',
          children: '未测',
        })
        : null

      const meta = capability
        ? react.createElement('span', {
          key: 'meta',
          className: 'lsm-meta',
          title: capability.title,
          children: capability.text,
        })
        : null

      return react.createElement('span', {
        style: { display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap' },
      }, [
        react.createElement('span', { key: 'name', style: { display: 'inline' }, children: (model && model.name) || modelId }),
        bolt,
        speed,
        idlePill,
        meta,
      ])
    }

    /** 可爱的外观：圆润药丸 + 琥珀色闪电 + 小动效（尊重 prefers-reduced-motion）。 */
    function injectStyles() {
      if (typeof document === 'undefined' || !document.head || document.getElementById('lsm-styles')) return
      const style = document.createElement('style')
      style.id = 'lsm-styles'
      style.textContent = [
        '.lsm-bolt{display:inline-flex;align-items:center;justify-content:center;padding:0 6px;border-radius:999px;font-size:.95em;line-height:1.6;color:#d97706;background:rgba(251,191,36,.22);border:1px solid rgba(251,191,36,.5);cursor:pointer;user-select:none;vertical-align:middle;transition:transform .12s ease,background .2s ease}',
        '.lsm-bolt:hover{transform:scale(1.14);background:rgba(251,191,36,.4)}',
        '.lsm-bolt--run{animation:lsm-pulse 1s ease-in-out infinite}',
        '.lsm-bolt--done{animation:lsm-pop .45s ease}',
        '.lsm-bolt--fail{animation:lsm-shake .45s ease}',
        '.lsm-pill{display:inline-flex;align-items:center;white-space:nowrap;border-radius:999px;padding:0 8px;margin-inline-start:6px;font-size:.8em;font-weight:600;line-height:1.6;vertical-align:middle}',
        '.lsm-pill--good{color:#15803d;background:rgba(34,197,94,.14)}',
        '.lsm-pill--stale{color:#6b7280;background:rgba(148,163,184,.18)}',
        '.lsm-pill--bad{color:#dc2626;background:rgba(239,68,68,.12)}',
        '.lsm-pill--run{color:#b45309;background:linear-gradient(90deg,rgba(251,191,36,.16),rgba(251,191,36,.38),rgba(251,191,36,.16));background-size:200% 100%;animation:lsm-shimmer 1.4s linear infinite}',
        '.lsm-pill--idle{color:#6b7280;background:rgba(120,125,140,.12)}',
        '.lsm-meta{display:inline-flex;align-items:center;white-space:nowrap;border-radius:999px;padding:0 8px;margin-inline-start:6px;font-size:.76em;font-weight:600;color:inherit;background:rgba(120,125,140,.14);vertical-align:middle}',
        '.lsm-group{display:inline-flex;align-items:center;justify-content:center;flex:none;margin-inline-start:8px;padding:0 10px;border-radius:999px;font-size:10px;font-weight:700;color:#7c2d12;background:rgba(251,191,36,.22);border:1px solid rgba(251,191,36,.5);cursor:pointer;user-select:none;white-space:nowrap;transition:transform .12s ease,background .2s ease}',
        '.lsm-group:hover{transform:scale(1.06);background:rgba(251,191,36,.4)}',
        '.lsm-group--busy{animation:lsm-pulse 1s ease-in-out infinite}',
        '.lsm-seg{display:flex;align-items:center;gap:8px;padding:5px 14px;pointer-events:none;user-select:none}',
        '.lsm-seg::before,.lsm-seg::after{content:"";flex:1;height:1px;background:linear-gradient(90deg,rgba(251,191,36,0),rgba(251,191,36,.45))}',
        '.lsm-seg::after{background:linear-gradient(90deg,rgba(251,191,36,.45),rgba(251,191,36,0))}',
        '.lsm-seg-btn{pointer-events:auto;display:inline-flex;align-items:center;gap:2px;padding:1px 10px;border-radius:999px;font-size:10px;font-weight:700;color:#7c2d12;background:rgba(251,191,36,.16);border:1px solid rgba(251,191,36,.45);cursor:pointer;white-space:nowrap;transition:transform .12s ease,background .2s ease}',
        '.lsm-seg-btn:hover{transform:scale(1.06);background:rgba(251,191,36,.34)}',
        '.lsm-menu-entry{display:inline-flex;align-items:center;flex:none;margin-inline-start:6px;padding:0 8px;border-radius:999px;font-size:11px;font-weight:700;color:#7c2d12;background:rgba(251,191,36,.22);border:1px solid rgba(251,191,36,.5);cursor:pointer;user-select:none;white-space:nowrap}',
        '.lsm-menu-entry:hover{background:rgba(251,191,36,.4)}',
        '.lsm-seg-btn--busy{animation:lsm-pulse 1s ease-in-out infinite}',
        '.lsm-settings{display:flex;flex-direction:column;gap:10px;max-width:640px}',
        '.lsm-settings-head{display:flex;align-items:center;justify-content:space-between;gap:10px;flex-wrap:wrap}',
        '.lsm-settings-head-left{display:flex;align-items:center;gap:8px}',
        '.lsm-settings-title{font-size:16px;font-weight:700;color:var(--dsw-alias-label-primary,inherit)}',
        '.lsm-ver{font-size:11px;font-weight:700;color:#b45309;background:rgba(251,191,36,.22);border-radius:999px;padding:1px 8px}',
        '.lsm-star-pill{display:inline-flex;align-items:center;gap:5px;border-radius:999px;padding:4px 12px;font-size:12px;font-weight:700;text-decoration:none;color:var(--dsw-alias-label-primary,inherit);background:rgba(251,191,36,.16);border:1px solid rgba(251,191,36,.52);cursor:pointer;white-space:nowrap;transition:transform .14s ease,background .2s ease,box-shadow .2s ease}',
        '.lsm-star-pill:hover{transform:translateY(-1px) scale(1.03);background:rgba(251,191,36,.28);box-shadow:0 3px 10px rgba(245,158,11,.22)}',
        '.lsm-star-pill-icon{color:#f59e0b;display:inline-block;transition:transform .22s ease}',
        '.lsm-star-pill:hover .lsm-star-pill-icon{transform:rotate(18deg) scale(1.18)}',
        '.lsm-star-card{border:1px solid rgba(251,191,36,.44);border-radius:12px;padding:14px 16px;background:linear-gradient(135deg,rgba(251,191,36,.13) 0%,rgba(245,158,11,.03) 100%);transition:border-color .2s ease}',
        '.lsm-star-card:hover{border-color:rgba(251,191,36,.72)}',
        '.lsm-star-row{display:flex;align-items:center;justify-content:space-between;gap:14px;flex-wrap:wrap}',
        '.lsm-star-info{display:flex;flex-direction:column;gap:5px;flex:1;min-width:220px}',
        '.lsm-star-top{display:flex;align-items:center;gap:8px;flex-wrap:wrap}',
        '.lsm-star-tag{display:inline-flex;align-items:center;gap:3px;border-radius:999px;padding:1px 8px;font-size:11px;font-weight:700;color:var(--dsw-alias-label-primary,inherit);background:rgba(251,191,36,.22);border:1px solid rgba(251,191,36,.42)}',
        '.lsm-star-btn{position:relative;overflow:hidden;display:inline-flex;align-items:center;justify-content:center;gap:6px;flex:none;border:none;border-radius:999px;padding:9px 18px;font-size:13px;font-weight:700;text-decoration:none;color:#451a03;background:linear-gradient(135deg,#fde047 0%,#fbbf24 50%,#f59e0b 100%);box-shadow:0 4px 14px rgba(245,158,11,.34);cursor:pointer;white-space:nowrap;transition:transform .16s ease,box-shadow .2s ease,filter .2s ease}',
        '.lsm-star-btn::after{content:"";position:absolute;top:0;left:-80%;width:55%;height:100%;background:linear-gradient(110deg,transparent 0%,rgba(255,255,255,.55) 50%,transparent 100%);transform:skewX(-18deg);animation:lsm-sheen 4.5s ease-in-out infinite}',
        '.lsm-star-btn:hover{transform:translateY(-1px) scale(1.04);box-shadow:0 6px 20px rgba(245,158,11,.48);filter:brightness(1.04)}',
        '.lsm-star-btn:active{transform:scale(.97)}',
        '.lsm-star-btn--done{background:linear-gradient(135deg,#86efac 0%,#4ade80 55%,#22c55e 100%);color:#052e16;box-shadow:0 4px 14px rgba(34,197,94,.28)}',
        '.lsm-star-btn-glyph{display:inline-block;font-size:14px;line-height:1;transition:transform .22s ease}',
        '.lsm-star-btn:hover .lsm-star-btn-glyph{transform:rotate(20deg) scale(1.2)}',
        '.lsm-star-btn--pop .lsm-star-btn-glyph{animation:lsm-star-pop .55s ease}',
        '.lsm-settings-sub{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b7280)}',
        '.lsm-settings-card{border:1px solid var(--dsw-alias-border-l1,rgba(120,125,140,.25));border-radius:12px;padding:14px 16px;display:flex;flex-direction:column;gap:10px;background:var(--dsw-alias-fill-quaternary,rgba(120,125,140,.06))}',
        '.lsm-settings-row{display:flex;align-items:center;justify-content:space-between;gap:12px}',
        '.lsm-settings-update{display:flex;flex-direction:column;gap:6px}',
        '.lsm-card-head{display:flex;align-items:center;gap:8px}',
        '.lsm-card-icon{display:inline-flex;align-items:center;justify-content:center;width:22px;height:22px;border-radius:8px;background:rgba(251,191,36,.2);font-size:13px}',
        '.lsm-card-title{font-size:14px;font-weight:700;color:var(--dsw-alias-label-primary,inherit)}',
        '.lsm-card-desc{font-size:12px;line-height:1.6;color:var(--dsw-alias-label-secondary,#6b7280)}',
        '.lsm-setting-row{display:flex;align-items:center;justify-content:space-between;gap:12px;padding:7px 0}',
        '.lsm-setting-row + .lsm-setting-row{border-top:1px dashed rgba(120,125,140,.22)}',
        '.lsm-setting-text{display:flex;flex-direction:column;gap:2px;min-width:0}',
        '.lsm-setting-label{font-size:13px;font-weight:600;color:var(--dsw-alias-label-primary,inherit)}',
        '.lsm-setting-hint{font-size:11px;line-height:1.5;color:var(--dsw-alias-label-secondary,#6b7280)}',
        '.lsm-subgroup{display:flex;flex-direction:column;margin-inline-start:2px;padding-inline-start:12px;border-inline-start:2px solid rgba(251,191,36,.35)}',
        '.lsm-switch{position:relative;flex:none;width:40px;height:22px;padding:0;border:none;border-radius:999px;background:rgba(120,125,140,.32);cursor:pointer;transition:background .2s ease}',
        '.lsm-switch--on{background:linear-gradient(135deg,#fbbf24,#f59e0b)}',
        '.lsm-switch:disabled{opacity:.4;cursor:not-allowed}',
        '.lsm-switch-knob{position:absolute;top:2px;left:2px;width:18px;height:18px;border-radius:50%;background:#fff;box-shadow:0 1px 3px rgba(0,0,0,.25);transition:transform .2s ease}',
        '.lsm-switch--on .lsm-switch-knob{transform:translateX(18px)}',
        '.lsm-select{border:1px solid rgba(251,191,36,.5);background:rgba(251,191,36,.14);border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700;color:#7c2d12;cursor:pointer}',
        '.lsm-select:disabled{opacity:.45;cursor:not-allowed}',
        '.lsm-settings-foot{display:flex;align-items:center;justify-content:space-between;gap:12px;padding-top:2px}',
        '.lsm-reset{border:none;background:none;color:var(--dsw-alias-label-secondary,#6b7280);font-size:12px;cursor:pointer;text-decoration:underline}',
        '.lsm-reset:hover{color:#b45309}',
        '.lsm-btn{border:none;border-radius:999px;padding:6px 14px;font-size:13px;font-weight:700;color:#5b3400;background:linear-gradient(135deg,#fbbf24,#f59e0b);cursor:pointer;transition:transform .12s ease,filter .2s ease}',
        '.lsm-btn:hover:not(:disabled){transform:scale(1.04);filter:brightness(1.05)}',
        '.lsm-btn:disabled{opacity:.6;cursor:progress}',
        '.lsm-update-ok{color:#15803d;font-size:13px;font-weight:600}',
        '.lsm-update-new{color:#b45309;font-size:13px;font-weight:700}',
        '.lsm-update-error{color:#dc2626;font-size:12px;font-weight:600}',
        '.lsm-update-muted{color:var(--dsw-alias-label-secondary,#6b7280);font-size:13px}',
        '.lsm-cmd{display:flex;align-items:center;gap:8px;background:rgba(120,125,140,.12);border-radius:8px;padding:8px 10px;font-size:12px;word-break:break-all}',
        '.lsm-cmd code{flex:1;font-family:ui-monospace,SFMono-Regular,Consolas,monospace}',
        '.lsm-copy{border:none;border-radius:999px;padding:3px 10px;font-size:12px;font-weight:700;color:#5b3400;background:rgba(251,191,36,.5);cursor:pointer}',
        '.lsm-link{font-size:12px;color:#2563eb;text-decoration:none}',
        '.lsm-link:hover{text-decoration:underline}',
        '@keyframes lsm-pulse{0%,100%{transform:scale(1)}50%{transform:scale(1.14)}}',
        '@keyframes lsm-pop{0%{transform:scale(.6)}60%{transform:scale(1.25)}100%{transform:scale(1)}}',
        '@keyframes lsm-shake{0%,100%{transform:translateX(0)}25%{transform:translateX(-2px)}75%{transform:translateX(2px)}}',
        '@keyframes lsm-shimmer{0%{background-position:0% 50%}100%{background-position:200% 50%}}',
        '@keyframes lsm-sheen{0%,62%{left:-80%}100%{left:140%}}',
        '@keyframes lsm-star-pop{0%{transform:scale(.7) rotate(-25deg)}55%{transform:scale(1.45) rotate(20deg)}100%{transform:scale(1) rotate(0deg)}}',
        // 手机窄屏：名字 + ⚡ + 结果 + 能力药丸一行放不下会顶出菜单(屏幕)外。
        // 给每个模型 label（[data-model-id] 那个 span）开原生横向滚动，
        // 手指左右拖就能把外面的内容拖回来，隐藏滚动条、带触控惯性。
        // inline-block 保持它在 flex 行里的位置，不破坏菜单布局。
        // 只作用于带 [data-lsm-hscroll] 的元素（仅手机端打标，桌面端零影响）。
        '[data-lsm-hscroll]{overflow-x:auto!important;overflow-y:hidden!important;white-space:nowrap!important;display:inline-block!important;vertical-align:middle!important;max-width:100%!important;-webkit-overflow-scrolling:touch;overscroll-behavior-x:contain;scrollbar-width:none;touch-action:pan-x pan-y;text-overflow:clip!important;-webkit-user-select:none;user-select:none}',
        '[data-lsm-hscroll]::-webkit-scrollbar{display:none;height:0;width:0}',
        '@media (prefers-reduced-motion:reduce){.lsm-bolt--run,.lsm-bolt--done,.lsm-bolt--fail,.lsm-pill--run,.lsm-group--busy,.lsm-seg-btn--busy,.lsm-star-btn::after,.lsm-star-btn--pop .lsm-star-btn-glyph{animation:none}}',
      ].join('\n')
      document.head.appendChild(style)
    }

    // ---------- 手机网页端：分组测速面板（由模型菜单里的「⚡ 测速」打开） ----------
    // App 的聊天页跑的是网页，不画 dshGo 原生的胶囊/状态条/面板，
    // 所以菜单分组标题里放一个「⚡ 测速」入口，点开这个纯 DOM 面板。
    let floatingPanel = null
    let panelGroups = null

    function closeFloatingPanel() {
      if (floatingPanel) { floatingPanel.remove(); floatingPanel = null }
    }

    function renderFloatingPanel() {
      if (!floatingPanel) return
      const body = floatingPanel.querySelector('[data-lsm-panel-body]')
      if (!body) return
      body.textContent = ''
      if (!panelGroups || panelGroups.length === 0) {
        const loading = document.createElement('div')
        loading.textContent = '读取模型列表…'
        loading.style.cssText = 'padding:12px;opacity:.7;'
        body.appendChild(loading)
        return
      }
      for (const g of panelGroups) {
        const section = document.createElement('div')
        section.style.cssText = 'padding:8px 10px;border-bottom:1px solid rgba(128,128,128,.18);'
        const head = document.createElement('div')
        head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:8px;margin-bottom:6px;'
        const name = document.createElement('span')
        name.textContent = `${g.name} · ${g.models.length} 个`
        name.style.cssText = 'font-weight:600;font-size:12px;'
        const testAll = document.createElement('button')
        testAll.type = 'button'
        testAll.textContent = '⚡ 测全部'
        testAll.style.cssText = 'flex:none;border:1px solid rgba(251,191,36,.6);background:rgba(251,191,36,.18);color:inherit;border-radius:999px;padding:2px 10px;font-size:11px;font-weight:700;cursor:pointer;'
        testAll.addEventListener('click', (e) => {
          e.preventDefault(); e.stopPropagation()
          runGroup(g.provider)
          testAll.textContent = '测速中…'
        })
        head.append(name, testAll)
        section.appendChild(head)
        for (const m of g.models) {
          const row = document.createElement('div')
          row.style.cssText = 'display:flex;align-items:center;justify-content:space-between;gap:6px;padding:3px 2px 3px 8px;cursor:pointer;'
          const left = document.createElement('span')
          left.style.cssText = 'display:flex;align-items:center;gap:0;min-width:0;flex:1;'
          const mname = document.createElement('span')
          mname.textContent = m.name
          mname.style.cssText = 'overflow:hidden;text-overflow:ellipsis;white-space:nowrap;'
          // 能力药丸：与桌面端 .lsm-meta 完全同一套（视觉/文本 + 上下文长度）
          const cap = document.createElement('span')
          cap.className = 'lsm-meta'
          cap.setAttribute('data-lsm-cap', `${g.provider}|${m.id}`)
          cap.style.display = 'none'
          left.append(mname, cap)
          const state = document.createElement('span')
          state.setAttribute('data-lsm-state', `${g.provider}|${m.id}`)
          state.style.cssText = 'flex:none;font-size:11px;opacity:.85;'
          row.append(left, state)
          row.addEventListener('mousedown', (e) => { e.preventDefault(); e.stopPropagation() })
          row.addEventListener('click', (e) => { e.preventDefault(); e.stopPropagation(); runTest(g.provider, m.id) })
          section.appendChild(row)
        }
        body.appendChild(section)
      }
      syncFloatingPanel()
    }

    /** 面板里的能力药丸：与桌面端同一套 describeCapability（👁️ 视觉 · 200K）。 */
    function syncPanelCaps() {
      if (!floatingPanel) return
      if (!settings.meta) {
        for (const el of floatingPanel.querySelectorAll('[data-lsm-cap]')) el.style.display = 'none'
        return
      }
      for (const el of floatingPanel.querySelectorAll('[data-lsm-cap]')) {
        const [providerId, modelId] = (el.getAttribute('data-lsm-cap') || '').split('|')
        if (!providerId || !modelId) continue
        const cached = readMeta(providerId, modelId)
        if (!cached) {
          el.style.display = 'none'
          requestMeta(providerId, modelId)   // 批量拉取，回来后 emitChange 再刷
          continue
        }
        const cap = describeCapability(cached)
        if (!cap) { el.style.display = 'none'; continue }
        if (el.textContent !== cap.text) el.textContent = cap.text
        el.title = cap.title
        el.style.display = ''
      }
    }

    function syncFloatingPanel() {
      if (!floatingPanel) return
      syncPanelCaps()
      for (const el of floatingPanel.querySelectorAll('[data-lsm-state]')) {
        const [providerId, modelId] = (el.getAttribute('data-lsm-state') || '').split('|')
        if (!providerId || !modelId) continue
        const entry = readEntry(providerId, modelId)
        const key = keyOf(providerId, modelId)
        const running = inFlight.has(key) || Boolean(entry && entry.running)
        el.removeAttribute('title')
        if (running) { el.textContent = '测速中…'; el.style.color = '#d97706'; continue }
        if (entry && entry.error) {
          const { short } = explainBenchError(entry.error)
          el.textContent = `✗ ${short}`
          el.style.color = '#dc2626'
          el.title = benchErrorTitle(entry.error)
          continue
        }
        if (entry && Number.isFinite(entry.firstMs)) {
          const shown = Number(entry.contentFirstMs) > 0 ? entry.contentFirstMs : entry.firstMs
          el.textContent = `${fmtMs(shown)} · ${fmtTps(entry.tps)}`
          el.style.color = isStale(entry) ? '#6b7280' : '#15803d'
          continue
        }
        el.textContent = '未测'
        el.style.color = ''
      }
    }

    async function openFloatingPanel() {
      if (floatingPanel) { closeFloatingPanel(); return }
      const panel = document.createElement('div')
      panel.setAttribute('data-speedtest-floating-panel', '')
      panel.setAttribute('role', 'dialog')
      panel.setAttribute('aria-label', '模型测速')
      panel.style.cssText = [
        'position:fixed', 'z-index:2147483100', 'bottom:76px', 'right:12px',
        'width:min(340px, calc(100vw - 24px))', 'max-height:min(64vh, 520px)',
        'display:flex', 'flex-direction:column', 'overflow:hidden',
        'border-radius:14px', 'padding:0',
        'background:var(--dsw-alias-bg-module-platform, #ffffff)',
        'color:var(--dsw-alias-label-primary, #1f2329)',
        'border:1px solid var(--dsw-alias-border-l1, rgba(0,0,0,.12))',
        'box-shadow:var(--dsw-elevation-prominent, 0 12px 40px rgba(0,0,0,.22))',
        'font-size:12px', 'line-height:18px', 'text-align:left',
      ].join(';')
      const head = document.createElement('div')
      head.style.cssText = 'display:flex;align-items:center;justify-content:space-between;padding:10px 12px;border-bottom:1px solid rgba(128,128,128,.18);flex:none;'
      const title = document.createElement('span')
      title.textContent = '⚡ 模型测速'
      title.style.cssText = 'font-weight:700;font-size:13px;'
      const close = document.createElement('button')
      close.type = 'button'; close.textContent = '×'
      close.style.cssText = 'border:0;background:transparent;color:inherit;font-size:18px;cursor:pointer;opacity:.6;padding:0 4px;'
      close.addEventListener('click', closeFloatingPanel)
      head.append(title, close)
      const body = document.createElement('div')
      body.setAttribute('data-lsm-panel-body', '')
      body.style.cssText = 'overflow:auto;flex:1;'
      const foot = document.createElement('div')
      foot.style.cssText = 'flex:none;padding:8px 12px;border-top:1px solid rgba(128,128,128,.18);font-size:10px;opacity:.6;'
      foot.textContent = '点模型测单个 · 点「测全部」测整组 · 会消耗渠道额度'
      panel.append(head, body, foot)
      document.body.appendChild(panel)
      floatingPanel = panel
      renderFloatingPanel()
      try {
        const c = await fetchCatalog()
        panelGroups = Object.values(c)
        renderFloatingPanel()
      } catch {
        const b = panel.querySelector('[data-lsm-panel-body]')
        if (b) b.textContent = '读取模型列表失败'
      }
    }

    const VERSION_KEY = 'dsh-model-speedtest:lastVersion'
    const STARRED_KEY = 'dsh-model-speedtest:starred:v1'
    function readCachedVersion() {
      try { return window.localStorage.getItem(VERSION_KEY) || '' } catch { return '' }
    }
    function cacheVersion(version) {
      if (!version) return
      try { window.localStorage.setItem(VERSION_KEY, String(version)) } catch {}
    }
    function readStarred() {
      try { return window.localStorage.getItem(STARRED_KEY) === '1' } catch { return false }
    }
    function markStarredStorage() {
      try { window.localStorage.setItem(STARRED_KEY, '1') } catch {}
    }
    function readUsageStats() {
      let tested = 0
      let caught = 0
      try {
        for (const entry of Object.values(store)) {
          if (!entry || typeof entry !== 'object') continue
          if (entry.error) caught += 1
          else if (Number.isFinite(entry.firstMs)) tested += 1
        }
      } catch {}
      return { tested, caught }
    }
    /** 页面加载后顺手取一次版本并记下来，下次打开设置就能立刻显示。 */
    function warmVersion() {
      if (readCachedVersion()) return
      fetch(UPDATE_PATH, { credentials: 'same-origin' })
        .then((res) => (res.ok ? res.json() : null))
        .then((body) => { if (body && body.current) cacheVersion(body.current) })
        .catch(() => {})
    }

    /** 设置变化时让控制面板重新渲染。 */
    function useSettings() {
      const [, force] = react.useState(0)
      react.useEffect(() => subscribeSettings(() => force((n) => n + 1)), [])
      return settings
    }

    function SettingSwitch({ label, hint, checked, disabled, onChange }) {
      return react.createElement('div', { className: 'lsm-setting-row' }, [
        react.createElement('div', { key: 'text', className: 'lsm-setting-text' }, [
          react.createElement('div', { key: 'label', className: 'lsm-setting-label' }, label),
          hint ? react.createElement('div', { key: 'hint', className: 'lsm-setting-hint' }, hint) : null,
        ]),
        react.createElement('button', {
          key: 'switch',
          type: 'button',
          role: 'switch',
          'aria-checked': checked ? 'true' : 'false',
          'aria-label': label,
          className: `lsm-switch${checked ? ' lsm-switch--on' : ''}`,
          disabled: Boolean(disabled),
          onClick: () => { if (!disabled) onChange(!checked) },
        }, react.createElement('span', { className: 'lsm-switch-knob' })),
      ])
    }

    function SettingsCard({ icon, title, desc, children }) {
      return react.createElement('div', { className: 'lsm-settings-card' }, [
        react.createElement('div', { key: 'head', className: 'lsm-card-head' }, [
          react.createElement('span', { key: 'icon', className: 'lsm-card-icon' }, icon),
          react.createElement('span', { key: 'title', className: 'lsm-card-title' }, title),
        ]),
        desc ? react.createElement('div', { key: 'desc', className: 'lsm-card-desc' }, desc) : null,
        ...(children || []),
      ])
    }

    /** 设置页：每个功能一张控制面板，开关即时生效。 */
    function SettingsSection() {
      const s = useSettings()
      const [state, setState] = react.useState({ status: 'loading', body: null })
      const [copied, setCopied] = react.useState(false)
      const [cachedVersion, setCachedVersion] = react.useState(readCachedVersion)
      const [starred, setStarred] = react.useState(readStarred)
      const [justStarred, setJustStarred] = react.useState(false)
      const [, forceStats] = react.useState(0)
      const starTimerRef = react.useRef(null)

      react.useEffect(() => subscribe(() => forceStats((n) => n + 1)), [])
      react.useEffect(() => () => {
        if (starTimerRef.current) clearTimeout(starTimerRef.current)
      }, [])

      const check = react.useCallback((force) => {
        setState({ status: 'loading', body: null })
        fetch(`${UPDATE_PATH}${force ? '?force=1' : ''}`, { credentials: 'same-origin' })
          .then((res) => (res.ok ? res.json() : Promise.reject(new Error(`HTTP ${res.status}`))))
          .then((body) => {
            if (body && body.current) {
              cacheVersion(body.current)
              setCachedVersion(body.current)
            }
            setState({ status: body && body.error ? 'error' : 'done', body })
          })
          .catch((error) => setState({ status: 'error', body: { error: String((error && error.message) || error || '网络错误') } }))
      }, [])

      react.useEffect(() => { check(false) }, [check])

      const body = state.body || {}
      const dir = String(body.dir || '')
      const command = dir ? `git -C "${dir}" pull` : 'git pull'
      const copy = () => {
        try {
          Promise.resolve(navigator.clipboard.writeText(command)).then(() => {
            setCopied(true)
            setTimeout(() => setCopied(false), 1600)
          }).catch(() => {})
        } catch {}
      }

      let status = null
      if (state.status === 'loading') {
        status = react.createElement('span', { className: 'lsm-update-muted' }, '检查中…')
      } else if (state.status === 'error' || body.error) {
        status = react.createElement('span', { className: 'lsm-update-error' }, `检查失败：${body.error || '网络错误'}`)
      } else if (body.updateAvailable) {
        status = react.createElement('span', { className: 'lsm-update-new' }, `发现新版本 v${body.latest}`)
      } else {
        status = react.createElement('span', { className: 'lsm-update-ok' }, '已是最新版本')
      }

      const speedOff = !s.speedTest
      const repoUrl = body.url || 'https://github.com/atattier/local-model-speedtest'
      const stars = typeof body.stars === 'number' && Number.isFinite(body.stars) ? body.stars : null
      const stats = readUsageStats()
      const onStarClick = () => {
        markStarredStorage()
        setStarred(true)
        setJustStarred(true)
        if (starTimerRef.current) clearTimeout(starTimerRef.current)
        starTimerRef.current = setTimeout(() => {
          starTimerRef.current = null
          setJustStarred(false)
        }, 4000)
      }

      const headerStarText = justStarred
        ? '谢谢你的星星！'
        : starred
          ? (stars !== null && stars > 0 ? `已支持 · ${stars}` : '已支持')
          : stars === 0
            ? '抢第 1 颗 Star'
            : (stars !== null && stars > 0 ? `点个 Star · ${stars}` : '点个 Star')

      const starTitle = justStarred
        ? '收到你的心意啦，谢谢你！'
        : starred
          ? '谢谢你的支持 ⭐'
          : '用得顺手？给它点颗 ⭐ 吧'

      const starTag = stars === 0
        ? '✨ 抢第 1 颗星'
        : stars !== null && stars > 0 && stars < 10
          ? `★ ${stars} · 冲刺 10 颗星`
          : stars !== null && stars >= 10
            ? `★ ${stars} Stars`
            : 'GitHub 开源免费'

      const starDesc = justStarred
        ? 'GitHub 页面已打开，如果顺手点了右上的 Star，作者今天写代码都会笑醒 ✨'
        : stats.tested > 0 && stats.caught > 0
          ? `它已经帮你实测过 ${stats.tested} 个模型、提前避坑 ${stats.caught} 个不可用模型。如果帮你省下了试错时间，去点颗星鼓励一下作者吧～`
          : stats.tested > 0
            ? `它已经帮你实测过 ${stats.tested} 个模型。用得顺手的话，去 GitHub 点颗小星星就是对作者最大的鼓励～`
            : '测速、能力标签、报错大白话……全是作者自己用得难受才一点点打磨的。如果它也让你用 DSH 更顺手，来点颗星支持一下吧～'

      const starBtnText = justStarred
        ? '谢谢你！已打开 GitHub'
        : starred
          ? '已支持 · 再去看看'
          : stars === 0
            ? '点亮第 1 颗 Star'
            : '去 GitHub 点个 Star'

      return react.createElement('div', { className: 'lsm-settings' }, [
        react.createElement('div', { key: 'head', className: 'lsm-settings-head' }, [
          react.createElement('div', { key: 'left', className: 'lsm-settings-head-left' }, [
            react.createElement('span', { key: 'title', className: 'lsm-settings-title' }, '更好的用户体验'),
            react.createElement('span', { key: 'ver', className: 'lsm-ver' }, `v${body.current || cachedVersion || '—'}`),
          ]),
          react.createElement('a', {
            key: 'star-pill',
            className: 'lsm-star-pill',
            href: repoUrl,
            target: '_blank',
            rel: 'noreferrer',
            'data-speedtest-star-pill': '',
            title: '去 GitHub 给插件点颗 ⭐',
            onClick: onStarClick,
          }, [
            react.createElement('span', { key: 'i', className: 'lsm-star-pill-icon' }, justStarred ? '✨' : '★'),
            react.createElement('span', { key: 't' }, headerStarText),
          ]),
        ]),
        react.createElement('div', { key: 'sub', className: 'lsm-settings-sub' }, '每个功能一张卡片，开关即时生效，设置自动保存在本机。'),

        // 卡片一：模型测速 + 能力标签（同一个区域）
        react.createElement(SettingsCard, {
          key: 'speed',
          icon: '⚡',
          title: '模型测速与能力标签',
          desc: '测首字延迟和每秒 token 数，并在模型名右侧标出视觉/文本与上下文长度。',
        }, [
          react.createElement(SettingSwitch, {
            key: 'master',
            label: '启用模型测速',
            hint: '关掉后模型列表恢复原样，不再显示 ⚡ 和测速结果',
            checked: s.speedTest,
            onChange: (value) => setSetting('speedTest', value),
          }),
          react.createElement('div', { key: 'sub', className: 'lsm-subgroup' }, [
            react.createElement(SettingSwitch, {
              key: 'group',
              label: '分组测试（测本组）',
              hint: '分组标题右侧显示按钮，一次测完同渠道全部模型',
              checked: s.groupTest,
              disabled: speedOff,
              onChange: (value) => setSetting('groupTest', value),
            }),
            react.createElement(SettingSwitch, {
              key: 'segment',
              label: '大分组分段测试',
              hint: '模型多的分组每段一条「测 N–M」，不用等整组',
              checked: s.segmentTest,
              disabled: speedOff,
              onChange: (value) => setSetting('segmentTest', value),
            }),
            react.createElement('div', { key: 'size', className: 'lsm-setting-row' }, [
              react.createElement('div', { key: 'text', className: 'lsm-setting-text' }, [
                react.createElement('div', { key: 'label', className: 'lsm-setting-label' }, '每段模型数'),
                react.createElement('div', { key: 'hint', className: 'lsm-setting-hint' }, '分段按钮按这个数量切分'),
              ]),
              react.createElement('select', {
                key: 'select',
                className: 'lsm-select',
                value: String(s.segmentSize),
                disabled: speedOff || !s.segmentTest,
                onChange: (event) => setSetting('segmentSize', Number(event.target.value)),
              }, [10, 20, 50].map((size) => react.createElement('option', { key: size, value: String(size) }, `${size} 个`))),
            ]),
          ]),
          react.createElement(SettingSwitch, {
            key: 'meta',
            label: '显示视觉/文本与上下文',
            hint: '例如「👁️ 视觉 · 1M」，鼠标悬停可看完整说明；和上面的总开关互不影响',
            checked: s.meta,
            onChange: (value) => setSetting('meta', value),
          }),
        ]),

        // 卡片二：报错大白话解释
        react.createElement(SettingsCard, {
          key: 'explain',
          icon: '💬',
          title: '报错大白话解释',
          desc: isDesktopClient
            ? '对话报错时，让模型把原始错误翻译成「原因 + 你可以怎么做」。'
            : '仅 DSH 桌面端可用；网页版和手机端不加载这个按钮。',
        }, [
          isDesktopClient
            ? react.createElement(SettingSwitch, {
              key: 'switch',
              label: '显示「大白话解释」按钮',
              hint: '关掉后对话里的报错不再出现这个按钮',
              checked: s.explain,
              onChange: (value) => setSetting('explain', value),
            })
            : react.createElement('div', { key: 'desktop', className: 'lsm-setting-hint' }, '当前环境不支持'),
        ]),

        // 卡片三：检查更新
        react.createElement(SettingsCard, {
          key: 'update',
          icon: '🔄',
          title: '检查更新',
          desc: '比对 GitHub 仓库里的 package.json；没网时会提示失败。',
        }, [
          react.createElement('div', { key: 'row', className: 'lsm-settings-row' }, [
            status,
            react.createElement('button', {
              key: 'btn',
              type: 'button',
              className: 'lsm-btn',
              disabled: state.status === 'loading',
              onClick: () => check(true),
            }, state.status === 'loading' ? '检查中…' : '检查更新'),
          ]),
          body.updateAvailable
            ? react.createElement('div', { key: 'new', className: 'lsm-settings-update' }, [
              react.createElement('div', { key: 'ver', className: 'lsm-settings-sub' }, `当前 v${body.current}，最新 v${body.latest}`),
              react.createElement('div', { key: 'hint', className: 'lsm-settings-sub' }, '在插件目录执行下面命令，然后重启 DSH：'),
              react.createElement('div', { key: 'cmd', className: 'lsm-cmd' }, [
                react.createElement('code', { key: 'code' }, command),
                react.createElement('button', { key: 'copy', type: 'button', className: 'lsm-copy', onClick: copy }, copied ? '已复制' : '复制'),
              ]),
            ])
            : null,
        ]),

        // 卡片四：求 Star 支持作者
        react.createElement('div', { key: 'star', className: 'lsm-star-card', 'data-speedtest-star-card': '' }, [
          react.createElement('div', { key: 'row', className: 'lsm-star-row' }, [
            react.createElement('div', { key: 'info', className: 'lsm-star-info' }, [
              react.createElement('div', { key: 'top', className: 'lsm-star-top' }, [
                react.createElement('span', { key: 'icon', className: 'lsm-card-icon' }, '⭐'),
                react.createElement('span', { key: 'title', className: 'lsm-card-title' }, starTitle),
                react.createElement('span', { key: 'tag', className: 'lsm-star-tag' }, starTag),
              ]),
              react.createElement('div', { key: 'desc', className: 'lsm-card-desc' }, starDesc),
            ]),
            react.createElement('a', {
              key: 'btn',
              className: `lsm-star-btn${justStarred ? ' lsm-star-btn--done lsm-star-btn--pop' : ''}`,
              href: repoUrl,
              target: '_blank',
              rel: 'noreferrer',
              'data-speedtest-star-btn': '',
              onClick: onStarClick,
            }, [
              react.createElement('span', { key: 'glyph', className: 'lsm-star-btn-glyph' }, justStarred ? '✨' : '★'),
              react.createElement('span', { key: 'label' }, starBtnText),
            ]),
          ]),
        ]),

        react.createElement('div', { key: 'foot', className: 'lsm-settings-foot' }, [
          react.createElement('a', {
            key: 'issues',
            className: 'lsm-link',
            href: `${repoUrl.replace(/\/$/, '')}/issues`,
            target: '_blank',
            rel: 'noreferrer',
          }, '提建议 / 反馈问题'),
          react.createElement('button', {
            key: 'reset',
            type: 'button',
            className: 'lsm-reset',
            onClick: () => resetSettings(),
          }, '恢复默认设置'),
        ]),
      ])
    }

    function apply(ctx) {
      injectStyles()
      installGroupButtons()
      installErrorExplainer()
      warmVersion()
      ctx.inject(['slots'], (scope) => {
        scope.slots.inject('conversation.input.model.label', () => scope.slots.register({
          name: 'conversation.input.model.label',
        }, SpeedTestLabel))
        scope.slots.inject('settings.section', () => scope.slots.register({
          name: 'settings.section',
          id: 'local-model-speedtest',
          order: 60,
          label: () => '更好的用户体验',
        }, SettingsSection))
      })
    }

    exports.apply = apply
    exports.name = 'local-model-speedtest'
    exports.SpeedTestLabel = SpeedTestLabel
    return module.exports
  },
})
