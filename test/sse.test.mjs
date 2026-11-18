import test from "node:test"
import assert from "node:assert/strict"

import { SoloDecoder, Thoughts, aggregate, chunkOf, completionOf, mergeToolCalls, parseEvent, toolCallsOf, usageOf } from "../lib/sse.mjs"
import { fakeChatStream } from "./fake.mjs"

test("解码器跨 chunk 边界也能拼出完整事件（上游分片不看行边界）", () => {
  const wire = fakeChatStream()
  const d = new SoloDecoder()
  const events = []
  // 每 3 个字符一片，故意切在 "event:" 与 JSON 中间
  for (let i = 0; i < wire.length; i += 3) events.push(...d.push(wire.slice(i, i + 3)))
  events.push(...d.end())
  assert.deepEqual(
    events.map((e) => e.event),
    ["output", "output", "token_usage", "done"],
  )
  assert.equal(events[0].reasoning, "想一想")
  assert.equal(events[1].response, "你好")
  assert.equal(events[3].completed, true)
})

test("token_usage：SOLO 的顶层 reasoning / 缓存计数要搬进 OpenAI 的嵌套字段", () => {
  const usage = usageOf({ prompt_tokens: 11, completion_tokens: 7, total_tokens: 18, reasoning_tokens: 3, cache_read_input_tokens: 5 })
  assert.equal(usage.prompt_tokens, 11)
  assert.equal(usage.completion_tokens, 7)
  assert.equal(usage.total_tokens, 18)
  assert.equal(usage.completion_tokens_details.reasoning_tokens, 3)
  assert.equal(usage.prompt_tokens_details.cached_tokens, 5)
  // 没有的字段不造
  assert.equal(usage.prompt_tokens_details.cached_creation_tokens, undefined)
})

test("thought 事件的正文在 thought 字段（create_agent_task 的兼容分支）", () => {
  const ev = parseEvent("thought", JSON.stringify({ thought: "正文", reasoning_content: "链" }))
  assert.equal(ev.response, "正文")
  assert.equal(ev.reasoning, "链")
})

test("坏 JSON 不抛错，返回 null（由解码器计坏行数）", () => {
  assert.equal(parseEvent("output", "{not json"), null)
})

test("tool_calls 转 OpenAI 形状：function_call → function，剔掉 namespace / partial_arguments", () => {
  const calls = toolCallsOf({
    toolCalls: [
      { id: "call_1", index: 0, function_call: { name: "read_file", arguments: '{"path":"a"}', namespace: "fs", partial_arguments: "x" } },
      { function: { name: "write_file", arguments: "{}" } },
      { id: "bad" },
    ],
  })
  assert.equal(calls.length, 2)
  assert.deepEqual(calls[0], { id: "call_1", type: "function", index: 0, function: { name: "read_file", arguments: '{"path":"a"}' } })
  assert.equal("namespace" in calls[0].function, false)
  assert.equal(calls[1].function.name, "write_file")
})

test("aggregate：正文/思维链/工具调用/用量/收尾原因都收进一条消息", () => {
  const wire = fakeChatStream({ withToolCall: true })
  const d = new SoloDecoder()
  const events = [...d.push(wire), ...d.end()]
  const result = aggregate(events)
  assert.equal(result.content, "你好")
  assert.equal(result.reasoning, "想一想")
  assert.equal(result.toolCalls.length, 1)
  assert.equal(result.toolCalls[0].function.name, "read_file")
  // 有工具调用时 finish_reason 必须是 tool_calls，否则客户端不会去执行工具
  assert.equal(result.finishReason, "tool_calls")
  assert.equal(result.usage.total_tokens, 18)
})

test("aggregate：上游 done 不带 finish_reason 时缺省 stop", () => {
  const d = new SoloDecoder()
  const events = [...d.push(`event: output\ndata: {"response":"好"}\n\nevent: done\ndata: {}\n\n`), ...d.end()]
  assert.equal(aggregate(events).finishReason, "stop")
})

test("aggregate：event:error 必须抛（否则客户端拿到空 content 毫无线索）", () => {
  const d = new SoloDecoder()
  const events = [...d.push(`event: error\ndata: {"code":1005,"message":"额度不足"}\n\n`), ...d.end()]
  assert.throws(() => aggregate(events), /额度不足/)
})

test("mergeToolCalls 按 index 拼接 arguments", () => {
  const acc = []
  mergeToolCalls(acc, [{ index: 0, id: "a", type: "function", function: { name: "read_file", arguments: '{"pa' } }])
  mergeToolCalls(acc, [{ index: 0, type: "function", function: { name: "read_file", arguments: 'th":"a"}' } }])
  assert.equal(acc.length, 1)
  assert.equal(acc[0].function.arguments, '{"path":"a"}')
})

test("事件名不只 output：message / delta / content 都算正文，字段也不一定叫 response", () => {
  const a = parseEvent("message", JSON.stringify({ content: "甲" }))
  assert.equal(a.response, "甲")
  const b = parseEvent("delta", JSON.stringify({ delta: { content: "乙" } }))
  assert.equal(b.response, "乙")
  const c = parseEvent("output_delta", JSON.stringify({ delta: { reasoning_content: "想" } }))
  assert.equal(c.reasoning, "想")
  // 驼峰事件名也能归一
  assert.equal(parseEvent("messageDelta", JSON.stringify({ content: "丙" })).response, "丙")
})

test("结束事件不只 done：response_done / stream_done 也算", () => {
  for (const name of ["done", "response_done", "stream_done"]) {
    const ev = parseEvent(name, JSON.stringify({ finish_reason: "max_tokens" }))
    assert.equal(ev.completed, true, name)
    // 上游自己的收尾词要归成 OpenAI 认的 length
    assert.equal(ev.finishReason, "length", name)
  }
})

test("finish_reason 归一：max_output_tokens / max_length → length，sensitive → content_filter", () => {
  assert.equal(parseEvent("done", JSON.stringify({ finish_reason: "max_output_tokens" })).finishReason, "length")
  assert.equal(parseEvent("done", JSON.stringify({ finish_reason: "sensitive" })).finishReason, "content_filter")
  assert.equal(parseEvent("done", JSON.stringify({ finish_reason: "weird" })).finishReason, "")
})

test("错误也可能挂在非 error 事件上（有 code/message 而没正文）", () => {
  const ev = parseEvent("output", JSON.stringify({ code: 1005, message: "额度不足" }))
  assert.equal(ev.errorCode, 1005)
  assert.match(ev.errorMessage, /额度不足/)
  // 有正文的 output 不能被当错误
  const ok = parseEvent("output", JSON.stringify({ response: "好", code: 0, message: "" }))
  assert.equal(ok.errorCode, undefined)
})

test("缓存口径：Anthropic 名字与 OpenAI 嵌套字段两条都发；没说缓存就标 unknown", () => {
  const withCache = usageOf({ prompt_tokens: 10, completion_tokens: 2, cache_read_input_tokens: 8, cache_creation_input_tokens: 4 })
  assert.equal(withCache.prompt_tokens_details.cached_tokens, 8)
  assert.equal(withCache.prompt_tokens_details.cache_write_tokens, 4)
  assert.equal(withCache.cache_read_input_tokens, 8)
  assert.equal(withCache.cache_creation_input_tokens, 4)
  assert.equal(withCache.magpie_cache_unknown, undefined)

  const openai = usageOf({ prompt_tokens: 10, prompt_tokens_details: { cached_tokens: 6 } })
  assert.equal(openai.prompt_tokens_details.cached_tokens, 6)

  // 压根没提缓存：打 unknown，别让 magpie 读成 0% 命中
  const silent = usageOf({ prompt_tokens: 10, completion_tokens: 2, total_tokens: 12 })
  assert.equal(silent.magpie_cache_unknown, true)

  // 提了但读写都是 0：同样是未知，而且不能写 cached_tokens: 0（会被当成 0% 命中）
  const zero = usageOf({ prompt_tokens: 1, cache_read_input_tokens: 0, cache_creation_input_tokens: 0 })
  assert.equal(zero.magpie_cache_unknown, true)
  assert.equal(zero.prompt_tokens_details, undefined)
})

test("工具调用是分片：name 在第一片、arguments 在第二片，空字段不能写进去", () => {
  // 真机帧（2026-11-18，llm_utils_chat，Doubao-Seed-2.1-Turbo）
  const first = toolCallsOf({
    toolCalls: [{ index: 0, id: "call_4xd4", type: "function", function_call: { name: "read_file", arguments: "", partial_arguments: null, namespace: null } }],
  })
  const second = toolCallsOf({
    toolCalls: [{ index: 0, id: "", type: "", function_call: { name: "", arguments: '{"path": "a.txt"}', partial_arguments: null, namespace: null } }],
  })
  assert.deepEqual(first, [{ id: "call_4xd4", type: "function", index: 0, function: { name: "read_file", arguments: "" } }])
  // 第二片不带空 name/type/id：带了会把累加器里的真名字覆盖成空串
  assert.deepEqual(second, [{ index: 0, function: { arguments: '{"path": "a.txt"}' } }])

  // 按 index 累加后是一次完整调用（非流式聚合走的就是这条）
  const acc = []
  mergeToolCalls(acc, first)
  mergeToolCalls(acc, second)
  assert.equal(acc.length, 1)
  assert.equal(acc[0].id, "call_4xd4")
  assert.equal(acc[0].function.name, "read_file")
  assert.equal(acc[0].function.arguments, '{"path": "a.txt"}')

  // 名字与参数都空的分片不是调用
  assert.deepEqual(toolCallsOf({ toolCalls: [{ index: 0, function_call: { name: "", arguments: "" } }] }), [])
})

test("Thoughts：同一段连发两次只发一次，重发「目前为止的全部」只发新增", () => {
  const th = new Thoughts()
  assert.equal(th.add("第一段思考"), "第一段思考")
  assert.equal(th.add("第一段思考"), "")
  assert.equal(th.add("第一段思考第二段"), "第二段")
  assert.equal(th.add("新的一段"), "新的一段")
})

test("aggregate：重复的思维链不会在非流式结果里出现两遍", () => {
  const d = new SoloDecoder()
  const wire =
    `event: output\ndata: {"reasoning_content":"想了很久的一段"}\n\n` +
    `event: output\ndata: {"reasoning_content":"想了很久的一段"}\n\n` +
    `event: output\ndata: {"response":"好"}\n\n`
  const result = aggregate([...d.push(wire), ...d.end()])
  assert.equal(result.reasoning, "想了很久的一段")
  assert.equal(result.content, "好")
})

test("非流式聚合出来的一次调用不带 index（那是流式分片的字段）", () => {
  const out = completionOf({
    id: "c1",
    model: "m",
    created: 1,
    result: {
      content: "",
      reasoning: "",
      toolCalls: [{ id: "call_1", type: "function", index: 0, function: { name: "read_file", arguments: '{"path":"a"}' } }],
      finishReason: "tool_calls",
    },
  })
  assert.deepEqual(out.choices[0].message.tool_calls, [
    { id: "call_1", type: "function", function: { name: "read_file", arguments: '{"path":"a"}' } },
  ])
  // 有工具调用时正文为 null（不是空串）
  assert.equal(out.choices[0].message.content, null)
})

test("chunkOf / completionOf 的字段形状", () => {
  const chunk = chunkOf({ id: "c1", model: "glm-5.2", created: 1, delta: { content: "你" } })
  assert.equal(chunk.object, "chat.completion.chunk")
  assert.equal(chunk.choices[0].delta.content, "你")
  assert.equal(chunk.choices[0].finish_reason, null)

  const done = chunkOf({ id: "c1", model: "glm-5.2", created: 1, delta: {}, finishReason: "stop" })
  assert.deepEqual(done.choices[0].delta, {})
  assert.equal(done.choices[0].finish_reason, "stop")

  const full = completionOf({
    id: "c1",
    model: "glm-5.2",
    created: 1,
    result: { content: "你好", reasoning: "想", toolCalls: [], finishReason: "stop" },
    usage: { total_tokens: 3 },
  })
  assert.equal(full.object, "chat.completion")
  assert.equal(full.choices[0].message.content, "你好")
  assert.equal(full.choices[0].message.reasoning_content, "想")
  assert.deepEqual(full.usage, { total_tokens: 3 })
})