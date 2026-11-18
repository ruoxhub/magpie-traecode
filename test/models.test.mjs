import test from "node:test"
import assert from "node:assert/strict"

import { fetchModels, modelsFrom, modelsOf, staticModels } from "../lib/models.mjs"
import { SITES } from "../lib/sites.mjs"
import { startServer } from "./fake.mjs"

// 一份假上游的模型表：按 function 分组，混进要剔除的条目
const live = {
  function_configs: [
    {
      function: "chat_v3",
      config_info_list: [
        { config_name: "glm-5.2", display_config: { display_name: "GLM-5.2" } },
        { config_name: "kimi-k3", display_name: "Kimi K3" },
        // 关掉的
        { config_name: "dead-model", config_switch: false },
        // 对用户不可见
        { config_name: "hidden-model", is_invisible_to_user: true },
        // 不是对话类
        { config_name: "image-3.5", usage: "image_generation" },
        // 自建模型的内部名
        { config_name: "custom_model_123" },
        // 重名只留一个
        { config_name: "glm-5.2" },
        // 允许的 custom_model 用法
        { config_name: "my-tuned", usage: "custom_model" },
      ],
    },
    // 别的 function 的表不该混进来
    { function: "solo_agent", config_info_list: [{ config_name: "solo-only" }] },
  ],
}

test("modelsOf 按 Go 侧规则过滤：关掉的 / 不可见的 / 非对话 / custom_model_ 前缀 / 重名", () => {
  assert.deepEqual(
    modelsOf(live).map((m) => m.id),
    ["glm-5.2", "kimi-k3", "my-tuned"],
  )
})

test("modelsOf 读展示名，读不到就回落 config_name", () => {
  const list = modelsOf(live)
  assert.equal(list[0].name, "GLM-5.2")
  assert.equal(list[1].name, "Kimi K3")
  assert.equal(list[2].name, "my-tuned")
})

test("modelsOf 也认没有 function_configs 的老信封", () => {
  const list = modelsOf({ config_info_list: [{ config_name: "glm-5.3" }] })
  assert.equal(list.length, 1)
  assert.equal(list[0].id, "glm-5.3")
  assert.equal(list[0].name, "glm-5.3")
  assert.equal(list[0].reasoning, false)
  assert.equal(list[0].context, 0)
})

test("能力字段从真机条目里读：上下文 / 输出上限 / 收图 / 工具 / credits 倍数", () => {
  // 2026-11-18 真机 batch_get_detail_param 的响应形态（截取关键字段）
  const list = modelsOf({
    function_configs: [
      {
        function: "chat_v3",
        config_info_list: [
          {
            config_name: "Doubao-Seed-2.1-Turbo",
            context_window_tokens: { dev: 256000, max: 1000000 },
            model_detail_list: [{ max_tokens: 32000, prompt_max_tokens: 224000 }],
            display_config: { display_name: "Seed-2.1-Turbo", multimodal: true, model_capability: "chat_model" },
            display_contact_config: JSON.stringify({ consumption_rate: { enable: true, data: { rate: 0.2 } } }),
            extra_config: JSON.stringify({ native_function_call: true, parallel_tool_calling: false }),
            reasoning_effort_config: { default_level: "high", options: ["light", "high"], support_thinking: true },
          },
          {
            config_name: "no-tools",
            model_detail_list: [{ max_tokens: 8000 }],
            extra_config: JSON.stringify({ native_function_call: false }),
          },
          {
            config_name: "free-one",
            display_contact_config: JSON.stringify({ consumption_rate: { data: { rate: 0 } } }),
          },
        ],
      },
    ],
  })
  const turbo = list.find((m) => m.id === "Doubao-Seed-2.1-Turbo")
  assert.equal(turbo.context, 256000) // 普通对话走 dev，不是 max
  assert.equal(turbo.output, 32000)
  assert.equal(turbo.images, true)
  assert.equal(turbo.toolcall, true)
  assert.equal(turbo.rate, 0.2)
  assert.equal(turbo.reasoning, true)
  assert.equal(turbo.defaultEffort, "high")
  assert.deepEqual(turbo.efforts, ["low", "high"])

  assert.equal(list.find((m) => m.id === "no-tools").toolcall, false)
  assert.equal(list.find((m) => m.id === "free-one").rate, 0)
  // 条目完全没提 rate 时是未知（undefined），不能编成 0（0 等于免费）
  assert.equal(list.find((m) => m.id === "no-tools").rate, undefined)
})

test("modelsFrom 把能力映射到 config 的 models（含 rate / attachment / variants）", () => {
  const mapped = modelsFrom([
    { id: "a", name: "A", efforts: ["low", "high"], reasoning: true, context: 1000, output: 100, images: true, toolcall: true, rate: 0.5 },
    { id: "b", name: "B", efforts: [], reasoning: false, context: 0, output: 0, images: false, toolcall: false, rate: 0 },
  ])
  assert.deepEqual(mapped.a.limit, { context: 1000, output: 100 })
  assert.equal(mapped.a.attachment, true)
  assert.deepEqual(mapped.a.modalities.input, ["text", "image"])
  assert.deepEqual(Object.keys(mapped.a.variants), ["low", "high"])
  assert.equal(mapped.a.rate, 0.5)
  assert.equal(mapped.a.free, undefined)
  assert.equal(mapped.b.tool_call, false)
  assert.equal(mapped.b.free, true)
})

test("档位：上游声明了就报客户端的名字，同时记住 Trae 的原名", () => {
  const list = modelsOf({
    config_info_list: [
      { config_name: "glm-5.3", reasoning_effort_config: { options: ["light", "medium", "high", "extra_high", "max"] } },
      { config_name: "plain" },
      // 名字本构建认不出：当「没有档位」处理，不报半套
      { config_name: "weird", reasoning_effort_config: { options: ["turbo"] } },
    ],
  })
  assert.deepEqual(list[0].efforts, ["low", "medium", "high", "xhigh", "max"])
  assert.deepEqual(list[0].traeOptions, ["light", "medium", "high", "extra_high", "max"])
  assert.equal(list[0].reasoning, true)
  assert.equal(list[1].reasoning, false)
  assert.deepEqual(list[2].efforts, [])
})

test("fetchModels 打到 batch_get_detail_param，只问 chat_v3 一张表", async () => {
  const fake = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify(live))
  })
  try {
    const site = { ...SITES["trae-cn"], hosts: { ...SITES["trae-cn"].hosts, api: fake.base } }
    const list = await fetchModels(site, { access: "tok", uid: "42", machineId: "m", deviceId: "d" })
    assert.deepEqual(list.map((m) => m.id), ["glm-5.2", "kimi-k3", "my-tuned"])

    const req = fake.seen[0]
    assert.equal(req.url, "/api/ide/v1/batch_get_detail_param")
    assert.equal(req.headers.referer, `${fake.base}/api/ide/v1/batch_get_detail_param`)
    // 版本头与模型表绑定：缺一半就会出现「列表里有、一点就 4001」
    assert.equal(req.headers["x-ide-version-code"], "20261029")
    assert.equal(req.headers["x-ide-version"], "3.4.17")
    assert.equal(req.headers.authorization, "Cloud-IDE-JWT tok")
    assert.equal(req.headers["x-device-id"], "d")
    assert.equal(req.headers["x-machine-id"], "m")
    const body = JSON.parse(req.body)
    assert.deepEqual(body.functions, ["chat_v3"])
    assert.equal(body.show_custom_model, true)
  } finally {
    await fake.close()
  }
})

test("fetchModels 空表与 HTTP 错误都要抛（由调用方回落静态清单）", async () => {
  const empty = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ function_configs: [] }))
  })
  const bad = await startServer((_req, res) => {
    res.writeHead(500)
    res.end("boom")
  })
  try {
    const site = (base) => ({ ...SITES["trae-cn"], hosts: { ...SITES["trae-cn"].hosts, api: base } })
    await assert.rejects(() => fetchModels(site(empty.base), { access: "t" }), /是空的/)
    await assert.rejects(() => fetchModels(site(bad.base), { access: "t" }), /HTTP 500/)
  } finally {
    await empty.close()
    await bad.close()
  }
})

test("静态清单与静态 models 映射：不编上下文与思考档位", () => {
  const site = SITES["trae-cn"]
  const statics = staticModels(site)
  assert.equal(statics.length, site.models.length)
  const mapped = modelsFrom(statics)
  const one = mapped["glm-5.2"]
  assert.equal(one.tool_call, true)
  assert.equal(one.reasoning, false)
  assert.deepEqual(one.limit, { context: 0, output: 0 })
})