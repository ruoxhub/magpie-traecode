import test from "node:test"
import assert from "node:assert/strict"

import { normalizeMessages, normalizeToolChoice, normalizeTools, prepareBody } from "../lib/payload.mjs"
import { CHAT_FUNCTION, DEFAULT_MODEL } from "../lib/sites.mjs"

const openaiBody = () => ({
  model: "glm-5.2",
  stream: false,
  messages: [
    { role: "system", content: "你是助手" },
    { role: "developer", content: "别啰嗦" },
    { role: "user", content: "读一下 a.txt" },
    {
      role: "assistant",
      content: null,
      tool_calls: [{ id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a.txt"}' } }],
    },
    { role: "tool", tool_call_id: "call_1", content: "内容" },
  ],
  tools: [
    {
      type: "function",
      function: {
        name: "read_file",
        description: "读文件",
        parameters: { type: "object", properties: { path: { type: "string" } }, required: ["path"] },
      },
    },
  ],
})

test("prepareBody：stream 置 true、function 置 chat_v3、model 与 config_name 同值", () => {
  const out = prepareBody(openaiBody())
  assert.equal(out.stream, true)
  assert.equal(out.function, CHAT_FUNCTION)
  assert.equal(out.model, "glm-5.2")
  assert.equal(out.config_name, "glm-5.2")
})

test("prepareBody：缺 model 时两边都落到默认模型", () => {
  const out = prepareBody({ messages: [] })
  assert.equal(out.model, DEFAULT_MODEL)
  assert.equal(out.config_name, DEFAULT_MODEL)
})

test("prepareBody 不改动调用方手里那份（客户端还要用它判断流式）", () => {
  const src = openaiBody()
  prepareBody(src)
  assert.equal(src.stream, false)
  assert.equal(typeof src.messages[0].content, "string")
  assert.equal(src.function, undefined)
})

test("prepareBody：stream_options 要删（上游不走 StreamOptions，usage 由插件补）", () => {
  const out = prepareBody({ model: "glm-5.2", stream_options: { include_usage: true }, messages: [] })
  assert.equal("stream_options" in out, false)
})

test("messages：content 字符串必须数组化，developer 降成 system", () => {
  const msgs = [
    { role: "developer", content: "规则" },
    { role: "user", content: "hi" },
    { role: "assistant", content: null },
  ]
  normalizeMessages(msgs)
  assert.equal(msgs[0].role, "system")
  assert.deepEqual(msgs[0].content, [{ type: "text", text: "规则" }])
  assert.deepEqual(msgs[1].content, [{ type: "text", text: "hi" }])
  // content 为 null 时保持原样：tool 结果与空 assistant 占位都靠它
  assert.equal(msgs[2].content, null)
})

test("assistant 的 tool_calls：function 改名 function_call，缺 name 的剔除", () => {
  const m = {
    role: "assistant",
    tool_calls: [
      { id: "a", function: { name: "read_file", arguments: "{}" } },
      { id: "b", function: { name: "  ", arguments: "{}" } },
      { id: "c", function_call: { name: "write_file", arguments: "{}" } },
    ],
  }
  normalizeMessages([m])
  assert.equal(m.tool_calls.length, 2)
  assert.equal(m.tool_calls[0].function_call.name, "read_file")
  assert.equal(m.tool_calls[0].function, undefined)
  assert.equal(m.tool_calls[1].function_call.name, "write_file")
})

test("全部 tool_calls 都没有 name 时整字段删掉（上游对缺 name 报 2001）", () => {
  const m = { role: "assistant", tool_calls: [{ id: "a", function: { arguments: "{}" } }] }
  normalizeMessages([m])
  assert.equal("tool_calls" in m, false)
})

test("tools：parameters 必须序列化成 JSON 字符串（传对象上游 4001）", () => {
  const obj = { tools: openaiBody().tools }
  normalizeTools(obj)
  assert.equal(typeof obj.tools[0].function.parameters, "string")
  assert.deepEqual(JSON.parse(obj.tools[0].function.parameters), {
    type: "object",
    properties: { path: { type: "string" } },
    required: ["path"],
  })
})

test("没有 tools 时不造空数组", () => {
  const obj = { tools: [] }
  normalizeTools(obj)
  assert.deepEqual(obj.tools, [])
  const obj2 = { tools: [{ type: "function" }] }
  normalizeTools(obj2)
  assert.equal("tools" in obj2, false)
})

test("tool_choice: none 必须连 tools 一起删（上游用有没有 tools 表达禁用）", () => {
  const obj = { tool_choice: "none", tools: openaiBody().tools }
  normalizeToolChoice(obj)
  assert.equal("tool_choice" in obj, false)
  assert.equal("tools" in obj, false)
})

test("tool_choice: auto / required 原样保留，具名降成 auto 字符串", () => {
  const auto = { tool_choice: { type: "auto" } }
  normalizeToolChoice(auto)
  assert.equal(auto.tool_choice, "auto")

  const required = { tool_choice: { type: "required" } }
  normalizeToolChoice(required)
  assert.equal(required.tool_choice, "required")

  const named = { tool_choice: { type: "function", function: { name: "read_file" } } }
  normalizeToolChoice(named)
  assert.equal(named.tool_choice, "read_file")

  const unknown = { tool_choice: { type: "whatever" } }
  normalizeToolChoice(unknown)
  assert.equal("tool_choice" in unknown, false)
})