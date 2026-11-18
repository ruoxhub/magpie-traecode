// OpenAI 请求 → Trae llm_utils_chat 请求体，对齐 llm-api 的
// internal/relay/channel/trae/payload.go。
//
// 上游 llm_utils_chat 的信封与 OpenAI 几乎同构：messages 是同一份、tools 是
// OpenAI 形状，只有四处差异，且每一处都**是拒绝而不是忽略**（2026-11-10 真机实测）：
//
//	① messages[].content 必须是 [{type:"text",text:...}]，字符串被拒；
//	② tools[].function.parameters 必须是 JSON **字符串**，传对象报
//	   4001 "cannot unmarshal object ... of type string"；
//	③ assistant 的 tool_calls[].function 要改名 function_call（缺 name 的调用
//	   剔除），否则报 2001 "ToolCall ... required field Name is not set"；
//	④ developer 角色上游不认，降成 system。
//
// 上游恒回 SSE，stream 字段被忽略；显式置 true 让请求头的 Accept 与之一致。

import { CHAT_FUNCTION, DEFAULT_MODEL } from "./sites.mjs"

// prepareBody 就地改写一份 OpenAI chat/completions 请求体并返回。
//
// 传进来的对象不会被改动：调用方手里那份还要用来判断客户端要不要流式。
export function prepareBody(src) {
  if (!src || typeof src !== "object") return src
  const obj = structuredClone(src)

  obj.stream = true
  obj.function = CHAT_FUNCTION
  // 上游不走 StreamOptions（Go 侧 ConvertOpenAIRequest 直接置 nil）：客户端要的
  // usage 由本插件在收尾片上自己补，不把请求头送给上游去认一个它不认的字段
  delete obj.stream_options

  if (Array.isArray(obj.messages)) normalizeMessages(obj.messages)

  const model = typeof obj.model === "string" && obj.model.trim() ? obj.model.trim() : DEFAULT_MODEL
  // config_name 与 model 都要写：前者选模型配置，后者是回显名
  obj.config_name = model
  obj.model = model

  normalizeToolChoice(obj)
  normalizeTools(obj)
  return obj
}

// normalizeMessages 就地改写 messages：content 数组化、developer→system、
// assistant 的 tool_calls 改名 function_call。
export function normalizeMessages(messages) {
  for (const m of messages) {
    if (!m || typeof m !== "object") continue
    if (m.role === "developer") m.role = "system"
    if (m.role === "assistant") normalizeAssistantToolCalls(m)
    // content 为 null/缺失时保持原样：tool 结果与空 assistant 占位都靠它
    if (m.content === undefined || m.content === null) continue
    if (typeof m.content === "string") m.content = [{ type: "text", text: m.content }]
  }
}

// normalizeAssistantToolCalls 把 OpenAI 的 tool_calls[].function 改名成上游的
// function_call，并丢弃没有 name 的调用（上游对缺 name 直接 2001）。
export function normalizeAssistantToolCalls(m) {
  if (!Array.isArray(m.tool_calls)) return
  const kept = []
  for (const tc of m.tool_calls) {
    if (!tc || typeof tc !== "object") continue
    if (tc.function && typeof tc.function === "object") {
      tc.function_call = tc.function
      delete tc.function
    }
    if (tc.function_call && typeof tc.function_call === "object") {
      const name = typeof tc.function_call.name === "string" ? tc.function_call.name.trim() : ""
      if (!name) continue
    }
    kept.push(tc)
  }
  if (!kept.length) delete m.tool_calls
  else m.tool_calls = kept
}

// normalizeToolChoice 把 OpenAI 的 tool_choice 折算成上游认的形态。
//
// 上游没有 tool_choice 语义上的分支：它能表达的只有「禁用工具」（不传 tools）
// 与「所有工具可选」。所以 none 必须删 tools 才真的生效；auto/required/具名
// 三者在上游无差别 —— 具名调用只能靠提示词引导，这是能力降级。
export function normalizeToolChoice(obj) {
  if (!("tool_choice" in obj)) return
  const tc = obj.tool_choice
  if (typeof tc === "string") {
    if (tc.trim().toLowerCase() === "none") {
      delete obj.tool_choice
      suppressTools(obj)
    }
    return
  }
  if (!tc || typeof tc !== "object") {
    delete obj.tool_choice
    return
  }
  const type = typeof tc.type === "string" ? tc.type.trim().toLowerCase() : ""
  if (type === "none") {
    delete obj.tool_choice
    suppressTools(obj)
  } else if (type === "auto" || type === "required") {
    obj.tool_choice = type
  } else if (type === "function") {
    const name = String(tc.function?.name ?? tc.name ?? "").trim()
    obj.tool_choice = name || "auto"
  } else {
    delete obj.tool_choice
  }
}

// suppressTools 清掉工具声明：上游用「有没有 tools」表达禁用，光删
// tool_choice 是无效的。
function suppressTools(obj) {
  delete obj.tools
  delete obj.functions
}

// normalizeTools 把每个工具的 parameters 从对象序列化成 JSON 字符串。
//
// 上游的 FunctionDefinition.parameters 是 string 类型，传对象直接 4001。
export function normalizeTools(obj) {
  if (!Array.isArray(obj.tools) || !obj.tools.length) return
  const out = []
  for (const t of obj.tools) {
    if (!t || typeof t !== "object") continue
    const fn = t.function
    if (!fn || typeof fn !== "object") continue
    if (fn.parameters && typeof fn.parameters === "object") fn.parameters = JSON.stringify(fn.parameters)
    out.push(t)
  }
  if (!out.length) delete obj.tools
  else obj.tools = out
}
