// SOLO SSE 事件解析与 OpenAI 转换。
//
// 基础口径对齐 llm-api 的 internal/relay/channel/trae/solosse.go（上游恒回 SSE，
// 事件名决定载荷含义：thought / output / token_usage / done / error）；
// 另几处是上一版插件（apps/plugins/packages/trae）在真账号上实测出来的、
// llm-api 没覆盖的细节，逐条标了出处：
//
//   - 事件名不只 output：还有 message / delta / content / text / answer / chunk /
//     output_delta / message_delta（外加无名事件），正文也可能在 content 或
//     delta.content 而不是 response；
//   - 结束事件不只 done：还有 response_done / stream_done；
//   - finish_reason 需要归一（max_tokens → length 这类），否则客户端不认；
//   - 错误也可能挂在非 error 事件上（{code,message} 而没有正文）；
//   - 用量块：字段别名多，且缓存计数要用 Anthropic 的名字 + OpenAI 的嵌套字段
//     两条都发；上游压根没说缓存时打 magpie_cache_unknown，免得被读成 0% 命中；
//   - 思维链会重复发（同一段连发两次，或把「目前为止的全部」再发一遍），要只
//     发新增部分。

// ANSWER 是承载正文的事件名（"" 是无名事件）——上一版插件的实测集合。
const ANSWER = new Set(["", "output", "message", "delta", "content", "text", "answer", "chunk", "output_delta", "message_delta"])

// DONE 是结束事件名。
const DONE = new Set(["done", "response_done", "stream_done"])

// eventName 归一事件名：驼峰与分隔符都归成 snake_case 小写。
export function eventName(s) {
  return String(s ?? "")
    .replace(/([a-z0-9])([A-Z])/g, "$1_$2")
    .replace(/[^A-Za-z0-9]+/g, "_")
    .toLowerCase()
    .replace(/^_|_$/g, "")
}

// SoloDecoder 累积 SSE 行，事件边界（空行）时产出一条解析后的事件。
export class SoloDecoder {
  constructor() {
    this.buffer = ""
    this.event = ""
    this.data = ""
    // 解析失败的行数：坏行被跳过，但要留个可诊断的计数
    this.bad = 0
  }

  // push 喂入一段文本，返回这一段里完整的事件。
  push(text) {
    this.buffer += text
    const out = []
    for (;;) {
      const nl = this.buffer.indexOf("\n")
      if (nl < 0) break
      const line = this.buffer.slice(0, nl).replace(/\r$/, "")
      this.buffer = this.buffer.slice(nl + 1)
      const ev = this.line(line)
      if (ev) out.push(ev)
    }
    return out
  }

  // end 冲掉最后一行（上游没发空行就断流时）。
  end() {
    const out = []
    if (this.buffer) {
      const ev = this.line(this.buffer.replace(/\r$/, ""))
      this.buffer = ""
      if (ev) out.push(ev)
      const last = this.flush()
      if (last) out.push(last)
    }
    return out
  }

  // line 处理一行，遇空行时结算一个事件。
  line(line) {
    if (line === "") return this.flush()
    if (line.startsWith("event:")) {
      // 事件名出现就结算上一条：有的上游不靠空行分隔
      const prev = this.flush()
      this.event = line.slice("event:".length).trim()
      return prev
    }
    if (line.startsWith("data:")) {
      this.data += line.slice("data:".length)
      return null
    }
    // 注释行（":" 开头）忽略
    return null
  }

  reset() {
    this.event = ""
    this.data = ""
  }

  flush() {
    if (!this.event && !this.data) {
      this.reset()
      return null
    }
    const ev = parseEvent(this.event, this.data)
    this.reset()
    if (!ev) this.bad++
    return ev
  }
}

// parseEvent 解析一个事件的 event 名与 data 载荷。
export function parseEvent(eventNameRaw, dataLine) {
  const raw = String(eventNameRaw).trim()
  // 没有 event 行时，把 data 里的 event / type 当事件名（上一版插件同样兜底）
  let data
  if (dataLine) {
    try {
      data = JSON.parse(dataLine)
    } catch {
      return null
    }
  }
  const name = eventName(raw || pickName(data))
  const ev = { event: name }
  if (!data || typeof data !== "object") return ev

  if (name === "token_usage" || name === "usage") {
    ev.usage = usageOf(data)
    return ev
  }
  if (DONE.has(name)) {
    ev.finishReason = finishOf(data)
    if (data.usage) ev.usage = usageOf(data.usage)
    ev.completed = true
    return ev
  }
  if (name === "error") {
    ev.errorCode = Number(data.code ?? data.Code) || 0
    ev.errorMessage = String(data.message ?? data.msg ?? data.Message ?? "")
    return ev
  }
  // thought 是 create_agent_task 的正文事件（保留兼容）
  if (name === "thought") {
    if (typeof data.thought === "string") ev.response = data.thought
    const r = reasoningOf(data)
    if (r) ev.reasoning = r
    return ev
  }
  if (ANSWER.has(name)) {
    const text = textOf(data)
    const r = reasoningOf(data)
    if (text) ev.response = text
    if (r) ev.reasoning = r
    if (Array.isArray(data.tool_calls)) ev.toolCalls = data.tool_calls
    if (data.usage) ev.usage = usageOf(data.usage)
    const finish = finishOf(data)
    if (finish) ev.finishReason = finish
    // 非 error 事件上挂着的错误：有 code 与 message 却没有正文（实测形态）
    if (!text && !r && !ev.toolCalls && (data.code || data.Code) && (data.message || data.msg || data.Message)) {
      ev.errorCode = Number(data.code ?? data.Code) || 0
      ev.errorMessage = String(data.message ?? data.msg ?? data.Message ?? "")
      delete ev.finishReason
    }
    return ev
  }
  // 其它事件（progress / ping 等）里若带用量也读出来，其余忽略
  if (data.usage) ev.usage = usageOf(data.usage)
  return ev
}

// pickName 是 data 里自带的事件名（没有 event 行时的兜底）。
function pickName(data) {
  if (!data || typeof data !== "object") return ""
  return String(data.event ?? data.type ?? "")
}

// textOf 读正文：response / content / delta.content / delta（字符串）。
function textOf(d) {
  const delta = d.delta && typeof d.delta === "object" ? d.delta : {}
  const cands = [d.response, d.content, delta.content, typeof d.delta === "string" ? d.delta : undefined]
  for (const v of cands) if (typeof v === "string" && v) return v
  return ""
}

// reasoningOf 读思维链：reasoning_content 或 reasoning，顶层或 delta 下。
function reasoningOf(d) {
  const delta = d.delta && typeof d.delta === "object" ? d.delta : {}
  const cands = [d.reasoning_content, d.reasoning, delta.reasoning_content, delta.reasoning]
  for (const v of cands) if (typeof v === "string" && v) return v
  return ""
}

// finishOf 把上游的收尾原因归成 OpenAI 认的那几个。
//
// 上游会给 max_tokens / max_output_tokens / max_length 这类自己的写法，客户端只认
// length；不给的就留空，由调用方按 stop / tool_calls 收尾。
export function finishOf(d) {
  const f = String(d?.finish_reason ?? d?.stop_reason ?? d?.finishReason ?? "").toLowerCase()
  if (["length", "max_tokens", "max_output_tokens", "max_length"].includes(f)) return "length"
  if (f === "content_filter" || f === "sensitive") return "content_filter"
  if (f === "tool_calls" || f === "tool_call" || f === "function_call") return "tool_calls"
  if (f === "stop" || f === "end_turn" || f === "") return f
  // 认不出来的不猜：留空让调用方按默认收尾
  return ""
}

// CACHE_NAMED 是「上游提过缓存这件事」的字段名集合。
const CACHE_NAMED = [
  "cache_read_input_tokens",
  "cacheReadInputTokens",
  "cache_creation_input_tokens",
  "cacheCreationInputTokens",
  "prompt_cache_hit_tokens",
  "cached_tokens",
]

// usageOf 把 SOLO 的用量块搬成 OpenAI 形状，并保留缓存的双口径。
//
// 字段别名与缓存口径来自上一版插件的实测：
//   - SOLO 把 reasoning_tokens 与缓存计数放在顶层，OpenAI 认的是
//     completion_tokens_details.reasoning_tokens 与 prompt_tokens_details.cached_tokens；
//   - 缓存同时按 Anthropic 的名字（cache_read_input_tokens /
//     cache_creation_input_tokens）发一份：magpie 读 Claude 系中转时就是看这两个；
//   - 上游压根没说缓存时打 magpie_cache_unknown，别让它被读成 0% 命中
//     （Trae 有段时间停发了缓存字段，实战里每轮都显示 0）。
export function usageOf(raw) {
  if (!raw || typeof raw !== "object") return { prompt_tokens: 0, completion_tokens: 0, total_tokens: 0 }
  const num = (...vals) => {
    for (const v of vals) if (v !== undefined && v !== null) return Number(v) || 0
    return 0
  }
  const prompt = num(raw.prompt_tokens, raw.input_tokens, raw.promptTokens, raw.inputTokens)
  const completion = num(raw.completion_tokens, raw.output_tokens, raw.completionTokens, raw.outputTokens)
  const usage = {
    prompt_tokens: prompt,
    completion_tokens: completion,
    total_tokens: num(raw.total_tokens, raw.totalTokens) || prompt + completion,
  }
  const thought = num(raw.reasoning_tokens, raw.completion_tokens_details?.reasoning_tokens)
  if (thought) usage.completion_tokens_details = { reasoning_tokens: thought }

  const read = Math.max(
    0,
    ...[
      raw.prompt_tokens_details?.cached_tokens,
      raw.input_tokens_details?.cached_tokens,
      raw.prompt_cache_hit_tokens,
      raw.cached_tokens,
    ].map((v) => Number(v) || 0),
  )
  const write = num(raw.prompt_tokens_details?.cache_write_tokens)
  const named = CACHE_NAMED.some((k) => raw[k] !== undefined && raw[k] !== null) ||
    raw.prompt_tokens_details?.cached_tokens !== undefined ||
    raw.input_tokens_details?.cached_tokens !== undefined

  if (read || write) {
    usage.prompt_tokens_details = { cached_tokens: read, ...(write ? { cache_write_tokens: write } : {}) }
  } else if (!named) {
    // 完全没说缓存：标成未知，而不是 0
    usage.magpie_cache_unknown = true
  } else {
    const r = num(raw.cache_read_input_tokens, raw.cacheReadInputTokens)
    const w = num(raw.cache_creation_input_tokens, raw.cacheCreationInputTokens)
    if (r) usage.cache_read_input_tokens = r
    if (w) usage.cache_creation_input_tokens = w
    // 有读写数才给 OpenAI 的嵌套字段。真机上 token_usage 是「具名但 0/0」的常态，
    // 这时代码不能写 cached_tokens: 0 —— 那会被当成「一次都没命中」，而 Trae 实际
    // 仍按缓存价计费，0 只说明它没说。只打 unknown。
    if (r || w) usage.prompt_tokens_details = { cached_tokens: r, ...(w ? { cache_write_tokens: w } : {}) }
    else usage.magpie_cache_unknown = true
  }
  return usage
}

// toolCallsOf 把 SOLO 的 tool_calls 转成 OpenAI 的 function 形状。
//
// 真机帧是**分片**发给客户端的（与 OpenAI 自己的流式一样）：第一片带 id 与 name、
// arguments 为空；下一片 id / name 为空、arguments 是全量。客户端按 index 累加。
//
// 所以空的 id / name / type 一律不写（写了会让累加器把已经拿到的名字覆盖成空串），
// 而 arguments 即使为空也要写（累加器靠它拼）。namespace / partial_arguments 是
// Trae 自己的字段，OpenAI 客户端不认，剔掉。
//
// 非流式聚合由 mergeToolCalls 按 index 合并，得到一次完整调用。
export function toolCallsOf(event) {
  const list = event?.toolCalls
  if (!Array.isArray(list) || !list.length) return []
  const out = []
  for (const c of list) {
    if (!c || typeof c !== "object") continue
    const fn = c.function_call && typeof c.function_call === "object" ? c.function_call : c.function
    if (!fn || typeof fn !== "object") continue
    const name = typeof fn.name === "string" ? fn.name : ""
    // 名字与参数都没有的分片：不是一次调用
    const args = typeof fn.arguments === "string" ? fn.arguments : ""
    if (!name && !args) continue
    out.push({
      ...(typeof c.id === "string" && c.id ? { id: c.id } : {}),
      // 开首那一片（带名字的）才写 type；后续的续片不写，免得覆盖
      ...(name ? { type: "function" } : {}),
      ...(Number.isFinite(c.index) ? { index: Number(c.index) } : {}),
      function: {
        ...(name ? { name } : {}),
        arguments: args,
      },
    })
  }
  return out
}

// mergeToolCalls 按 index 合并 tool_calls，arguments 拼接（Go 的 mergeToolCalls）。
export function mergeToolCalls(acc, incoming) {
  for (const inc of incoming) {
    const idx = Number.isFinite(inc.index) ? inc.index : 0
    const hit = acc.find((a) => (Number.isFinite(a.index) ? a.index : 0) === idx)
    if (!hit) {
      acc.push({ ...inc })
      continue
    }
    if (inc.id) hit.id = inc.id
    if (inc.function?.name) hit.function.name = inc.function.name
    hit.function.arguments += inc.function?.arguments ?? ""
  }
  return acc
}

// Thoughts 只发思维链的新增部分。
//
// 上游会把同一段连发两次，或把「目前为止的全部」再发一遍（有时后面接着新内容）。
// 不处理就会在客户端看到重复的思考文字。
export class Thoughts {
  constructor() {
    this.all = ""
    this.last = ""
  }

  add(piece) {
    const s = String(piece ?? "")
    if (!s) return ""
    // 同一段连发两次
    if (s === this.last && s.length >= 8) return ""
    this.last = s
    // 「目前为止的全部」再发一遍：只发新增
    if (this.all && s.startsWith(this.all)) {
      const delta = s.slice(this.all.length)
      this.all = s
      return delta
    }
    // 与已发内容尾部重叠的一小段（上游按窗口重发）：切掉重叠
    const tail = this.all.slice(-s.length)
    if (tail && s.length >= 8 && s.startsWith(tail)) {
      const delta = s.slice(tail.length)
      this.all = this.all + delta
      return delta
    }
    this.all += s
    return s
  }
}

// aggregate 把整条流聚合成一条 assistant 消息（客户端要非流式时用）。
export function aggregate(events) {
  let content = ""
  let finishReason = ""
  let usage
  const thoughts = new Thoughts()
  let reasoning = ""
  const toolCalls = []
  for (const ev of events) {
    if (ev.event === "error") {
      const err = new Error(ev.errorMessage || `上游错误 code=${ev.errorCode}`)
      err.code = ev.errorCode
      throw err
    }
    if (ev.response) content += ev.response
    if (ev.reasoning) {
      const delta = thoughts.add(ev.reasoning)
      if (delta) reasoning += delta
    }
    if (ev.toolCalls) mergeToolCalls(toolCalls, toolCallsOf(ev))
    if (ev.usage) usage = ev.usage
    if (ev.finishReason) finishReason = ev.finishReason
  }
  // 有工具调用时 finish_reason 必须是 tool_calls，否则客户端不会去执行工具
  if (toolCalls.length) finishReason = "tool_calls"
  return { content, reasoning, toolCalls, finishReason: finishReason || "stop", usage }
}

// chunkOf 造一个 OpenAI chat.completion.chunk（delta 为空表示只带 finish_reason）。
export function chunkOf({ id, model, created, delta, finishReason }) {
  return {
    id,
    object: "chat.completion.chunk",
    created,
    model,
    choices: [
      {
        index: 0,
        delta: delta ?? {},
        finish_reason: finishReason ?? null,
      },
    ],
  }
}

// completionOf 造一条非流式的 chat.completion。
export function completionOf({ id, model, created, result, usage }) {
  const message = { role: "assistant", content: result.content || (result.toolCalls?.length ? null : "") }
  if (result.reasoning) message.reasoning_content = result.reasoning
  if (result.toolCalls?.length) {
    // 非流式形态里不带 index（那是流式分片的字段），type 补上
    message.tool_calls = result.toolCalls.map((c) => ({
      ...(c.id ? { id: c.id } : {}),
      type: "function",
      function: c.function,
    }))
  }
  return {
    id,
    object: "chat.completion",
    created,
    model,
    choices: [{ index: 0, message, finish_reason: result.finishReason }],
    ...(usage || result.usage ? { usage: usage ?? result.usage } : {}),
  }
}
