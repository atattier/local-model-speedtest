// 模型测速插件 —— 浏览器半身（桌面版 / 网页版 / dsh-go 网页界面）
// 模型名旁 ⚡ 测单个；模型行里再给一个「测本组」：一次测完同分组全部模型。
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
    const TIMEOUT_MS = 65000

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
    function emitChange() { for (const fn of listeners) { try { fn() } catch {} } }
    function subscribe(fn) { listeners.add(fn); return () => listeners.delete(fn) }
    function readEntry(providerId, modelId) { return store[keyOf(providerId, modelId)] }

    // 正在测的模型 key（单个 + 分组共用，避免重复点击）
    const inFlight = new Set()
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
        return { firstMs: body.firstMs, tps: body.tps, tokens: body.tokens, at: Date.now() }
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
      let group
      try {
        const c = await fetchCatalog()
        group = c[providerId]
      } catch (error) {
        return
      }
      if (!group || !group.models || group.models.length === 0) return
      inFlight.add(groupKey)
      emitChange()
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
      const compact = placement === 'trigger'

      const label = failed
        ? '✗'
        : running || groupRunning
          ? '⚡'
          : done
            ? `${fmtMs(entry.firstMs)} · ${fmtTps(entry.tps)}`
            : null

      const title = failed
        ? `测速失败：${entry.error}`
        : running
          ? '测速中…'
          : done
            ? `首字 ${fmtMs(entry.firstMs)} · ${fmtTps(entry.tps)}（${entry.tokens || 0} tokens）· 点 ⚡ 重测`
            : '点 ⚡ 测这个模型；点「测本组」一次测完同渠道全部'

      const onBolt = (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (running || groupRunning) return
        runTest(providerId, modelId)
      }

      const onGroup = (event) => {
        event.preventDefault()
        event.stopPropagation()
        if (groupRunning) return
        runGroup(providerId)
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
          marginInlineStart: compact ? '4px' : '6px', padding: '0 2px',
          cursor: running ? 'progress' : 'pointer',
          opacity: running ? 0.45 : 1, fontSize: '0.95em', lineHeight: 1,
          userSelect: 'none', verticalAlign: 'middle',
        },
        children: '⚡',
      })

      // 分组按钮只在菜单 / 选项里出现，触发器上不挤
      const groupBtn = compact ? null : react.createElement('span', {
        key: 'group',
        role: 'button',
        tabIndex: 0,
        title: '一次测完这个分组的全部模型',
        'aria-label': '测本组',
        onMouseDown: (event) => { event.preventDefault(); event.stopPropagation() },
        onClick: onGroup,
        onKeyDown: (event) => { if (event.key === 'Enter' || event.key === ' ') onGroup(event) },
        style: {
          display: 'inline-flex', marginInlineStart: '6px', padding: '0 4px',
          cursor: groupRunning ? 'progress' : 'pointer',
          fontSize: '0.8em', lineHeight: 1.4, whiteSpace: 'nowrap',
          border: '1px solid currentColor', borderRadius: '4px',
          opacity: groupRunning ? 0.5 : 0.75, verticalAlign: 'middle',
        },
        children: groupRunning ? '测本组…' : '测本组',
      })

      const speed = label === null || label === '⚡'
        ? null
        : react.createElement('span', {
          key: 'speed',
          title,
          style: {
            marginInlineStart: '4px', fontSize: '0.86em',
            opacity: failed ? 0.75 : 0.9, whiteSpace: 'nowrap',
            color: failed ? '#e05561' : 'inherit', verticalAlign: 'middle',
          },
          children: label,
        })

      return react.createElement('span', {
        style: { display: 'inline-flex', alignItems: 'center', whiteSpace: 'nowrap' },
      }, [
        react.createElement('span', { key: 'name', style: { display: 'inline' }, children: (model && model.name) || modelId }),
        bolt,
        groupBtn,
        speed,
      ])
    }

    function apply(ctx) {
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
