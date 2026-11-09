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
// 思考模型会先输出一大段 reasoning，160 token 往往在“想”的阶段就被截断，
// 导致测不到正文、首字延迟也失真。给思考模型留足预算，保证正文能出来。
const MAX_TOKENS_REASONING = 384
const PROMPT_TAIL = '天空很蓝，风从窗缝里钻进来，桌上那杯茶还在冒热气。请原样输出这句话，不要解释，不要加标点以外的东西。'
const MAX_LIST_ITEMS = 50
// 超过这个时间的结果视为“过期”：API 拥堵是时段性的，旧数据只能参考。
const STALE_AFTER_MS = 60 * 60 * 1000
// 模型 id 里带这些片段时，按思考模型处理（可用 model.reasoning 显式覆盖）。
const REASONING_HINT = /(^|[-_./])(r1|o1|o3|o4|qwq|reasoner|reasoning|thinking|think)([-_./]|$)/i
// 报错解释：给模型留够输出空间；思考模型还要额外预留“想”的预算。
const MAX_TOKENS_EXPLAIN = 480
const MAX_TOKENS_EXPLAIN_REASONING = 1024
const FREE_HINT = /(^|[-_./\s])free([-_./\s]|$)/i

function isFreeModel(model, provider) {
  if (!model) return false
  if (model.isFree === true || model.free === true) return true
  if (Array.isArray(model.tags) && model.tags.some((tag) => /^free$/i.test(String(tag)))) return true
  const hay = `${model.id || ''} ${model.name || ''} ${(provider && provider.id) || ''} ${(provider && provider.name) || ''}`
  return FREE_HINT.test(hay) || /免费/.test(hay)
}

/** 报错原文可能夹带 key；发给解释模型前先遮掉常见密钥格式。 */
function redactSecrets(text) {
  return String(text || '')
    .slice(0, 3000)
    .replace(/\b(sk-[A-Za-z0-9_-]{8,}|Bearer\s+[A-Za-z0-9._~+/=-]{8,}|gh[pousr]_[A-Za-z0-9]{16,}|AIza[0-9A-Za-z_-]{20,}|xox[baprs]-[0-9A-Za-z-]{10,}|[A-Fa-f0-9]{32,})\b/g, '[已隐藏]')
    .slice(0, 2000)
}

/** 让用户选定的模型把原始报错翻译成大白话。 */
async function explainError(llm, provider, model, message, code, signal) {
  const modelId = String(model || '')
  const meta = findModel(modelId) || { id: modelId }
  const maxTokens = isReasoningModel(meta) ? MAX_TOKENS_EXPLAIN_REASONING : MAX_TOKENS_EXPLAIN
  const problem = redactSecrets(message)
  const codeText = code ? String(code).slice(0, 80) : ''
  const prompt = [
    '你是一个帮普通用户看报错的助手。用户刚在 AI 对话里遇到一次失败，下面是原始报错。',
    '请用简体中文、大白话解释，不要用术语，不要空泛，不要编造。控制在 4 行以内：',
    '第 1 行：原因：……',
    '第 2 行：你可以：……（最多两个具体动作）',
    '如果明显是账号、余额或权限问题，优先说清楚；如果这条信息不够判断，就直接说“这条报错信息不够，可能是……”，不要假装确定。',
    '只输出给用户看的解释，不要复述这段说明。',
    '',
    '原始报错：',
    problem,
    codeText ? `\n错误码：${codeText}` : '',
  ].join('\n')

  const messages = [{
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: prompt }],
    source: { kind: 'model-error-explain' },
  }]
  const call = await llm.prepareCall({ provider, model: modelId, maxTokens }, signal)
  let text = ''
  let finish
  for await (const chunk of call.stream({
    ...call.config,
    messages,
    signal,
    purpose: 'model-error-explain',
  })) {
    if (chunk.type === 'text-delta') text += chunk.text
    else if (chunk.type === 'finish') finish = chunk.reason
  }
  if (finish && finish.kind === 'error') {
    const msg = (finish.failure && (finish.failure.message || finish.failure.code)) || '解释失败'
    throw new Error(String(msg).slice(0, 160))
  }
  if (finish && finish.kind === 'aborted') throw new Error('已取消')
  text = text.trim()
  if (!text) throw new Error('模型没有返回内容')
  return text.slice(0, 4000)
}

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

/** 判断模型是否为思考模型：优先信任模型元数据，其次按 id 猜。 */
function isReasoningModel(model) {
  if (!model) return false
  if (typeof model.reasoning === 'boolean') return model.reasoning
  if (model.capabilities && typeof model.capabilities.reasoning === 'boolean') {
    return model.capabilities.reasoning
  }
  return REASONING_HINT.test(String(model.id || model.name || ''))
}

/** 把缓存时间格式化成“刚刚 / 12 分钟前 / 3 小时前”，用于提示结果新鲜度。 */
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
  return Boolean(entry && entry.at && Date.now() - entry.at > STALE_AFTER_MS)
}

function fmtReasoning(entry) {
  return entry && Number(entry.reasoningMs) > 0 ? ` · 思考 ${fmtMs(entry.reasoningMs)}` : ''
}

/** 一次真实生成：测首字延迟（首个 token 到达）与生成速度（token/秒）。 */
async function runBench(llm, provider, model, signal) {
  // 调用方可能只传 model id（网页 /bench）；能拿到模型元数据时用它判断是否思考模型。
  const modelId = typeof model === 'string' ? model : String((model && model.id) || '')
  const meta = (typeof model === 'object' && model) || findModel(modelId) || { id: modelId }
  const maxTokens = isReasoningModel(meta) ? MAX_TOKENS_REASONING : MAX_TOKENS

  const messages = [{
    id: randomUUID(),
    role: 'user',
    content: [{ type: 'text', text: PROMPT_TAIL }],
    source: { kind: 'model-speedtest' },
  }]
  const call = await llm.prepareCall({ provider, model: modelId, maxTokens }, signal)
  const options = { ...call.config, messages, signal, purpose: 'model-speedtest' }
  const t0 = Date.now()
  let first = 0          // 首个任意 token（思考模型通常是 reasoning 的第一字）
  let firstContent = 0   // 首个正文 token：对用户来说这才是“真的开始了”
  let last = 0
  let chunks = 0
  let reasoningChunks = 0
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
        if (chunk.type === 'reasoning-delta') {
          reasoningChunks += 1
        } else {
          if (firstContent === 0) firstContent = t
          text += chunk.text
        }
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
  // 生成速度仍按“首 token → 末 token”的整段计算，保持与旧结果可比；
  // 思考过程单独用 reasoningMs 暴露出来，界面可以分开展示。
  const genMs = first > 0 && last > first ? last - first : totalMs
  const tps = tokens > 0 && genMs > 0 ? (tokens / (genMs / 1000)) : 0
  return {
    firstMs,
    contentFirstMs: firstContent > 0 ? firstContent - t0 : 0,
    reasoningMs: firstContent > 0 && first > 0 ? firstContent - first : 0,
    isReasoning: reasoningChunks > 0,
    tps,
    tokens,
    totalMs,
    text: text.slice(0, 200),
  }
}

/** 在已缓存的模型目录里按 id 找模型元数据（找不到返回 null）。 */
function findModel(modelId) {
  if (!cachedModels || !modelId) return null
  const hit = cachedModels.find((item) => item.model && item.model.id === modelId)
  return hit ? hit.model : null
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
        // 思考模型：展示“正文首字”（用户真正看到字的时间），并把思考耗时单列。
        const shownFirst = Number(h.contentFirstMs) > 0 ? h.contentFirstMs : h.firstMs
        const stale = isStale(h)
        subtitle = `首字 ${fmtMs(shownFirst)} · ${fmtTps(h.tps)}${fmtReasoning(h)}${
          stale ? ` · ${fmtAge(h.at)}` : ''
        }`
        tone = stale ? 'muted' : 'good'
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
      const timeoutMs = isReasoningModel(m.model) ? 75000 : 45000
      const timer = setTimeout(() => ac.abort(), timeoutMs)
      try {
        const r = await runBench(service, provider, m.model, ac.signal)
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
                const shownFirst = Number(r.contentFirstMs) > 0 ? r.contentFirstMs : r.firstMs
                return {
                  toast: `首字 ${fmtMs(shownFirst)} · ${fmtTps(r.tps)}${fmtReasoning(r)}`,
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
        const shownFirst = Number(v.contentFirstMs) > 0 ? v.contentFirstMs : v.firstMs
        const ft = shownFirst >= 1000 ? `${(shownFirst / 1000).toFixed(2)}s` : `${Math.round(shownFirst)}ms`
        const tps = v.tps >= 100 ? String(Math.round(v.tps)) : Number(v.tps).toFixed(1)
        const stale = isStale(v)
        emit({
          text: `${short} ${ft} · ${tps}t/s${stale ? ` · ${fmtAge(v.at)}` : ''}`,
          icon: 'bolt',
          tone: stale ? 'muted' : 'good',
        })
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
          // 顺手缓存模型元数据，/bench 只拿到 id 时也能判断是否思考模型。
          cachedModels = models
          const byProvider = new Map()
          for (const { provider, model } of models) {
            if (!byProvider.has(provider.id)) {
              byProvider.set(provider.id, {
                provider: provider.id,
                name: (provider.name && String(provider.name).trim()) || provider.id,
                models: [],
              })
            }
            byProvider.get(provider.id).models.push({
              id: model.id,
              name: model.name || model.id,
              free: isFreeModel(model, provider),
            })
          }
          json(res, 200, {
            groups: [...byProvider.values()],
            models: models.map(({ provider, model }) => ({
              provider: provider.id,
              model: model.id,
              name: model.name || model.id,
              free: isFreeModel(model, provider),
            })),
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
        const meta = findModel(model) || { id: model }
        const timeoutMs = isReasoningModel(meta) ? 90000 : 60000
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        // 客户端断开时停止继续消耗额度；超时定时器必须独立保留，
        // 否则 req 读完就触发 close 会把超时清掉。
        if (res && typeof res.on === 'function') res.on('close', () => controller.abort())
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

    // 桌面端报错处的「大白话解释」：把原始报错交给用户选定的模型翻译。
    webCtx.effect(() => webCtx.webServer.register({
      kind: 'exact',
      path: '/plugins/local-model-speedtest/explain',
      handler: async (req, res) => {
        if (req.method !== 'POST') return json(res, 405, { error: 'method not allowed' })
        const service = webCtx.get('llm')
        if (!service) return json(res, 503, { error: 'no llm service' })
        let body = ''
        for await (const chunk of req) {
          body += chunk
          if (body.length > 16384) { json(res, 413, { error: 'too large' }); return }
        }
        let args
        try { args = JSON.parse(body || '{}') } catch { return json(res, 400, { error: 'bad json' }) }
        const provider = String(args.provider || '')
        const model = String(args.model || '')
        const message = String(args.message || '').trim()
        const code = String(args.code || '').trim()
        if (!provider || !model) return json(res, 400, { error: 'provider and model are required' })
        if (!message) return json(res, 400, { error: 'message is required' })
        const meta = findModel(model) || { id: model }
        const timeoutMs = isReasoningModel(meta) ? 90000 : 60000
        const controller = new AbortController()
        const timer = setTimeout(() => controller.abort(), timeoutMs)
        if (res && typeof res.on === 'function') res.on('close', () => controller.abort())
        try {
          const text = await explainError(service, provider, model, message, code, controller.signal)
          json(res, 200, { ok: true, text, provider, model })
        } catch (error) {
          json(res, 200, { ok: false, error: String(error && error.message || error).slice(0, 200) })
        } finally {
          clearTimeout(timer)
        }
      },
    }), 'local-model-speedtest: explain')
  })
}
