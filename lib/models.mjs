// 模型表：batch_get_detail_param，对齐 llm-api 的
// internal/relay/channel/trae/fetch_models.go。
//
// 只问 chat_v3 一张表：广告出去的模型必须就是对话会用的那条通道，否则「列表里
// 有、一点就 4001」。
//
// 端点同时决定「哪些模型能用」，所以过滤规则与 Go 侧一致：
// config_switch 为 false、is_invisible_to_user 为 true、usage 不是对话类、
// custom_model_ 前缀、重名，全部剔除。

import { CHAT_FUNCTION, EP } from "./sites.mjs"
import { soloHeaders } from "./headers.mjs"

const trimSlash = (s) => String(s ?? "").replace(/\/+$/, "")

// fetchModels 拉一张模型表，返回 [{ id, name }]。
//
// 失败抛错：由调用方决定是回落到静态清单还是把错误上抛（读不到清单不该让整个
// provider 的模型列表消失）。
export async function fetchModels(site, auth, { signal } = {}) {
  const url = `${trimSlash(site.hosts.api)}${EP.models}`
  const res = await fetch(url, {
    method: "POST",
    headers: { ...soloHeaders(auth, { stream: false, site }), Referer: url },
    body: JSON.stringify({
      functions: [CHAT_FUNCTION],
      agent_type: "",
      current_config_info: { config_name: "", is_custom_model: false },
      mode_type: 0,
      access_type: 0,
      ab_force_vids: "",
      ab_autotest_advanced_mode: 0,
      show_custom_model: true,
    }),
    signal: signal ?? AbortSignal.timeout(20000),
  })
  const text = await res.text()
  if (res.status >= 400) throw new Error(`${site.name} 的模型表读不出来：HTTP ${res.status} ${text.slice(0, 120)}`)
  let env
  try {
    env = JSON.parse(text)
  } catch {
    throw new Error(`${site.name} 的模型表不是 JSON`)
  }
  const list = modelsOf(env)
  if (!list.length) throw new Error(`${site.name} 的模型表是空的`)
  return list
}

// 客户端说的档位名 → Trae 自己的档位名。两张名字表不是同一套：客户端与 magpie
// 说的是 low / medium / high / xhigh / max，Trae 的模型条目给的是
// light / medium / high / extra_high / max（上一版插件实测）。
//
// 这里对外只报客户端的名字（客户端认的就是这套），发请求时再翻回 Trae 的名字
// （见 plugin.mjs 的 translateEffort）。
const LEVELS = { light: "low", medium: "medium", high: "high", extra_high: "xhigh", max: "max" }

// effortsOf 读一个模型条目声明的档位，用客户端的名字、按上游的顺序。
//
// 声明了才会报；条目里有本构建认不出的档位名时当「没有档位」处理（上一版插件
// 用 null 区分「不接档位」与「名字不认识」，这里两者都不报）。
//
// traeOptions 原样带回：发请求时要拿它校验翻出来的名字上游认不认。
export function effortsOf(entry) {
  const cfg = entry?.reasoning_effort_config
  const options = Array.isArray(cfg?.options) ? cfg.options.filter((o) => typeof o === "string") : []
  const known = options.filter((o) => LEVELS[o])
  if (!known.length) return { efforts: [], traeOptions: [] }
  return { efforts: known.map((o) => LEVELS[o]), traeOptions: known }
}

// modelsOf 按 Go 侧规则从响应里挑模型，并把真实条目里的能力字段读出来。
//
// 过滤规则来自 fetch_models.go（config_switch / is_invisible_to_user /
// usage / custom_model_ 前缀 / 重名）；其余字段来自 2026-11-18 抓到的
// Trae CN IDE 真实响应（`batch_get_detail_param`）：
//
//   context_window_tokens   {"dev": 256000, "max": 1000000} —— 普通对话走 dev，
//                            Max 模式才是 max（本包不提供 Max 模式，所以取 dev）
//   model_detail_list[].max_tokens   输出上限（不在条目顶层）
//   display_config.multimodal        能不能收图
//   display_contact_config           JSON 字符串，内含 consumption_rate.rate（倍数）
//   extra_config                     JSON 字符串，内含 native_function_call
//   reasoning_effort_config          support_thinking / options / default_level
//
// 两种信封都认：function_configs（按 function 分组，只取 chat_v3）与顶层
// config_info_list（老形态）。
export function modelsOf(env) {
  const seen = new Set()
  const out = []
  const add = (c) => {
    if (!c || typeof c !== "object") return
    const id = String(c.config_name ?? "").trim()
    if (!id || seen.has(id)) return
    if (c.config_switch === false) return
    if (c.is_invisible_to_user === true) return
    const usage = String(c.usage ?? "")
    if (usage && usage !== "chat_completion" && usage !== "custom_model") return
    if (id.startsWith("custom_model_")) return
    seen.add(id)
    const { efforts, traeOptions } = effortsOf(c)
    const thinking = c?.reasoning_effort_config?.support_thinking === true || efforts.length > 0
    out.push({
      id,
      name: displayNameOf(c, id),
      efforts,
      traeOptions,
      defaultEffort: effortNameOf(c?.reasoning_effort_config?.default_level),
      reasoning: thinking,
      context: contextOf(c),
      output: outputOf(c),
      images: c?.display_config?.multimodal === true,
      toolcall: extraOf(c)?.native_function_call !== false,
      rate: rateOf(c),
    })
  }
  const groups = Array.isArray(env?.function_configs) ? env.function_configs : []
  if (groups.length) {
    for (const g of groups) {
      if (g?.function !== CHAT_FUNCTION) continue
      for (const c of Array.isArray(g.config_info_list) ? g.config_info_list : []) add(c)
    }
  } else {
    for (const c of Array.isArray(env?.config_info_list) ? env.config_info_list : []) add(c)
  }
  return out
}

// displayNameOf 读上游给的展示名。
//
// 字段名取上一版插件在同一端点上实测过的三个位置；都没有就用 config_name。
// Go 侧不读展示名（服务端不需要），这里读是为了列表里不至于全是内部 id。
export function displayNameOf(c, id) {
  const name =
    c?.display_config?.display_name ||
    c?.display_name ||
    c?.display_model_name ||
    ""
  return String(name).trim() || id
}

// effortNameOf 把 Trae 的档位名翻成客户端认的名字（见 LEVELS）。
export function effortNameOf(name) {
  return LEVELS[String(name ?? "")] ?? ""
}

// parseJSONField 读上游那种「字段是 JSON 字符串」的嵌套配置。
export function parseJSONField(v) {
  if (v && typeof v === "object") return v
  if (typeof v !== "string" || !v.trim()) return null
  try {
    const out = JSON.parse(v)
    return out && typeof out === "object" ? out : null
  } catch {
    return null
  }
}

// contextOf 读上下文窗口：普通对话走 dev，缺它时取最大值。
export function contextOf(c) {
  const w = c?.context_window_tokens
  if (!w || typeof w !== "object") return 0
  const dev = Number(w.dev)
  if (Number.isFinite(dev) && dev > 0) return dev
  const nums = Object.values(w)
    .map(Number)
    .filter((n) => Number.isFinite(n) && n > 0)
  return nums.length ? Math.max(...nums) : 0
}

// outputOf 读输出上限（条目顶层不给，在 model_detail_list 里）。
export function outputOf(c) {
  const nums = (Array.isArray(c?.model_detail_list) ? c.model_detail_list : [])
    .map((d) => Number(d?.max_tokens))
    .filter((n) => Number.isFinite(n) && n > 0)
  return nums.length ? Math.max(...nums) : 0
}

// extraOf 读 extra_config（JSON 字符串），里面有 native_function_call 这类开关。
export function extraOf(c) {
  return parseJSONField(c?.extra_config)
}

// rateOf 读 credits 倍数（`display_contact_config.consumption_rate.data.rate`）。
//
// 倍数是真会花的钱：magpie 的 rate 用来比价与路由，0 = 不要钱。读不到就是未知
// （undefined），不能当 0 —— 那会让路由把付费模型当免费优先用。
export function rateOf(c) {
  const dc = parseJSONField(c?.display_contact_config)
  const raw = dc?.consumption_rate?.data?.rate
  const n = Number(raw)
  return raw === null || raw === undefined || raw === "" || !Number.isFinite(n) ? undefined : n
}

// staticModels 是拉不到时的兜底清单（sites.mjs 里的常量）。
export function staticModels(site) {
  return site.models.map((id) => ({
    id,
    name: id,
    efforts: [],
    traeOptions: [],
    defaultEffort: "",
    reasoning: false,
    context: 0,
    output: 0,
    images: false,
    toolcall: true,
    rate: undefined,
  }))
}

// modelsFrom 把模型列表转成 config 钩子要的 models 映射。
export function modelsFrom(list) {
  const out = {}
  for (const m of list) {
    const efforts = Array.isArray(m.efforts) ? m.efforts : []
    out[m.id] = {
      name: m.name,
      limit: { context: m.context ?? 0, output: m.output ?? 0 },
      tool_call: m.toolcall !== false,
      reasoning: m.reasoning === true,
      // 档位：只有上游声明了才有，名字用客户端认的那套
      ...(efforts.length ? { variants: Object.fromEntries(efforts.map((e) => [e, {}])) } : {}),
      attachment: m.images === true,
      modalities: {
        input: m.images === true ? ["text", "image"] : ["text"],
        output: ["text"],
      },
      // magpie 自己的：免费模型路由会优先用；rate 只在真读到才写（未知不是 0）
      ...(m.rate === 0 ? { free: true } : {}),
      ...(typeof m.rate === "number" ? { rate: m.rate } : {}),
    }
  }
  return out
}
