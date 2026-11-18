import test from "node:test"
import assert from "node:assert/strict"

import { makePlugin } from "../lib/plugin.mjs"
import { SITES } from "../lib/sites.mjs"
import { decryptBody } from "../lib/crypto.mjs"
import { fakeChatStream, readText, sse, startServer } from "./fake.mjs"

// siteAt 把站点的某几个域名指到假上游上（真实站点表不动）。
const siteAt = (hosts) => ({ ...SITES["trae-cn"], hosts: { ...SITES["trae-cn"].hosts, ...hosts } })

// client 是 magpie 给的客户端里插件用得到的那一小块。
function fakeClient() {
  const saved = []
  return { saved, auth: { set: async ({ body }) => saved.push(body) } }
}

const goodAuth = (over = {}) => ({
  type: "oauth",
  access: "tok-1",
  refresh: "ref-1",
  expires: Date.now() + 3600_000,
  uid: "u-1",
  machineId: "machine-1",
  deviceId: "device-1",
  domain: "trae.cn",
  ...over,
})

// loaderFor 走一遍真实插件的装配路径：makePlugin → auth.loader(getAuth) → fetch。
async function loaderFor(site, auth, client = fakeClient()) {
  const hooks = await makePlugin(site)({ client })
  const loader = await hooks.auth.loader(async () => auth)
  return { hooks, loader, client }
}

test("config 钩子：provider 名字 / npm / api / 静态模型", async () => {
  const hooks = await makePlugin(SITES["trae-cn"])({ client: fakeClient() })
  const config = { provider: {} }
  await hooks.config(config)
  const p = config.provider["trae-cn"]
  assert.equal(p.name, "Trae CN")
  assert.equal(p.npm, "@ai-sdk/openai-compatible")
  assert.equal(p.api, "https://api5-normal.mchost.guru")
  assert.ok(p.models["glm-5.2"])
  assert.equal(p.models["glm-5.2"].tool_call, true)
  assert.equal(hooks.auth.provider, "trae-cn")
  assert.equal(typeof hooks.provider.models, "function")
  assert.equal(typeof hooks.auth.checkin, "function") // CN 有签到
})

test("Global 不声明签到（端点没有实测依据）", async () => {
  const hooks = await makePlugin(SITES["trae-global"])({ client: fakeClient() })
  assert.equal(hooks.auth.checkin, undefined)
  const config = { provider: {} }
  await hooks.config(config)
  assert.equal(config.provider["trae-global"].name, "Trae Global")
})

test("对话请求真的被加密：解开后是归一化过的 llm_utils_chat 载荷", async () => {
  const fake = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.end(fakeChatStream())
  })
  try {
    const site = siteAt({ api: fake.base })
    const { loader } = await loaderFor(site, goodAuth())
    const res = await loader.fetch("https://api5-normal.mchost.guru/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "glm-5.2",
        stream: false, // 客户端说不要流式，上游仍然给流；这条路径必须由插件聚合
        messages: [
          { role: "developer", content: "别啰嗦" },
          { role: "user", content: "你好" },
        ],
        tools: [{ type: "function", function: { name: "f", parameters: { type: "object" } } }],
      }),
    })
    assert.equal(res.status, 200)
    assert.equal(res.headers.get("x-magpie-sign-in"), "kept")

    // 线上那份 body 是 base64 密文，用响应头里的 pin 与时间戳才解得开
    const req = fake.seen[0]
    assert.equal(req.url, "/api/agent/v3/llm_utils_chat")
    assert.match(req.headers["x-request-pin"], /^[0-9a-f]{16}$/)
    assert.match(req.headers["x-requested-at"], /^\d{10}$/)
    assert.equal(req.headers.authorization, "Cloud-IDE-JWT tok-1")
    assert.equal(req.headers["x-ide-version-code"], "20261029")
    assert.equal(req.headers["x-device-id"], "device-1")
    assert.equal(req.headers["x-machine-id"], "machine-1")
    assert.ok(!req.body.includes("你好"))

    const plain = JSON.parse(decryptBody(req.body, req.headers["x-request-pin"], req.headers["x-requested-at"]).toString("utf8"))
    assert.equal(plain.function, "chat_v3")
    assert.equal(plain.stream, true) // 上游恒回 SSE
    assert.equal(plain.model, "glm-5.2")
    assert.equal(plain.config_name, "glm-5.2")
    assert.equal(plain.messages[0].role, "system") // developer 降级
    assert.deepEqual(plain.messages[1].content, [{ type: "text", text: "你好" }])
    assert.equal(typeof plain.tools[0].function.parameters, "string")

    // 非流式：上游的 SSE 被聚合成一条 chat.completion
    const body = JSON.parse(await readText(res))
    assert.equal(body.object, "chat.completion")
    assert.equal(body.choices[0].message.content, "你好")
    assert.equal(body.choices[0].message.reasoning_content, "想一想")
    assert.equal(body.choices[0].finish_reason, "stop")
    assert.equal(body.usage.total_tokens, 18)
    assert.equal(body.usage.prompt_tokens_details.cached_tokens, 5)
  } finally {
    await fake.close()
  }
})

test("流式：SOLO 事件翻成 OpenAI chunk，工具调用时 finish_reason 是 tool_calls", async () => {
  const fake = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.end(fakeChatStream({ withToolCall: true }))
  })
  try {
    const { loader } = await loaderFor(siteAt({ api: fake.base }), goodAuth())
    const res = await loader.fetch("https://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "glm-5.2", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.headers.get("content-type"), "text/event-stream; charset=utf-8")
    const text = await readText(res)
    const frames = text
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => f.slice(6))
    assert.equal(frames.at(-1), "[DONE]")

    const chunks = frames.slice(0, -1).map((f) => JSON.parse(f))
    // 思维链与正文各一片
    assert.equal(chunks[0].choices[0].delta.reasoning_content, "想一想")
    assert.equal(chunks[1].choices[0].delta.content, "你好")
    // 工具调用是完整的一次调用（上游不分片）
    const call = chunks.find((c) => c.choices[0].delta.tool_calls)
    assert.equal(call.choices[0].delta.tool_calls[0].function.name, "read_file")
    // 收尾片带 finish_reason，且有工具调用时必须是 tool_calls
    const last = chunks.at(-1)
    assert.equal(last.choices[0].finish_reason, "tool_calls")
    assert.deepEqual(last.choices[0].delta, {})
  } finally {
    await fake.close()
  }
})

test("stream_options.include_usage 时在 [DONE] 前补一片 usage", async () => {
  const fake = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.end(fakeChatStream())
  })
  try {
    const { loader } = await loaderFor(siteAt({ api: fake.base }), goodAuth())
    const res = await loader.fetch("https://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        model: "glm-5.2",
        stream: true,
        stream_options: { include_usage: true },
        messages: [{ role: "user", content: "hi" }],
      }),
    })
    const frames = (await readText(res))
      .split("\n\n")
      .filter((f) => f.startsWith("data: "))
      .map((f) => f.slice(6))
    const usageFrame = frames.slice(0, -1).map((f) => JSON.parse(f)).find((c) => c.usage)
    assert.equal(usageFrame.choices.length, 0)
    assert.equal(usageFrame.usage.completion_tokens, 7)
  } finally {
    await fake.close()
  }
})

test("上游 event:error：额度类给 429，流式把错误写进流里", async () => {
  const quota = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.end(sse("error", { code: 1005, message: "额度不足" }))
  })
  try {
    const site = siteAt({ api: quota.base })
    const plain = await loaderFor(site, goodAuth())
    const res = await plain.loader.fetch("https://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "glm-5.2", stream: false, messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.status, 429) // 额度类（实测码表 4008/1005）
    const body = JSON.parse(await readText(res))
    assert.equal(body.error.type, "rate_limit_error")
    assert.match(body.error.message, /额度不足/)

    const streamed = await loaderFor(site, goodAuth())
    const sres = await streamed.loader.fetch("https://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "glm-5.2", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    const text = await readText(sres)
    assert.match(text, /"error"/)
    assert.match(text, /额度不足/)
    assert.match(text, /rate_limit_error/)
  } finally {
    await quota.close()
  }
})

test("令牌失效码 1001 / 20101 要说成「请重新登录」，而不是 502", async () => {
  const cn = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ code: 1001, message: "not logged in" }))
  })
  const global = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ code: 20101, message: "token invalid" }))
  })
  try {
    const cnSite = siteAt({ api: cn.base })
    const res = await (await loaderFor(cnSite, goodAuth())).loader.fetch("https://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get("x-magpie-sign-in"), "expired")
    assert.match(JSON.parse(await readText(res)).error.message, /重新登录/)

    // 20101 只有国际版会发：用 CN 站点表就不该被当失效
    const globalSite = { ...SITES["trae-global"], hosts: { ...SITES["trae-global"].hosts, api: global.base } }
    const gres = await (await loaderFor(globalSite, goodAuth())).loader.fetch("https://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(gres.status, 401)
  } finally {
    await cn.close()
    await global.close()
  }
})

test("上游 401：告诉客户端登录失效（不要让人以为要改配置）", async () => {
  const fake = await startServer((_req, res) => {
    res.writeHead(401)
    res.end("unauthorized")
  })
  try {
    const { loader } = await loaderFor(siteAt({ api: fake.base }), goodAuth())
    const res = await loader.fetch("https://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.status, 401)
    assert.equal(res.headers.get("x-magpie-sign-in"), "expired")
    assert.match(JSON.parse(await readText(res)).error.message, /重新登录/)
  } finally {
    await fake.close()
  }
})

test("未登录 / 请求体不是 JSON 都给出明确拒绝", async () => {
  const { loader } = await loaderFor(siteAt({}), { type: "oauth", access: "", refresh: "" })
  const res = await loader.fetch("https://x/chat/completions", { method: "POST", body: "{}" })
  assert.equal(res.status, 401)
  assert.match(JSON.parse(await readText(res)).error.message, /未登录/)

  const ok = await loaderFor(siteAt({ api: "http://127.0.0.1:1" }), goodAuth())
  const bad = await ok.loader.fetch("https://x/chat/completions", { method: "POST", body: "not json" })
  assert.equal(bad.status, 400)
})

test("令牌临近过期：请求前换一次，并把新的令牌写回 magpie", async () => {
  const api = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.end(fakeChatStream())
  })
  const oauth = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ Result: { Token: "fresh", RefreshToken: "ref-2", TokenExpireAt: 1900000000 } }))
  })
  try {
    const site = siteAt({ api: api.base, oauth: oauth.base })
    const client = fakeClient()
    const { loader } = await loaderFor(site, goodAuth({ access: "old", expires: Date.now() - 1000 }), client)
    const res = await loader.fetch("https://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.status, 200)
    // 请求用的是换出来的新令牌
    assert.equal(api.seen[0].headers.authorization, "Cloud-IDE-JWT fresh")
    assert.equal(oauth.seen.length, 1)
    assert.deepEqual(JSON.parse(oauth.seen[0].body).RefreshToken, "ref-1")
    // 新令牌与轮换后的 refresh 都写回去了
    assert.equal(client.saved.length, 1)
    assert.equal(client.saved[0].access, "fresh")
    assert.equal(client.saved[0].refresh, "ref-2")
    assert.equal(client.saved[0].expires, 1900000000000)
    // 设备标识与 uid 一路带着走
    assert.equal(client.saved[0].deviceId, "device-1")
    assert.equal(client.saved[0].uid, "u-1")
  } finally {
    await api.close()
    await oauth.close()
  }
})

test("provider.models：用账号的清单，拉取失败回落静态清单", async () => {
  const ok = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ function_configs: [{ function: "chat_v3", config_info_list: [{ config_name: "glm-5.3" }] }] }))
  })
  const bad = await startServer((_req, res) => {
    res.writeHead(500)
    res.end("boom")
  })
  try {
    const it = await loaderFor(siteAt({ api: ok.base }), goodAuth())
    const provider = { id: "trae-cn", api: ok.base, models: { "glm-5.2": { name: "glm-5.2" } } }
    const list = await it.hooks.provider.models(provider, { auth: goodAuth() })
    assert.deepEqual(Object.keys(list), ["glm-5.3"])
    assert.equal(list["glm-5.3"].providerID, "trae-cn")
    assert.equal(list["glm-5.3"].capabilities.toolcall, true)

    const down = await loaderFor(siteAt({ api: bad.base }), goodAuth())
    assert.deepEqual(await down.hooks.provider.models(provider, { auth: goodAuth() }), provider.models)
    // 没登录时不去打扰上游
    const anon = await loaderFor(siteAt({ api: ok.base }), { type: "oauth" })
    assert.deepEqual(await anon.hooks.provider.models(provider, { auth: { type: "oauth" } }), provider.models)
  } finally {
    await ok.close()
    await bad.close()
  }
})

test("没带 stream 字段时按非流式处理（OpenAI 的缺省也是 false）", async () => {
  const fake = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.end(fakeChatStream())
  })
  try {
    const { loader } = await loaderFor(siteAt({ api: fake.base }), goodAuth())
    const res = await loader.fetch("https://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({ messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.headers.get("content-type"), "application/json")
    const body = JSON.parse(await readText(res))
    assert.equal(body.object, "chat.completion")
  } finally {
    await fake.close()
  }
})

test("usage 碰上 401：先强制换一次令牌再重试，并把新令牌写回", async () => {
  let calls = 0
  const ug = await startServer((req, res) => {
    calls++
    // 拿旧令牌来的请求一律 401，换完令牌后才给数据
    if (/old/.test(req.headers.authorization ?? "")) {
      res.writeHead(401, { "Content-Type": "application/json" })
      return res.end(JSON.stringify({ code: 401, message: "请先登录" }))
    }
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        code: 0,
        user_entitlement_pack_list: [
          { expire_time: 1900000000, entitlement_base_info: { quota: { credits_limit: 10 } }, usage: { credits_amount: 1 } },
        ],
      }),
    )
  })
  const oauth = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ Result: { Token: "fresh", RefreshToken: "ref-2", TokenExpireAt: 1900000000 } }))
  })
  try {
    const site = { ...SITES["trae-cn"], hosts: { ...SITES["trae-cn"].hosts, ug: ug.base, oauth: oauth.base } }
    const client = fakeClient()
    const hooks = await makePlugin(site)({ client })
    // 令牌没到期但上游不认：正是 Go 的 RefreshKey（强制刷新）场景
    const usage = await hooks.auth.usage(async () => goodAuth({ access: "old" }))
    assert.equal(usage.windows.length, 1)
    assert.equal(usage.windows[0].limit, 10)
    assert.equal(calls, 2) // 401 一次，换令牌后成功一次
    assert.equal(client.saved.length, 1)
    assert.equal(client.saved[0].access, "fresh")
  } finally {
    await ug.close()
    await oauth.close()
  }
})

test("粘贴导入：别区的凭证要当场拒（两地令牌不通用）", async () => {
  const hooks = await makePlugin(SITES["trae-cn"])({ client: fakeClient() })
  const method = hooks.auth.methods.find((m) => m.label.includes("粘贴"))
  const res = await method.authorize({
    credential: JSON.stringify({ refreshToken: "r", domain: "trae.ai" }),
  })
  assert.equal(res.type, "failed")
  assert.match(res.error, /不是同一个区/)

  // 网关域 / 登录域 / 没带 domain 都不该被误伤：这些要到换令牌那一步才失败
  const offline = await makePlugin(siteAt({ oauth: "http://127.0.0.1:1" }))({ client: fakeClient() })
  const importOf = offline.auth.methods.find((m) => m.label.includes("粘贴"))
  for (const domain of ["mchost.guru", "api.trae.com.cn", ""]) {
    const r = await importOf.authorize({ credential: JSON.stringify({ refreshToken: "r", domain }) })
    assert.equal(r.type, "failed")
    assert.match(r.error, /换不出新令牌/)
  }
})

test("客户端中途断开时取消上游流（否则会接着烧积分）", async () => {
  let cancelled = false
  let pushed = 0
  // 一条永不结束的上游流：只有被取消才会停
  const upstream = new ReadableStream({
    pull(c) {
      pushed++
      c.enqueue(new TextEncoder().encode(sse("output", { response: `片${pushed}` })))
    },
    cancel() {
      cancelled = true
    },
  })
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => new Response(upstream, { status: 200, headers: { "Content-Type": "text/event-stream" } })
  try {
    const { loader } = await loaderFor(siteAt({ api: "http://upstream.invalid" }), goodAuth())
    const res = await loader.fetch("https://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({ model: "glm-5.2", stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    const reader = res.body.getReader()
    await reader.read() // 先收一片，证明流真的在跑
    await reader.cancel()
    // 取消要传到上游
    for (let i = 0; i < 20 && !cancelled; i++) await new Promise((r) => setTimeout(r, 5))
    assert.equal(cancelled, true)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("请求体带 session_id / request_id：同一次对话的多次请求归到一条用量记录", async () => {
  const fake = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.end(fakeChatStream())
  })
  try {
    const site = siteAt({ api: fake.base })
    const { loader } = await loaderFor(site, goodAuth())
    const body = (messages) =>
      JSON.stringify({ model: "glm-5.2", stream: false, messages })
    const headers = { "x-magpie-session": "sess-42" }
    await loader.fetch("https://x/chat/completions", { method: "POST", headers, body: body([{ role: "user", content: "第一句" }]) })
    await loader.fetch("https://x/chat/completions", { method: "POST", headers, body: body([{ role: "user", content: "第二句" }]) })

    const first = JSON.parse(decryptBody(fake.seen[0].body, fake.seen[0].headers["x-request-pin"], fake.seen[0].headers["x-requested-at"]).toString())
    const second = JSON.parse(decryptBody(fake.seen[1].body, fake.seen[1].headers["x-request-pin"], fake.seen[1].headers["x-requested-at"]).toString())
    // 同一会话 → 同一个 session_id；但 request_id 每个请求自己的
    assert.equal(first.session_id, second.session_id)
    assert.match(first.session_id, /^[0-9a-f-]{36}$/)
    assert.notEqual(first.request_id, second.request_id)

    // 没给会话头时退到「本对话的第一条用户消息」：同一句话还是同一个 session
    const noHeader = await loaderFor(site, goodAuth())
    const same = body([{ role: "user", content: "第一句" }, { role: "assistant", content: "好" }, { role: "user", content: "变了" }])
    await noHeader.loader.fetch("https://x/chat/completions", { method: "POST", body: same })
    const derived = JSON.parse(decryptBody(fake.seen[2].body, fake.seen[2].headers["x-request-pin"], fake.seen[2].headers["x-requested-at"]).toString())
    assert.match(derived.session_id, /^[0-9a-f-]{36}$/)
  } finally {
    await fake.close()
  }
})

test("HTTP 200 但回的是 JSON（错误写在里面）：要当错误，不能当空流", async () => {
  const fake = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ code: 4001, message: "config item is empty" }))
  })
  try {
    const { loader } = await loaderFor(siteAt({ api: fake.base }), goodAuth())
    const res = await loader.fetch("https://x/chat/completions", {
      method: "POST",
      body: JSON.stringify({ stream: true, messages: [{ role: "user", content: "hi" }] }),
    })
    assert.equal(res.status, 502) // 认不出的业务码：上游原话透传
    assert.match(JSON.parse(await readText(res)).error.message, /config item is empty/)
  } finally {
    await fake.close()
  }
})

test("档位名要翻：客户端说 xhigh，上游要 extra_high；上游没的档位就不发", async () => {
  const fake = await startServer((req, res) => {
    if (req.url.includes("batch_get_detail_param")) {
      res.writeHead(200, { "Content-Type": "application/json" })
      return res.end(
        JSON.stringify({
          function_configs: [
            {
              function: "chat_v3",
              config_info_list: [
                { config_name: "glm-5.2", reasoning_effort_config: { options: ["light", "medium", "high", "extra_high"] } },
              ],
            },
          ],
        }),
      )
    }
    res.writeHead(200, { "Content-Type": "text/event-stream" })
    res.end(fakeChatStream())
  })
  try {
    const site = siteAt({ api: fake.base })
    const { hooks, loader } = await loaderFor(site, goodAuth())
    // 先让插件把模型表读进缓存（真实链路里由 provider.models 触发）
    await hooks.provider.models({ id: "trae-cn", api: fake.base, models: {} }, { auth: goodAuth() })

    const chat = async (effort) => {
      await loader.fetch("https://x/chat/completions", {
        method: "POST",
        body: JSON.stringify({ model: "glm-5.2", stream: false, reasoning_effort: effort, messages: [{ role: "user", content: "hi" }] }),
      })
      const last = fake.seen.filter((s) => s.url.includes("llm_utils_chat")).at(-1)
      return JSON.parse(decryptBody(last.body, last.headers["x-request-pin"], last.headers["x-requested-at"]).toString())
    }
    assert.equal((await chat("xhigh")).reasoning_effort, "extra_high")
    assert.equal((await chat("low")).reasoning_effort, "light")
    assert.equal((await chat("medium")).reasoning_effort, "medium")
    // 模型没声明的档位：不发（上游会拒）
    assert.equal("reasoning_effort" in (await chat("max")), false)
  } finally {
    await fake.close()
  }
})

test("usage / checkin 钩子：读积分包与签到都走账号域", async () => {
  const fake = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    if (req.url.endsWith("/status")) return res.end(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }))
    if (req.url.endsWith("/claim")) return res.end(JSON.stringify({ code: 0 }))
    if (req.url.endsWith("/ide_user_ent_usage"))
      return res.end(
        JSON.stringify({
          code: 0,
          user_entitlement_pack_list: [
            {
              expire_time: 1900000000,
              entitlement_base_info: { quota: { credits_limit: 500 } },
              usage: { credits_amount: 125 },
            },
          ],
        }),
      )
    res.writeHead(404).end()
  })
  try {
    const { hooks } = await loaderFor(siteAt({ ug: fake.base }), goodAuth())
    const usage = await hooks.auth.usage(async () => goodAuth())
    assert.equal(usage.signIn, "kept")
    assert.equal(usage.windows.length, 1)
    assert.equal(usage.windows[0].limit, 500)
    assert.equal(usage.windows[0].amount, 125)
    assert.equal(usage.windows[0].display, "125 / 500")

    const checkin = await hooks.auth.checkin(async () => goodAuth())
    assert.equal(checkin.outcome, "claimed")
  } finally {
    await fake.close()
  }
})