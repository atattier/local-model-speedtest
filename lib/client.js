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
    const STORE_KEY = 'dsh-model-speedtest:v1'
    const EXPLAIN_MODEL_KEY = 'dsh-model-speedtest:explain-model:v1'
    const TIMEOUT_MS = 95000
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

    function loadStore() {
      try {
        const raw = window.localStorage.getItem(STORE_KEY)
        const obj = raw ? JSON.parse(raw) : {}
        return obj && typeof obj === 'object' ? obj : {}
      } catch { return {} }
    }
    let store = loadStore()
    function saveStore() {
      try { window.localStorage.setItem(STORE_KEY, JSON.stringify(store)) } catch {}
    }
    function keyOf(providerId, modelId) { return `${providerId}|${modelId}` }

    const listeners = new Set()
    function emitChange() {
      for (const fn of listeners) { try { fn() } catch {} }
      syncGroupButtons()
    }
    function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }
    function readEntry(providerId, modelId) { return store[keyOf(providerId, modelId)] }

    // 正在测的模型 key（单个 + 分组共用，避免重复点击）
    const inFlight = new Set()
    // 分组标题右侧的「测本组」按钮（DOM 注入；React 菜单没有分组标题 slot）
    const groupButtons = new Set()
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
      return `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} t/s`
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

      panel.append(head, modelRow, body, foot)
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
      store[key] = { ...(prev || {}), running: true, error: undefined }
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

    /** 一次测完同分组全部模型，串行逐个测，结果实时显示。 */
    async function runGroup(providerId) {
      const groupKey = `group:${providerId}`
      if (inFlight.has(groupKey)) return
      inFlight.add(groupKey)
      emitChange()
      let group
      try {
        const c = await fetchCatalog()
        group = c[providerId]
      } catch (error) {
        inFlight.delete(groupKey)
        emitChange()
        return
      }
      if (!group || !group.models || group.models.length === 0) {
        inFlight.delete(groupKey)
        emitChange()
        return
      }
      // 并发 2，逐个写入结果
      let cursor = 0
      const worker = async () => {
        while (cursor < group.models.length) {
          const m = group.models[cursor++]
          const key = keyOf(providerId, m.id)
          inFlight.add(key)
          store[key] = { running: true }
          emitChange()
          try {
            const r = await bench(providerId, m.id)
            store[key] = { ...r, running: false }
          } catch (error) {
            const message = String((error && error.message) || error || '失败')
            store[key] = { running: false, error: message === 'The user aborted a request.' ? '超时' : message, at: Date.now() }
          } finally {
            inFlight.delete(key)
            saveStore()
            emitChange()
          }
        }
      }
      try {
        await Promise.all([worker(), worker()])
      } finally {
        inFlight.delete(groupKey)
        emitChange()
      }
    }

    function updateGroupButton(item) {
      const running = inFlight.has(`group:${item.providerId}`)
      const text = running ? '测本组…' : '测本组'
      if (item.el.textContent !== text) item.el.textContent = text
      item.el.title = running ? '正在测试这个分组的全部模型' : '一次测完这个分组的全部模型'
      item.el.setAttribute('aria-busy', running ? 'true' : 'false')
      item.el.style.cursor = running ? 'progress' : 'pointer'
      item.el.style.opacity = running ? '0.5' : '0.82'
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
      el.style.cssText = [
        'display:inline-flex', 'align-items:center', 'justify-content:center',
        'flex:none', 'margin-inline-start:8px', 'padding:1px 6px',
        'font-size:10px', 'line-height:14px', 'font-weight:500',
        'border:1px solid currentColor', 'border-radius:5px',
        'cursor:pointer', 'user-select:none', 'white-space:nowrap',
        'color:var(--dsw-alias-label-secondary, currentColor)',
        'opacity:0.82',
      ].join(';')
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

    function injectGroupButtons() {
      if (!document.body) return
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
      }
      syncGroupButtons()
    }

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
      let scheduled = false
      groupObserver = new MutationObserver(() => {
        if (scheduled) return
        scheduled = true
        Promise.resolve().then(() => {
          scheduled = false
          injectGroupButtons()
        })
      })
      groupObserver.observe(document.body, { childList: true, subtree: true })
      injectGroupButtons()
      window.__dshModelSpeedtestGroupUi = {
        dispose() {
          if (groupObserver) { groupObserver.disconnect(); groupObserver = null }
          for (const item of groupButtons) item.el.remove()
          groupButtons.clear()
        },
      }
    }

    function SpeedTestLabel({ provider, model, placement }) {
      const [, force] = react.useState(0)
      react.useEffect(() => subscribe(() => force((n) => n + 1)), [])

      const providerId = provider && provider.id
      const modelId = model && model.id
      if (!providerId || !modelId) return null

      const entry = readEntry(providerId, modelId)
      const running = inFlight.has(keyOf(providerId, modelId)) || Boolean(entry && entry.running)
      const groupRunning = inFlight.has(`group:${providerId}`)
      const failed = entry && entry.error
      const done = entry && !entry.error && Number.isFinite(entry.firstMs)
      const stale = done && isStale(entry)
      const compact = placement === 'trigger'
      // 思考模型优先展示正文首字——那才是用户真正看到字的时间。
      const shownFirst = done && Number(entry.contentFirstMs) > 0 ? entry.contentFirstMs : done ? entry.firstMs : 0

      const label = failed
        ? '✗'
        : running || groupRunning
          ? '⚡'
          : done
            ? `${fmtMs(shownFirst)} · ${fmtTps(entry.tps)}${stale ? ' ·旧' : ''}`
            : null

      const title = failed
        ? `测速失败：${entry.error}`
        : running
          ? '测速中…'
          : done
            ? `首字 ${fmtMs(shownFirst)}${fmtReasoning(entry)} · ${fmtTps(entry.tps)}（${entry.tokens || 0} tokens）${
              stale ? ` · 测于 ${fmtAge(entry.at)}，建议重测` : ''
            } · 点 ⚡ 重测`
            : '点 ⚡ 测这个模型；分组标题右侧的「测本组」可一次测完同渠道全部'

      const onBolt = (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (running || groupRunning) return
        runTest(providerId, modelId)
      }

      const bolt = react.createElement('span', {
        key: 'bolt',
        role: 'button',
        tabIndex: 0,
        title,
        'aria-label': title,
        'aria-busy': running ? 'true' : undefined,
        onMouseDown: (event) => { event.preventDefault(); event.stopPropagation() },
        onClick: onBolt,
        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') onBolt(event) },
        style: {
          display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
          marginInlineStart: compact ? '6px' : '12px', padding: '0 2px',
          cursor: running ? 'progress' : 'pointer',
          opacity: running ? 0.45 : 1, fontSize: '0.95em', lineHeight: 1,
          userSelect: 'none', verticalAlign: 'middle',
        },
        children: '⚡',
      })

      const speed = label === null || label === '⚡'
        ? null
        : react.createElement('span', {
          key: 'speed',
          title,
          style: {
            marginInlineStart: '4px', fontSize: '0.86em',
            opacity: failed ? 0.75 : stale ? 0.45 : 0.9, whiteSpace: 'nowrap',
            color: failed ? '#e05561' : 'inherit', verticalAlign: 'middle',
          },
          children: label,
        })

      return react.createElement('span', {
        style: { display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap' },
      }, [
        react.createElement('span', { key: 'name', style: { display: 'inline' }, children: (model && model.name) || modelId }),
        bolt,
        speed,
      ])
    }

    function apply(ctx) {
      installGroupButtons()
      installErrorExplainer()
      ctx.inject(['slots'], (scope) => {
        scope.slots.inject('conversation.input.model.label', () => scope.slots.register({
          name: 'conversation.input.model.label',
        }, SpeedTestLabel))
      })
    }

    exports.apply = apply
    exports.name = 'local-model-speedtest'
    exports.SpeedTestLabel = SpeedTestLabel
    return module.exports
  },
})
