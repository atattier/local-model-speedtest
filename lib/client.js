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
    const STORE_KEY = 'dsh-model-speedtest:v1'
    const TIMEOUT_MS = 95000
    // 与 host 保持一致：1 小时内的结果算新鲜，更久的只作参考。
    const STALE_MS = 60 * 60 * 1000

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
