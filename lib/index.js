// 模型测速插件 —— host 半身
// 手机端(dsh-go)：面板按 provider 分组；点组名一次测完该组，点模型只测单个
// 桌面端/网页版：lib/client.js 在模型选择器里加 ⚡ 与「测本组」，调用 /catalog、/bench
export const name = 'local-model-speedtest'

import { readFileSync, writeFileSync, mkdirSync } from 'node:fs'
import { join, dirname } from 'node:path'
import { fileURLToPath } from 'node:url'
import { randomUUID } from 'node:crypto'

const __dirname = dirname(fileURLToPath(import.meta.url))
const CACHE_FILE = join(__dirname, '.cache.json')
const MAX_TOKENS = 160
const PROMPT_TAIL = '天空很蓝，风从窗缝里钻进来，桌上那杯茶还在冒热气。请原样输出这句话，不要解释，不要加标点以外的东西。'
const MAX_LIST_ITEMS = 50

function readCache() {
  try {
    const raw = JSON.parse(readFileSync(CACHE_FILE, 'utf8'))
    return raw && typeof raw === 'object' ? raw : {}
  } catch { return {} }
}

function writeCache(obj) {
  try {
    mkdirSync(__dirname, { recursive: true })
    writeFileSync(CACHE_FILE, JSON.stringify(obj, null, 2), 'utf8')
  } catch {}
}

function keyOf(provider, model) {
  return `${provider}\u0000${model}`
}

function fmtMs(ms) {
  if (!Number.isFinite(ms) || ms <= 0) return '—'
  return ms >= 1000 ? `${(ms / 1000).toFixed(2)}s` : `${Math.round(ms)}ms`
}

function fmtTps(tps) {
  if (!Number.isFinite(tps) || tps <= 0) return '—'
  return `${tps >= 100 ? Math.round(tps) : tps.toFixed(1)} t/s`
}

/** 一次真实生成：测首字延迟（首个 token 到达）与生成速度（token/秒）。 */
async function runBench(llm, provider, model, signal) {
  const messages = [{
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: PROMPT_TAIL }],
    source: { kind: 'model-speedtest' },
  }]
  const call = await llm.prepareCall({ provider, model, maxTokens: MAX_TOKENS }, signal)
  const options = { ...call.config, messages, signal, purpose: 'model-speedtest' }
  const t0 = Date.now()
  let first = 0
  let last = 0
  let chunks = 0
  let usage
  let finish
  let text = ''
  for await (const chunk of call.stream(options)) {
    switch (chunk.type) {
      case 'text-delta':
      case 'reasoning-delta': {
        if (chunk.text === '') break
        const t = Date.now()
        if (first === 0) first = t
        last = t
        chunks += 1
        if (chunk.type === 'text-delta') text += chunk.text
        break
      }
      case 'tool-call-delta': {
        const t = Date.now()
        if (first === 0) first = t
        last = t
        chunks += 1
        break
      }
      case 'usage': usage = chunk.usage; break
      case 'finish': finish = chunk.reason; break
      default: break
    }
  }
  const tEnd = Date.now()
  if (finish && finish.kind === 'error') {
    const msg = (finish.failure && (finish.failure.message || finish.failure.code)) || '调用失败'
    throw new Error(String(msg).slice(0, 120))
  }
  if (finish && finish.kind === 'aborted') throw new Error('已取消')
  const tokens = (usage && Number(usage.outputTokens)) || chunks
  const totalMs = tEnd - t0
  const firstMs = first > 0 ? first - t0 : totalMs
  const genMs = first > 0 && last > first ? last - first : totalMs
  const tps = tokens > 0 && genMs > 0 ? (tokens / (genMs / 1000)) : 0
  return { firstMs, tps, tokens, totalMs, text: text.slice(0, 200) }
}

/** 列出所有 provider 的模型（失败则跳过该 provider）。 */
async function collectModels(llm) {
  const out = []
  let providers = []
  try { providers = llm.listProviders() } catch { providers = [] }
  for (const provider of providers) {
    try {
      const models = await llm.listModels(provider.id)
      for (const model of models) out.push({ provider, model })
    } catch {}
  }
  return out
}

/** 把模型按 provider 分组，拼成一个 list 的 items：组名行 + 缩进模型行。 */
function buildGroups(cache, models) {
  const byProvider = new Map()
  for (const { provider, model } of models) {
    if (!byProvider.has(provider.id)) byProvider.set(provider.id, { provider, models: [] })
    byProvider.get(provider.id).models.push(model)
  }
  const items = []
  for (const [pid, g] of byProvider) {
    const label = g.provider.name && String(g.provider.name).trim() ? String(g.provider.name).trim() : pid
    let done = 0
    let failed = 0
    for (const m of g.models) {
      const h = cache[keyOf(pid, m.id)]
      if (h && h.error) failed += 1
      else if (h && h.firstMs > 0) done += 1
    }
    items.push({
      title: `▸ ${label}`,
      subtitle: `${g.models.length} 个模型 · 已测 ${done}${failed ? ` · 失败 ${failed}` : ''}`,
      trailing: '⚡ 测全部',
      icon: 'folder',
      tone: 'info',
      action: { id: 'testGroup', args: { provider: pid } },
    })
    for (const model of g.models) {
      const h = cache[keyOf(pid, model.id)]
      let subtitle
      let tone = 'muted'
      if (h && h.error) {
        subtitle = `失败：${String(h.error).slice(0, 32)}`
        tone = 'bad'
      } else if (h && h.firstMs > 0) {
        subtitle = `首字 ${fmtMs(h.firstMs)} · ${fmtTps(h.tps)}`
        tone = 'good'
      } else {
        subtitle = '未测，点一下开始'
      }
      items.push({
        title: `    ${model.name || model.id}`,
        subtitle,
        trailing: '',
        icon: 'bolt',
        tone,
        action: { id: 'test', args: { provider: pid, model: model.id } },
      })
    }
  }
  return items.slice(0, MAX_LIST_ITEMS)
}

// 模块级共享状态：面板数据推送函数、模型目录缓存、正在跑的分组任务、串行写缓存
let panelEmit = null
let cachedModels = null
let runningGroup = null
let writeChain = Promise.resolve()

async function getModels(service) {
  if (!cachedModels) cachedModels = await collectModels(service)
  return cachedModels
}

function updateCache(key, value) {
  writeChain = writeChain.then(() => {
    const c = readCache()
    c[key] = value
    writeCache(c)
  })
  return writeChain
}

async function buildPanelData(service) {
  const models = service ? await getModels(service) : []
  const cache = readCache()
  const groupCount = new Set(models.map((m) => m.provider.id)).size
  const note = models.length === 0
    ? '没有可用模型'
    : `共 ${models.length} 个模型 / ${groupCount} 个分组`
  const progress = runningGroup
    ? `正在测 ${runningGroup.provider}：${runningGroup.done}/${runningGroup.total}，结果实时刷新`
    : '点组名一次测完该组；点单个模型只测它自己。'
  return { groups: buildGroups(cache, models), note, progress, total: models.length, groupCount }
}

async function emitPanel(service) {
  if (!panelEmit) return
  try { panelEmit(await buildPanelData(service)) } catch {}
}

/** 后台逐个测一组模型，并发 3，每完成一个就刷新面板。 */
async function testGroup(service, provider) {
  if (runningGroup) return false
  const state = { provider, total: 0, done: 0, cancelled: false }
  runningGroup = state
  const models = (await getModels(service)).filter((m) => m.provider.id === provider)
  state.total = models.length
  await emitPanel(service)
  let cursor = 0
  const worker = async () => {
    while (cursor < models.length && !state.cancelled) {
      const m = models[cursor++]
      const ac = new AbortController()
      const timer = setTimeout(() => ac.abort(), 45000)
      try {
        const r = await runBench(service, provider, m.model.id, ac.signal)
        await updateCache(keyOf(provider, m.model.id), { ...r, at: Date.now() })
      } catch (error) {
        await updateCache(keyOf(provider, m.model.id), {
          error: String(error && error.message || error).slice(0, 100), at: Date.now(),
        })
      } finally {
        clearTimeout(timer)
      }
      state.done += 1
      await emitPanel(service)
    }
  }
  try {
    await Promise.all([worker(), worker(), worker()])
  } finally {
    runningGroup = null
    await emitPanel(service)
  }
  return true
}

export function apply(ctx) {
  // ---------- 手机端：dsh-go 原生面板（按分组） ----------
  ctx.inject(['dshGo'], (goCtx) => {
    const llm = () => goCtx.get('llm')

    goCtx.dshGo.panel('speedtest', {
      view: () => ({
        v: 2,
        type: 'stack',
        title: '模型测速',
        children: [
          { type: 'text', text: '按渠道分组，点组名一次测完该组；点模型只测单个。会消耗对应渠道额度。', tone: 'muted' },
          { type: 'text', text: { $: 'data.note' }, tone: 'muted' },
          { type: 'text', text: { $: 'data.progress' }, tone: 'muted' },
          { type: 'list', items: { $: 'data.groups' } },
          { type: 'actions', items: [
            { label: '刷新', action: 'reload' },
            { label: '清空', action: 'clear' },
            { label: '停止测速', action: 'stop' },
          ] },
        ],
      }),

      data: (scope, emit) => {
        panelEmit = emit
        ;(async () => {
          try { emit(await buildPanelData(llm())) }
          catch (error) { emit({ groups: [], note: `读取失败：${String(error && error.message || error).slice(0, 60)}`, progress: '' }) }
        })()
        return () => { if (panelEmit === emit) panelEmit = null }
      },

      actions: {
        test: (scope, event) => {
          const args = (event && event.value) || {}
          const provider = String(args.provider || '')
          const model = String(args.model || '')
          if (!provider || !model) return { toast: '缺少模型信息' }
          return {
            pending: { label: '测速中…', timeoutMs: 60000 },
            result: async (signal) => {
              const service = llm()
              if (!service) return { toast: '没有模型服务' }
              try {
                const r = await runBench(service, provider, model, signal)
                await updateCache(keyOf(provider, model), { ...r, at: Date.now() })
                return {
                  toast: `首字 ${fmtMs(r.firstMs)} · ${fmtTps(r.tps)}`,
                  patch: { groups: buildGroups(readCache(), await getModels(service)) },
                }
              } catch (error) {
                const message = String(error && error.message || error).slice(0, 100)
                await updateCache(keyOf(provider, model), { error: message, at: Date.now() })
                return {
                  toast: `失败：${message.slice(0, 30)}`,
                  patch: { groups: buildGroups(readCache(), await getModels(service)) },
                }
              }
            },
          }
        },
        testGroup: (scope, event) => {
          const provider = String(((event && event.value) || {}).provider || '')
          if (!provider) return { toast: '缺少分组信息' }
          const service = llm()
          if (!service) return { toast: '没有模型服务' }
          if (runningGroup) return { toast: `正在测 ${runningGroup.provider}，等一会` }
          testGroup(service, provider).catch(() => {})
          return { toast: `开始测 ${provider} 全组，结果实时刷新` }
        },
        stop: () => {
          if (!runningGroup) return { toast: '当前没有在测' }
          runningGroup.cancelled = true
          return { toast: '已停止，已完成的结果保留' }
        },
        reload: () => {
          cachedModels = null
          return { refresh: true }
        },
        clear: () => {
          writeCache({})
          return { toast: '已清空结果', refresh: true }
        },
      },
    })

    // 输入框上方状态条：显示最近一次测速结果，点一下打开完整面板
    goCtx.dshGo.strip('speedLatest', (scope, emit, caps) => {
      const en = String((caps && caps.locale) || '').toLowerCase().startsWith('en')
      const tick = () => {
        const cache = readCache()
        const done = Object.entries(cache)
          .filter(([, v]) => v && !v.error && Number.isFinite(v.firstMs))
          .sort((a, b) => (b[1].at || 0) - (a[1].at || 0))
        if (done.length === 0) {
          emit({ text: en ? 'No speed test yet' : '模型测速 · 未测', icon: 'bolt' })
          return
        }
        const [key, v] = done[0]
        const model = key.split('\u0000')[1] || ''
        const short = model.length > 12 ? `${model.slice(0, 11)}…` : model
        const ft = v.firstMs >= 1000 ? `${(v.firstMs / 1000).toFixed(2)}s` : `${Math.round(v.firstMs)}ms`
        const tps = v.tps >= 100 ? String(Math.round(v.tps)) : Number(v.tps).toFixed(1)
        emit({ text: `${short} ${ft} · ${tps}t/s`, icon: 'bolt', tone: 'good' })
      }
      tick()
      const timer = setInterval(tick, 30_000)
      return () => clearInterval(timer)
    })
  })

  // ---------- 桌面端 / 网页版：给 lib/client.js 提供分组目录与测速接口 ----------
  ctx.inject(['webServer'], (webCtx) => {
    const json = (res, code, body) => {
      res.writeHead(code, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
      res.end(JSON.stringify(body))
    }

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/local-model-speedtest/catalog',
      handler: async (req, res) => {
        if (req.method !== 'GET' && req.method !== 'HEAD') return json(res, 405, { error: 'method not allowed' })
        const service = webCtx.get('llm')
        if (!service) return json(res, 503, { error: 'no llm service' })
        try {
          const models = await collectModels(service)
          const byProvider = new Map()
          for (const { provider, model } of models) {
            if (!byProvider.has(provider.id)) {
              byProvider.set(provider.id, {
                provider: provider.id,
                name: (provider.name && String(provider.name).trim()) || provider.id,
                models: [],
              })
            }
            byProvider.get(provider.id).models.push({ id: model.id, name: model.name || model.id })
          }
          json(res, 200, {
            groups: [...byProvider.values()],
            models: models.map(({ provider, model }) => ({ provider: provider.id, model: model.id, name: model.name || model.id })),
          })
        } catch (error) {
          json(res, 500, { error: String(error && error.message || error).slice(0, 200) })
        }
      },
    }), 'local-model-speedtest: catalog')

    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/local-model-speedtest/bench',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const service = webCtx.get('llm')
        if (!service) return json(res, 503, { error: 'no llm service' })
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 8192) { json(res, 413, { error: 'too large' }); return }
        }
        let args
        try { args = JSON.parse(body || '{}') } catch { return json(res, 400, { error: 'bad json' }) }
        const provider = String(args.provider || '')
        const model = String(args.model || '')
        if (!provider || !model) return json(res, 400, { error: 'provider and model are required' })
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), 60000)
        req.on('close', () => clearTimeout(timer))
        try {
          const r = await runBench(service, provider, model, controller.signal)
          await updateCache(keyOf(provider, model), { ...r, at: Date.now() })
          json(res, 200, { ok: true, ...r })
        } catch (error) {
          json(res, 200, { ok: false, error: String(error && error.message || error).slice(0, 200) })
        } finally {
          clearTimeout(timer)
        }
      },
    }), 'local-model-speedtest: bench')
  })
}
