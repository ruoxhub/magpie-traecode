// 真链路 e2e：拿一份真实账号凭证，把插件的每条链路都跑一遍。
//
//   node scripts/e2e-live.mjs /path/to/account.json
//
// 凭证认两种形态（与插件的「粘贴 JSON 导入」同一套解析）：
//   - 扁平 {"accessToken","refreshToken","expiresAt","uid","machineId","deviceId","apiHost"}
//   - 嵌套 {"auth":{…},"account":{…}}（llm-api 渠道 key 的形态）
//
// 会花额度：默认只跑两个对话（一个非流式、一个带工具的流式），提示词与 max_tokens
// 都压到最小。签到只读状态，不 claim（claim 是不可逆的每日动作，要人手跑）。
//
// 输出不含令牌原文。

import { readFileSync } from "node:fs"

import { SITES } from "../lib/sites.mjs"
import { makePlugin } from "../lib/plugin.mjs"
import { ideInfo } from "../lib/version.mjs"
import { parseCredential, expiresOfJWT } from "../lib/oauth.mjs"
import { fetchModels } from "../lib/models.mjs"
import { entUsage, getCheckinStatus, deviceProfile, ugDeviceOf } from "../lib/account.mjs"

const path = process.argv[2]
if (!path) {
  console.error("用法: node scripts/e2e-live.mjs <凭证 JSON 路径>")
  process.exit(2)
}

const raw = readFileSync(path, "utf8")
const one = parseCredential(raw)
const flat = JSON.parse(raw)
const apiHost = String((flat.apiHost ?? flat.auth?.apiHost ?? "") || "").replace(/\/+$/, "")

const line = (k, v) => console.log(`${k.padEnd(30)} ${v}`)
const ok = (k, v) => line(`✔ ${k}`, v)
const bad = (k, v) => line(`✖ ${k}`, v)

// 账号形态（不含令牌）
line("uid", one.uid || "(空)")
line("nickname", one.nickname || "(空)")
line("domain", one.domain || "(空)")
line("apiHost(凭证)", apiHost || "(空)")
line("apiHost(站点默认)", SITES["trae-cn"].hosts.api)
line("deviceId 形状", `${one.deviceId.length} 位：${/^\d{15}$/.test(one.deviceId) ? "15 位数字（签到可用）" : "非 15 位数字（签到要用派生号）"}`)
const exp = one.expires || expiresOfJWT(one.access)
line("access 到期", exp ? `${new Date(exp).toISOString()}（${exp > Date.now() ? "有效" : "已过期"}）` : "未给")
line("refreshToken", one.refresh ? "有" : "无")
const ide = ideInfo(SITES["trae-cn"])
line(
  "请求头版本",
  `${ide.version} / code ${ide.code}（${
    ide.source === "local"
      ? `本机 IDE: ${ide.file}`
      : ide.source === "env"
        ? "环境变量"
        : ide.source === "network"
          ? "联网探测（本机未装 IDE）"
          : "内置常量（探测还没回来）"
  }）`,
)

// 站点：把对话域按凭证的 apiHost 覆盖（llm-api 的常量与真实账号可能不是同一个网关）
const siteOf = (host) => ({ ...SITES["trae-cn"], hosts: { ...SITES["trae-cn"].hosts, api: host } })
const auth = {
  type: "oauth",
  access: one.access,
  refresh: one.refresh,
  expires: exp,
  uid: one.uid,
  machineId: one.machineId,
  deviceId: one.deviceId,
  domain: one.domain || "trae.cn",
}
const getAuth = async () => auth
const client = { auth: { set: async () => {} } }

// ---- 1. 模型表：先探一下两个候选网关 ------------------------------------------
//
// 凭证里的 apiHost 是账号自己的网关（IDE 登录时写进去的），llm-api 的常量是 CN 的
// 默认网关。两边都可能应答，但凭证里那个可能是旧的：只用来探测、不用它发请求，
// 免得一个陈旧域名把本来能用的账号弄挂。
let site = siteOf(SITES["trae-cn"].hosts.api)
for (const host of [...new Set([SITES["trae-cn"].hosts.api, apiHost].filter(Boolean))]) {
  try {
    const list = await fetchModels(siteOf(host), one, { signal: AbortSignal.timeout(20000) })
    ok("模型表", `${host} → ${list.length} 个模型`)
    line("  前 3 个", list.slice(0, 3).map((m) => `${m.id}(${m.name}) ctx=${m.context} out=${m.output} rate=${m.rate ?? "?"}${m.images ? " 收图" : ""}${m.efforts.length ? ` 档位=${m.efforts.join("|")}` : ""}`).join("\n" + " ".repeat(34)))
    const withEffort = list.filter((m) => m.efforts.length)
    line("  声明档位", `${withEffort.length} 个${withEffort.length ? `，例：${withEffort[0].id} → ${withEffort[0].efforts.join("|")}（默认 ${withEffort[0].defaultEffort || "未声明"}）` : ""}`)
    line("  收图 / 工具", `${list.filter((m) => m.images).length} 个收图，${list.filter((m) => m.toolcall).length} 个支持工具`)
    line("  credits 倍数", `${list.filter((m) => typeof m.rate === "number").length} 个读到 rate，范围 ${Math.min(...list.filter((m) => typeof m.rate === "number").map((m) => m.rate))} ~ ${Math.max(...list.filter((m) => typeof m.rate === "number").map((m) => m.rate))}`)
  } catch (e) {
    bad("模型表", `${host} → ${e?.message ?? e}`)
  }
}

// ---- 2. 对话：非流式 ---------------------------------------------------------
const hooks = await makePlugin(site)({ client })
const loader = await hooks.auth.loader(getAuth)
const chat = async (body) => {
  const res = await loader.fetch("https://placeholder/chat/completions", {
    method: "POST",
    headers: { "x-magpie-session": "e2e-live" },
    body: JSON.stringify(body),
  })
  return res
}

let model = [...site.models][0]
try {
  const list = await fetchModels(site, one)
  if (list.length) model = list[0].id
} catch {
  // 用静态兜底
}
line("测试模型", model)
line("对话网关", site.hosts.api)

let nonStreamOK = false
try {
  const res = await chat({ model, stream: false, max_tokens: 32, messages: [{ role: "user", content: "只回复两个字：收到" }] })
  const text = await res.text()
  if (!res.ok) throw new Error(`HTTP ${res.status} ${text.slice(0, 300)}`)
  const body = JSON.parse(text)
  const msg = body.choices?.[0]?.message ?? {}
  ok("非流式对话", `content=${JSON.stringify((msg.content ?? "").slice(0, 40))} finish=${body.choices?.[0]?.finish_reason}`)
  line("  usage", JSON.stringify(body.usage ?? null))
  line("  reasoning", msg.reasoning_content ? `有（${String(msg.reasoning_content).length} 字）` : "无")
  nonStreamOK = true
} catch (e) {
  bad("非流式对话", e?.message ?? e)
}

// ---- 3. 对话：流式 + 工具 ----------------------------------------------------
try {
  const res = await chat({
    model,
    stream: true,
    stream_options: { include_usage: true },
    max_tokens: 64,
    messages: [{ role: "user", content: "用 read_file 读一下 a.txt 的内容，不要解释。" }],
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
  if (!res.ok) throw new Error(`HTTP ${res.status} ${(await res.text()).slice(0, 300)}`)
  const text = await res.text()
  const frames = text.split("\n\n").filter((f) => f.startsWith("data: "))
  const payloads = frames.map((f) => f.slice(6)).filter((p) => p !== "[DONE]")
  const chunks = payloads.map((p) => {
    try {
      return JSON.parse(p)
    } catch {
      return null
    }
  }).filter(Boolean)
  const content = chunks.map((c) => c.choices?.[0]?.delta?.content ?? "").join("")
  // 工具调用按 index 累加，与真实客户端（含 OpenAI SDK）一致：
  // 上游先发带 name 的一片，再发带 arguments 的一片
  const calls = []
  for (const c of chunks) {
    for (const tc of c.choices?.[0]?.delta?.tool_calls ?? []) {
      const i = Number.isFinite(tc.index) ? tc.index : 0
      const hit = calls.find((x) => x.index === i)
      if (!hit) calls.push({ index: i, id: tc.id ?? "", name: tc.function?.name ?? "", arguments: tc.function?.arguments ?? "" })
      else {
        if (tc.id) hit.id = tc.id
        if (tc.function?.name) hit.name = tc.function.name
        hit.arguments += tc.function?.arguments ?? ""
      }
    }
  }
  const reasoning = chunks.map((c) => c.choices?.[0]?.delta?.reasoning_content ?? "").join("")
  const finish = chunks.map((c) => c.choices?.[0]?.finish_reason).filter(Boolean).at(-1)
  const usage = chunks.map((c) => c.usage).filter(Boolean).at(-1)
  ok("流式对话", `${chunks.length} 片，finish=${finish}，[DONE]=${frames.at(-1) === "data: [DONE]"} `)
  line("  正文", JSON.stringify(content.slice(0, 40)))
  line("  思维链", reasoning ? `有（${reasoning.length} 字）` : "无")
  line("  工具调用", calls.length ? `${calls.length} 个：${calls.map((c) => `${c.name}${c.id ? `#${c.id.slice(0, 12)}` : ""}`).join(", ")} args=${JSON.stringify((calls[0].arguments ?? "").slice(0, 60))}` : "无（模型可能选择不调）")
  line("  usage", JSON.stringify(usage ?? null))
} catch (e) {
  bad("流式对话", e?.message ?? e)
}

// ---- 4. 账号域：签到状态（只读） + 积分 --------------------------------------
try {
  const profile = deviceProfile(one.uid)
  const own = ugDeviceOf(one.deviceId)
  if (own) profile.deviceId = own
  const status = await getCheckinStatus(site, one.access, profile)
  ok("签到状态", `checked_in=${status.checkedIn} did_checked_in=${status.didCheckedIn} enable=${status.enable} credits=${status.credits}`)
  line("  签到设备号", profile.deviceId)
} catch (e) {
  bad("签到状态", e?.message ?? e)
}

try {
  const u = await entUsage(site, { token: one.access, uid: one.uid, deviceId: one.deviceId })
  ok("积分", u.balance === "unlimited" ? "unlimited" : JSON.stringify(u.windows))
} catch (e) {
  bad("积分", e?.message ?? e)
}

console.log(`\n结论：${nonStreamOK ? "加密 + SOLO 头 + SSE → OpenAI 链路在真实账号上跑通" : "对话链路没通过，按上面的 ✖ 行排查"}`)
