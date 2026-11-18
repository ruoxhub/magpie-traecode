// magpie / OpenCode provider 插件本体：一个站点一份。
//
// 对话链路与 llm-api 的 internal/relay/channel/trae 逐段对应：
//
//	客户端 OpenAI 请求 → prepareBody 归一化 → AES-256-GCM 加密 → base64 作 body
//	→ POST {api}/api/agent/v3/llm_utils_chat（SOLO 请求头 + x-request-pin）
//	→ SOLO SSE → OpenAI chunk / 聚合消息
//
// 两个容易踩的点：
//   - 上游恒回 SSE，`stream` 字段被忽略。客户端要非流式时得由这里聚合，
//     否则会把一堆 SSE 文本当成 JSON 交给客户端。
//   - 上游业务错误走 event:error，不是 HTTP 状态码。吞掉它就只剩一个空流，
//     客户端永远等不到内容也看不到原因。

import { createHash, randomUUID } from "node:crypto"

import { prepareBody } from "./payload.mjs"
import { encryptBody } from "./crypto.mjs"
import { PROFILE, soloHeaders } from "./headers.mjs"
import { EP, SITES } from "./sites.mjs"
import { startIdeVersionRefresh } from "./version.mjs"
import { classify, classifyStreamError, errorOf } from "./errors.mjs"
import {
  SoloDecoder,
  Thoughts,
  aggregate,
  toolCallsOf,
  usageOf,
  chunkOf,
  completionOf,
} from "./sse.mjs"
import {
  startSignIn,
  exchangeToken,
  fetchUserInfo,
  parseCredential,
  cleanToken,
  expiresOfJWT,
  newDeviceIDs,
} from "./oauth.mjs"
import { fetchModels, staticModels, modelsFrom } from "./models.mjs"
import { entUsage, checkinOf } from "./account.mjs"

// EARLY_MS 是「请求前先刷新」的提前量：令牌剩余寿命不到这么多就先换掉。
const EARLY_MS = 60 * 1000
// LEAD_MS 是交给 magpie 的 auth.refreshLead：到期前这么久由 magpie 主动续期。
const LEAD_MS = 5 * 60 * 1000
// 模型清单缓存：上游模型表不常变，没必要每个请求都问一次。
const MODELS_TTL_MS = 5 * 60 * 1000

// 一次续期在各调用方之间共享：一个账号同时来多个请求，只花一次刷新令牌。
// 官方刷新会换发新的 refresh token，两个调用方同时花同一个就会有一个被拒。
const renewing = new Map()

const trimSlash = (s) => String(s ?? "").replace(/\/+$/, "")

// usable 判断一份存储的登录能不能用。
export function usable(auth) {
  if (!auth || auth.type !== "oauth") return false
  return !!(cleanToken(auth.access) || auth.refresh)
}

// expired 判断访问令牌是否临近到期。
export function expired(auth, now = Date.now()) {
  const exp = Number(auth?.expires)
  return Number.isFinite(exp) && exp > 0 && now >= exp - EARLY_MS
}

// account 把存储的登录归一化成请求要用的形态。
function account(auth) {
  return {
    access: cleanToken(auth.access),
    refresh: String(auth.refresh ?? ""),
    expires: Number(auth.expires) || 0,
    uid: String(auth.uid ?? ""),
    machineId: String(auth.machineId ?? auth.machine_id ?? ""),
    deviceId: String(auth.deviceId ?? auth.device_id ?? ""),
    domain: String(auth.domain ?? ""),
  }
}

// current 返回本次请求要用的账号，必要时续期。
async function current(site, client, auth) {
  const a = account(auth)
  if (!expired(a)) return a
  if (!a.refresh) {
    if (a.access) return a
    throw new Error(`${site.name} 的登录已失效，请重新登录`)
  }
  return renew(site, client, a)
}

// renew 花掉一次 refresh token，同一个 refresh 只花一次。
function renew(site, client, a) {
  const key = `${site.id}\n${a.refresh}`
  let step = renewing.get(key)
  if (!step) {
    step = (async () => {
      const got = await exchangeToken(site, a.refresh)
      const next = {
        ...a,
        access: got.access || a.access,
        refresh: got.refresh || a.refresh,
        // 上游可能不回传到期时间：0 不能覆盖已有的有效值，否则每个请求都会刷新
        expires: got.expires > 0 ? got.expires : a.expires,
      }
      try {
        // 只把变化过的字段写回：magpie 的 auth.set 是合并语义
        await client?.auth?.set?.({
          path: { id: site.id },
          body: {
            type: "oauth",
            access: next.access,
            refresh: next.refresh,
            expires: next.expires,
            uid: next.uid,
            machineId: next.machineId,
            deviceId: next.deviceId,
            domain: next.domain || site.webHost,
          },
        })
      } catch {
        // 保存失败不影响本次请求；下一次请求会再刷
      }
      return next
    })().finally(() => renewing.delete(key))
    renewing.set(key, step)
  }
  return step
}

// lapsedError 判断账号域的错误是不是「令牌不被认了」（与余额 / 签到接口的普通
// 故障区分开：只有前者值得先换一次令牌再重试）。
function lapsedError(e) {
  return /HTTP\s*(401|403)/.test(String(e?.message ?? e))
}

// withAuth 拿可用账号跑一次账号域调用；令牌失效时强制换一次再重试。
//
// 对 llm-api 的 RefreshKey（签到 401 重试）：续期与访问令牌的到期时间无关，
// 所以这里不看 expires，直接花一次 refresh token。
async function withAuth(site, client, auth, run) {
  const a = await current(site, client, auth)
  try {
    return { a, value: await run(a) }
  } catch (e) {
    if (!lapsedError(e)) throw e
    if (!a.refresh) {
      e.status = 401
      throw e
    }
    const next = await renew(site, client, a)
    try {
      return { a: next, value: await run(next) }
    } catch (e2) {
      if (lapsedError(e2)) e2.status = 401
      throw e2
    }
  }
}

// errorResponse 是给客户端 / magpie 看的错误响应。
//
// type 按状态码给：401 是登录问题、429 是额度/限频（客户端会据此退避重试）、
// 其余当上游错误。
function errorResponse(message, status, signIn) {
  const type = status === 401 ? "authentication_error" : status === 429 ? "rate_limit_error" : "api_error"
  return new Response(JSON.stringify({ error: { message, type } }), {
    status,
    headers: {
      "Content-Type": "application/json",
      ...(signIn ? { "X-Magpie-Sign-In": signIn } : {}),
    },
  })
}

// bodyText 把 fetch 的各种 body 形态读成字符串。
async function bodyText(init, req) {
  const body = init?.body ?? (req ? await req.clone().text() : undefined)
  if (body === undefined || body === null) return ""
  if (typeof body === "string") return body
  if (body instanceof ArrayBuffer) return new TextDecoder().decode(body)
  if (ArrayBuffer.isView(body)) return new TextDecoder().decode(body)
  if (typeof body.getReader === "function") return new Response(body).text()
  return String(body)
}

// makePlugin 为站点造一个插件函数。
export function makePlugin(site) {
  return async ({ client }) => {
    // 版本探测：本机装了 Trae IDE 就直接读它的版本，没装才去问上游的最新版本。
    // 放在插件装配时（不是请求路径上），失败就继续用内置常量。
    startIdeVersionRefresh(site, { mid: PROFILE.machineID })
    // 每个账号的模型清单缓存：uid → { at, list }
    const lists = new Map()
    return {
      config: async (config) => {
        config.provider ??= {}
        config.provider[site.id] ??= {}
        const p = config.provider[site.id]
        p.name ??= site.name
        p.npm ??= "@ai-sdk/openai-compatible"
        // 请求路径由 loader 重写成 llm_utils_chat，这里的路径只是给 AI SDK 拼 URL 用
        p.api ??= trimSlash(site.hosts.api)
        p.models = { ...modelsFrom(staticModels(site)), ...(p.models ?? {}) }
      },
      provider: {
        id: site.id,
        // 账号自己的清单，读不到就回落到静态清单（不把整个列表搞没）
        async models(provider, { auth } = {}) {
          if (!usable(auth)) return provider.models
          let a
          try {
            a = await current(site, client, auth)
          } catch {
            return provider.models
          }
          const cacheKey = a.uid || a.access
          const cached = lists.get(cacheKey)
          if (cached && Date.now() - cached.at < MODELS_TTL_MS) {
            return Object.fromEntries(cached.list.map((m) => [m.id, modelOf(provider, m)]))
          }
          try {
            const list = await fetchModels(site, a)
            if (!list.length) return provider.models
            lists.set(cacheKey, { at: Date.now(), list })
            if (lists.size > 32) lists.delete(lists.keys().next().value)
            return Object.fromEntries(list.map((m) => [m.id, modelOf(provider, m)]))
          } catch {
            return provider.models
          }
        },
      },
      auth: {
        provider: site.id,
        refreshLead: LEAD_MS,
        // magpie 到期前 LEAD_MS 主动续期
        refresh: async (auth) => {
          if (!usable(auth) || !auth.refresh) return undefined
          const got = await exchangeToken(site, auth.refresh)
          const out = {}
          if (got.access && got.access !== auth.access) out.access = got.access
          if (got.refresh && got.refresh !== auth.refresh) out.refresh = got.refresh
          if (got.expires > 0 && got.expires !== auth.expires) out.expires = got.expires
          return Object.keys(out).length ? out : undefined
        },
        async loader(getAuth) {
          const placeholder = site.id
          return {
            apiKey: placeholder,
            async fetch(input, init = {}) {
              const auth = await getAuth()
              if (!usable(auth)) {
                return errorResponse(`${site.name} 未登录，请先在 magpie 登录`, 401, "expired")
              }
              let a
              try {
                a = await current(site, client, auth)
              } catch (e) {
                return errorResponse(e?.message ?? String(e), 401, "expired")
              }
              const req = input instanceof Request ? input : null
              const text = await bodyText(init, req)
              let chat
              try {
                chat = JSON.parse(text)
              } catch {
                return errorResponse("只接受 chat/completions 的 JSON 请求体", 400)
              }
              if (!chat || typeof chat !== "object") {
                return errorResponse("只接受 chat/completions 的 JSON 请求体", 400)
              }
              // 客户端没说流式就按非流式处理（OpenAI 的缺省也是 false）：只有显式
              // stream:true 才给流，否则一个没带该字段的调用方会拿到一堆 SSE
              const wantsStream = chat.stream === true
              const includeUsage = chat?.stream_options?.include_usage === true
              const prepared = prepareBody(chat)
              // 会话与请求标识：Trae 按 session_id 把一次对话的多轮（工具结果回传、
              // 重试、换 function）归到一条用量记录里，不带它就每次都算一个新对话。
              // request_id 则是每个请求自己的（两个字段都是 llm_utils_chat 自己的）
              const sessionKey = a.uid || a.access
              const sessionId = conversationId({
                session: sessionHeader(init, req),
                account: sessionKey,
                messages: chat.messages,
              })
              prepared.request_id = randomUUID()
              if (sessionId) prepared.session_id = sessionId
              // 档位名：客户端说的是 low / xhigh，Trae 要的是 light / extra_high，
              // 两个名字表不同；模型表里读到的档位用来校验，上游没有的档位就不发
              translateEffort(prepared, lists.get(sessionKey)?.list?.find((m) => m.id === prepared.model))

              let enc
              try {
                enc = encryptBody(JSON.stringify(prepared))
              } catch (e) {
                return errorResponse(`请求体加密失败：${e?.message ?? String(e)}`, 500)
              }

              const headers = soloHeaders(a, { stream: true, site })
              headers["X-Request-Pin"] = enc.requestPin
              headers["X-Requested-At"] = enc.requestedAt

              let res
              try {
                res = await fetch(`${trimSlash(site.hosts.api)}${EP.chat}`, {
                  method: "POST",
                  headers,
                  body: enc.bodyBase64,
                  ...(init?.signal ? { signal: init.signal } : {}),
                })
              } catch (e) {
                return errorResponse(`${site.name} 连不上：${e?.message ?? String(e)}`, 502)
              }
              if (!res.ok) {
                const body = await res.text()
                const fail = classify(site, { status: res.status, ...errorOf(body) })
                return errorResponse(fail.message, fail.status, fail.signIn)
              }
              // 实测形态：HTTP 200 但回的是一段 JSON（错误写在里面）。不拦就会当成
              // 空流，客户端什么都收不到还以为是模型没说话。
              const contentType = res.headers.get("content-type") ?? ""
              if (contentType.includes("json") && !contentType.includes("event-stream")) {
                const body = await res.text()
                const fail = classify(site, { status: 200, ...errorOf(body) })
                return errorResponse(fail.message, fail.status, fail.signIn)
              }

              const ctx = { id: chunkID(), model: prepared.model, created: Math.floor(Date.now() / 1000) }
              if (!wantsStream) {
                // 上游只会给 SSE，客户端要一次性结果就由这里聚合
                const events = await readAll(res.body)
                let result
                try {
                  result = aggregate(events)
                } catch (e) {
                  const fail = classifyStreamError(site, e)
                  return errorResponse(fail.message, fail.status, fail.signIn)
                }
                return new Response(JSON.stringify(completionOf({ ...ctx, result, usage: result.usage })), {
                  status: 200,
                  headers: { "Content-Type": "application/json", "X-Magpie-Sign-In": "kept" },
                })
              }
              return new Response(sseStream(res.body, { ...ctx, includeUsage, site }), {
                status: 200,
                headers: { "Content-Type": "text/event-stream; charset=utf-8", "Cache-Control": "no-store", "X-Magpie-Sign-In": "kept" },
              })
            },
          }
        },
        async usage(getAuth) {
          const auth = await getAuth()
          if (!usable(auth)) return { error: "未登录", signIn: "kept" }
          try {
            const { value } = await withAuth(site, client, auth, (acc) =>
              entUsage(site, { token: acc.access, uid: acc.uid, deviceId: acc.deviceId }),
            )
            return { ...value, signIn: "kept" }
          } catch (e) {
            return { error: e?.message ?? String(e), signIn: e?.status === 401 ? "expired" : "kept" }
          }
        },
        // 签到端点只在 CN 上实测过，Global 不给这个钩子，界面就不会出现签到入口
        ...(site.checkin
          ? {
              async checkin(getAuth) {
                const auth = await getAuth()
                if (!usable(auth)) return { outcome: "failed", message: "未登录" }
                try {
                  const { value } = await withAuth(site, client, auth, (acc) =>
                    checkinOf(site, { token: acc.access, uid: acc.uid, deviceId: acc.deviceId }),
                  )
                  return value
                } catch (e) {
                  return { outcome: "failed", message: e?.message ?? String(e) }
                }
              },
            }
          : {}),
        methods: [
          {
            type: "oauth",
            label: `${site.name} 账号（浏览器登录）`,
            labels: { zh: `${site.name} 账号（浏览器登录）`, "zh-TW": `${site.name} 帳號（瀏覽器登入）` },
            authorize: async (_inputs, { signal } = {}) => {
              const started = await startSignIn(site, { signal })
              return {
                ...started,
                async callback() {
                  const got = await started.callback()
                  if (got.type !== "success") return got
                  return {
                    type: "success",
                    provider: site.id,
                    access: got.access,
                    refresh: got.refresh,
                    expires: got.expires,
                    accountId: got.accountId,
                    uid: got.uid,
                    machineId: got.machineId,
                    deviceId: got.deviceId,
                    domain: got.domain,
                    tokenType: "Cloud-IDE-JWT",
                    ...(got.enterpriseId ? { enterpriseId: got.enterpriseId } : {}),
                  }
                },
              }
            },
          },
          {
            type: "oauth",
            label: `${site.name} 粘贴 JSON 导入`,
            labels: { zh: `${site.name} 粘贴 JSON 导入`, "zh-TW": `${site.name} 貼上 JSON 匯入` },
            prompts: [
              {
                type: "text",
                key: "credential",
                message: `粘贴 ${site.name} 的登录 JSON（本插件导出的，或 llm-api 里这个渠道的 key，有 refreshToken 即可）`,
                validate: (v) => (String(v ?? "").trim() ? undefined : "请粘贴登录 JSON"),
              },
            ],
            authorize: async (inputs = {}) => {
              let one
              try {
                one = parseCredential(inputs.credential ?? inputs.account)
              } catch (e) {
                return { type: "failed", error: e?.message ?? String(e) }
              }
              // 两地是同一套令牌但不同区域的域：混用只会得到上游 401，所以当场拒
              if (!sameRegion(one.domain, site)) {
                return {
                  type: "failed",
                  error: `这份登录属于 ${one.domain}，与本站点 ${site.webHost} 不是同一个区；请用它对应的那个 provider`,
                }
              }
              const ids = one.machineId && one.deviceId ? { machineId: one.machineId, deviceId: one.deviceId } : newDeviceIDs()
              let access = one.access
              let refresh = one.refresh
              let expires = one.expires
              if (!access) {
                try {
                  const got = await exchangeToken(site, refresh)
                  access = got.access
                  refresh = got.refresh || refresh
                  expires = got.expires || expires
                } catch (e) {
                  return { type: "failed", error: `${site.name} 的 refreshToken 换不出新令牌：${e?.message ?? String(e)}` }
                }
              }
              // 验证令牌：GetUserInfo 能读出账号就说明可用（Go 侧同样用它确认身份）
              let who = { uid: one.uid, nickname: one.nickname, enterpriseId: one.enterpriseId }
              try {
                const got = await fetchUserInfo(site, access)
                who = {
                  uid: got.uid || one.uid,
                  nickname: got.nickname || one.nickname,
                  enterpriseId: got.enterpriseId || one.enterpriseId,
                }
              } catch (e) {
                // 401 说明令牌不可用，存进去只会每次请求都 401
                if (/HTTP 401|HTTP 403/.test(String(e?.message))) {
                  return { type: "failed", error: `${site.name} 不认这个令牌；可能已过期，或不是本站点（${site.webHost}）的` }
                }
                // 其他读不到（接口临时故障）不该拦住导入
              }
              return {
                type: "success",
                provider: site.id,
                access,
                refresh,
                expires: expires || expiresOfJWT(access),
                accountId: who.nickname || who.uid || site.name,
                uid: who.uid,
                machineId: ids.machineId,
                deviceId: ids.deviceId,
                domain: one.domain || site.webHost,
                tokenType: "Cloud-IDE-JWT",
                ...(who.enterpriseId ? { enterpriseId: who.enterpriseId } : {}),
              }
            },
          },
        ],
      },
    }
  }
}

// sameRegion 判断凭证里的 domain 是否属于本站点。
//
// 只在能确定它属于**另一个站点的域**时才拒：domain 可能是登录域（trae.cn /
// trae.com.cn）、也可能是网关域（mchost.guru），后一类不该被误伤。缺 domain 时
// 一律放行（只有令牌的导出常常不带）。
function sameRegion(domain, site) {
  const d = String(domain ?? "")
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/+$/, "")
  if (!d) return true
  if (d.includes(site.webHost.toLowerCase())) return true
  const others = Object.values(SITES).filter((s) => s.id !== site.id)
  return !others.some((s) => d.includes(s.webHost.toLowerCase()))
}

// chunkID 给每条响应一个 id（OpenAI 客户端只当作标识用）。
function chunkID() {
  return `chatcmpl-${Date.now()}${Math.floor(Math.random() * 1000)}`
}

// sessionHeader 读 magpie 告诉插件的会话名。
//
// 宿主的 unsaid 会把它从真正发出去的请求里去掉，所以这里自己读一份、
// 转成上游的 session_id，不会跟随请求头泄到上游。
function sessionHeader(init, req) {
  const fromInit = init?.headers ? new Headers(init.headers).get("x-magpie-session") : null
  return String(fromInit ?? req?.headers?.get?.("x-magpie-session") ?? "").trim().slice(0, 128)
}

// conversationId 给一次对话算一个稳定的 session_id。
//
// 有 magpie 的会话名就用它；没有就用「本对话的第一条用户消息」——Trae 按 session
// 归组用量，一个每次请求都新编的 id 会让一次用户发送（工具结果回传、重试、换
// function）在用量明细里变成好几条。带上账号，避开跨账号碰撞。
function conversationId({ session, account, messages }) {
  const who = String(account ?? "")
  if (session) return uuidOf(`magpie-trae-session|${who}|${session}`)
  const first = (Array.isArray(messages) ? messages : []).find((m) => m?.role === "user")
  const text = partText(first?.content).trim()
  return text ? uuidOf(`magpie-trae-first|${who}|${text}`) : ""
}

// uuidOf 把一段文本哈希成 UUID v4 的形状（上游这个字段原本就是 UUID）。
function uuidOf(s) {
  const b = Buffer.from(createHash("sha256").update(s).digest().subarray(0, 16))
  b[6] = (b[6] & 0x0f) | 0x40
  b[8] = (b[8] & 0x3f) | 0x80
  const h = b.toString("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20)}`
}

// partText 把一条消息的 content 读成纯文本（字符串或 content 数组都认）。
function partText(content) {
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""
  return content.map((p) => (typeof p === "string" ? p : typeof p?.text === "string" ? p.text : "")).join("")
}

// 客户端说的档位名 → Trae 自己的档位名（上一版插件实测的对应表）。
const TRAE_OF_LEVEL = { low: "light", medium: "medium", high: "high", xhigh: "extra_high", max: "max" }

// translateEffort 把客户端的 reasoning_effort 换成 Trae 认的名字。
//
// 两边的名字表不是同一套（low ↔ light、xhigh ↔ extra_high）。Trae 对一个模型没有
// 的档位是直接拒的，所以模型表里读到过档位时，翻完还不在里面的就不发 —— 不发比
// 发一个它不认的值安全。不知道模型档位时（表还没拉到）就只翻名字、原样发出。
function translateEffort(body, entry) {
  const asked = body.reasoning_effort ?? body.reasoningEffort
  if (typeof asked !== "string" || !asked.trim()) return
  const name = TRAE_OF_LEVEL[asked.trim().toLowerCase()] ?? asked.trim()
  const known = Array.isArray(entry?.traeOptions) ? entry.traeOptions : []
  if (known.length && !known.includes(name)) {
    delete body.reasoning_effort
    delete body.reasoningEffort
    return
  }
  body.reasoning_effort = name
  delete body.reasoningEffort
}

// readAll 把整条 SSE 读完并解析成事件列表。
async function readAll(upstream) {
  const decoder = new SoloDecoder()
  const events = []
  const reader = upstream.getReader()
  const td = new TextDecoder()
  for (;;) {
    const { done, value } = await reader.read()
    if (done) break
    events.push(...decoder.push(td.decode(value, { stream: true })))
  }
  events.push(...decoder.end())
  return events
}

// sseStream 把 SOLO 事件流翻译成 OpenAI 的 SSE。
//
// finish_reason 有工具调用时必须是 tool_calls，否则客户端不会去执行工具；上游没
// 发 done 就断流时也要收尾，否则客户端永远等在最后一片上。
function sseStream(upstream, { id, model, created, includeUsage, site }) {
  const decoder = new SoloDecoder()
  const td = new TextDecoder()
  // 客户端中途关掉时（用户按 Esc、客户端超时）要主动把上游流也取消：不取消就会
  // 接着把整个回答读完，白烧积分，也只会在下一个 enqueue 上才报错。
  let reader
  let closed = false
  return new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder()
      const send = (obj) => {
        if (closed) return
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(obj)}\n\n`))
        } catch {
          closed = true
        }
      }
      const sendDone = () => {
        if (closed) return
        try {
          controller.enqueue(enc.encode("data: [DONE]\n\n"))
        } catch {
          closed = true
        }
      }
      let sawToolCall = false
      let lastFinish = ""
      let usage
      let failed = false
      const thoughts = new Thoughts()

      const emit = (events) => {
        for (const ev of events) {
          if (ev.event === "thought" || ev.response || ev.reasoning || ev.toolCalls) {
            const calls = toolCallsOf(ev)
            if (calls.length) sawToolCall = true
            const content = ev.response ?? ""
            // 思维链会重复发（同一段连发两次 / 把「目前为止的全部」再发一遍）
            const reasoning = ev.reasoning ? thoughts.add(ev.reasoning) : ""
            if (!content && !reasoning && !calls.length) continue
            const delta = {}
            if (content) delta.content = content
            if (reasoning) delta.reasoning_content = reasoning
            if (calls.length) delta.tool_calls = calls
            send(chunkOf({ id, model, created, delta }))
          }
          if (ev.usage) usage = ev.usage
          if (ev.finishReason) lastFinish = ev.finishReason
          if (ev.event === "error") {
            // 上游业务错误（额度 / token 失效 / 参数无效）不能静默吞掉：
            // 否则客户端只收到一个空流。分类与 HTTP 层同一口径。
            failed = true
            const fail = classifyStreamError(site, ev)
            send({ error: { message: fail.message, type: fail.type, code: ev.errorCode || null } })
          }
        }
      }

      try {
        reader = upstream.getReader()
        for (;;) {
          const { done, value } = await reader.read()
          if (done) break
          if (closed) break
          emit(decoder.push(td.decode(value, { stream: true })))
          if (failed) break
        }
        if (!failed && !closed) emit(decoder.end())
      } catch (e) {
        if (!closed) {
          failed = true
          send({ error: { message: e?.message ?? String(e), type: "api_error" } })
        }
      }

      if (!failed) {
        const finish = sawToolCall ? "tool_calls" : lastFinish || "stop"
        send(chunkOf({ id, model, created, delta: {}, finishReason: finish }))
        if (includeUsage && usage) {
          send({ id, object: "chat.completion.chunk", created, model, choices: [], usage })
        }
      }
      sendDone()
      if (!closed) {
        try {
          controller.close()
        } catch {
          closed = true
        }
      }
    },
    async cancel(reason) {
      closed = true
      try {
        await reader?.cancel(reason)
      } catch {
        // 上游已经结束了：取消失败没什么可做的
      }
    },
  })
}

// modelOf 把一条模型清单项转成 models 钩子的条目。
function modelOf(provider, m) {
  const images = m.images === true
  return {
    id: m.id,
    providerID: provider.id,
    name: m.name || m.id,
    api: { id: m.id, url: provider.api ?? "" },
    status: "active",
    headers: {},
    options: {},
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: m.context ?? 0, output: m.output ?? 0 },
    capabilities: {
      temperature: true,
      reasoning: m.reasoning === true,
      attachment: images,
      toolcall: m.toolcall !== false,
      input: { text: true, image: images, audio: false, video: false, pdf: false },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    release_date: "",
    // 档位：上游声明了才有，名字用客户端认的那套（发请求时再翻回 Trae 的名字）
    variants: Object.fromEntries((Array.isArray(m.efforts) ? m.efforts : []).map((e) => [e, {}])),
    // magpie 自己的：credits 倍数（0 = 免费，路由会优先用）
    ...(m.rate === 0 ? { free: true } : {}),
    ...(typeof m.rate === "number" ? { rate: m.rate } : {}),
  }
}
