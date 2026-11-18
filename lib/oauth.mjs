// 登录与续期：浏览器设备授权、粘贴凭证导入、refresh token 换 access。
//
// 端点与请求体对齐 llm-api 的 internal/relay/channel/trae/oauth.go：
//
//	授权页  {console}/authorization?…&client_id=<IDE 客户端>&auth_callback_url=http://127.0.0.1:<port>/authorize
//	换令牌  {oauth}/cloudide/api/v3/trae/oauth/ExchangeToken   {ClientID, RefreshToken, ClientSecret:"-", UserID:""}
//	账号    {oauth}/cloudide/api/v3/trae/GetUserInfo            {ReqSource:"IDE", IDEVersion}
//
// 授权页把 access / refresh / 账号信息用查询参数送回本机回调，这是它唯一接受的
// 回调形态（Go 侧固定 127.0.0.1:18080，这里换成临时端口，免得与本地已跑的
// llm-api 抢端口）。

import { createServer } from "node:http"
import { randomBytes } from "node:crypto"

import { EP } from "./sites.mjs"
import { PROFILE, oauthHeaders, randomHex } from "./headers.mjs"
import { ideInfo } from "./version.mjs"

// 等待浏览器授权的最长时间
const SIGN_IN_MS = 10 * 60 * 1000

// trimSlash 去掉结尾斜杠，避免拼出 https://host//path。
const trimSlash = (s) => String(s ?? "").replace(/\/+$/, "")

// startSignIn 起本机回调，返回授权地址与等待结果的方法。
//
// 设备标识在登录时生成并随账号保存：每次请求换一个新设备会被上游丢掉
// （Go 侧同样把 machineId / deviceId 存在凭证里）。
export function startSignIn(site, { signal } = {}) {
  const machineId = randomHex(16)
  const deviceId = randomHex(16)
  const trace = randomHex(8)
  let over = false
  let settle
  const done = new Promise((r) => (settle = r))
  const finish = (result) => {
    if (over) return
    over = true
    settle(result)
  }

  const server = createServer(async (req, res) => {
    // 授权页可能从脚本里调这个回调，也可能直接打开它
    const cors = {
      "Access-Control-Allow-Origin": "*",
      "Access-Control-Allow-Methods": "GET, OPTIONS",
      "Access-Control-Allow-Headers": "Content-Type",
    }
    if (req.method === "OPTIONS") return res.writeHead(204, cors).end()
    const url = new URL(req.url ?? "/", "http://127.0.0.1")
    const html = (body) => {
      res.writeHead(200, { ...cors, "Content-Type": "text/html; charset=utf-8", "Cache-Control": "no-store" })
      res.end(body)
    }
    if (url.pathname !== "/authorize") return res.writeHead(404, cors).end()
    if (over) return html(page(false, "这次登录已经结束", "请在 magpie 里重新发起登录。"))
    const q = url.searchParams
    if (q.get("error")) {
      const msg = q.get("error_description") || q.get("error")
      finish({ type: "failed", error: msg })
      return html(page(false, "登录没有完成", msg))
    }
    if (!q.get("userJwt") && !q.get("refreshToken")) {
      const msg = `${site.webHost} 没有回传令牌，请重新发起登录。`
      finish({ type: "failed", error: msg })
      return html(page(false, "登录没有完成", msg))
    }
    try {
      const signed = await signedIn(site, q, { machineId, deviceId })
      finish({ ...signed, type: "success" })
      html(page(true, "已登录", `${signed.accountId} 已登录，可以关闭这个标签页。`))
    } catch (e) {
      const msg = e?.message ?? String(e)
      finish({ type: "failed", error: msg })
      html(page(false, "登录没有完成", msg))
    }
  })

  const listening = new Promise((resolve, reject) => {
    server.once("error", reject)
    server.listen(0, "127.0.0.1", resolve)
  })
  // 回调端口不把宿主进程留住：真正活着的是 magpie / OpenCode 自己的事件循环，
  // 这个临时监听只是等一次浏览器跳转
  server.unref?.()

  const aborted = () => finish({ type: "failed", error: "登录已取消" })
  signal?.addEventListener?.("abort", aborted, { once: true })

  const timer = setTimeout(() => finish({ type: "failed", error: "登录超时" }), SIGN_IN_MS)
  timer.unref?.()
  done.then(() => {
    clearTimeout(timer)
    signal?.removeEventListener?.("abort", aborted)
    // 页面还要把结果画出来，端口晚一点再放
    setTimeout(() => server.close(), 5000).unref?.()
  })

  return listening.then(() => {
    const q = new URLSearchParams({
      login_version: "1",
      auth_from: "solo",
      login_channel: "native_ide",
      plugin_version: "2.3.62834",
      auth_type: "local",
      client_id: PROFILE.clientId,
      redirect: "0",
      login_trace_id: trace,
      auth_callback_url: `http://127.0.0.1:${server.address().port}/authorize`,
      machine_id: machineId,
      device_id: deviceId,
      x_device_id: deviceId,
      x_machine_id: machineId,
      x_device_brand: "PC",
      x_device_type: "PC",
      x_os_version: "1.0",
      x_app_version: ideInfo(site).version,
      x_app_type: "stable",
    })
    return {
      url: `${trimSlash(site.hosts.web)}/authorization?${q}`,
      instructions: `在浏览器里登录 ${site.name}（${site.webHost}）并允许授权，完成后这里会自动继续。`,
      method: "auto",
      callback: () => done,
    }
  })
}

// signedIn 把授权页回传的参数读成一份 magpie 账号。
async function signedIn(site, q, { machineId, deviceId }) {
  const jwt = parseJSON(q.get("userJwt")) ?? {}
  const info = parseJSON(q.get("userInfo")) ?? {}
  let access = cleanToken(jwt.Token ?? jwt.token ?? q.get("token") ?? "")
  let refresh = String(jwt.RefreshToken ?? jwt.refreshToken ?? q.get("refreshToken") ?? "")
  let expires = expiresOf(jwt.TokenExpireAt ?? jwt.tokenExpireAt) || expiresOfJWT(access)
  if (!access && refresh) {
    const got = await exchangeToken(site, refresh)
    access = got.access
    refresh = got.refresh || refresh
    expires = got.expires || expires
  }
  if (!access) throw new Error(`${site.webHost} 没有回传 access token`)
  let uid = String(info.UserID ?? info.userId ?? q.get("userId") ?? "")
  let nickname = String(info.ScreenName ?? info.screenName ?? "")
  let enterpriseId = String(info.EnterpriseID ?? info.enterpriseId ?? "")
  if (!uid || !nickname) {
    // 回调里没带账号信息时补一次 GetUserInfo；读不到就以令牌为准
    try {
      const who = await fetchUserInfo(site, access)
      uid = uid || who.uid
      nickname = nickname || who.nickname
      enterpriseId = enterpriseId || who.enterpriseId
    } catch {
      // 账号信息读不到不影响登录
    }
  }
  return {
    access,
    refresh,
    expires,
    uid,
    machineId,
    deviceId,
    domain: site.webHost,
    accountId: nickname || uid || site.name,
    ...(enterpriseId ? { enterpriseId } : {}),
  }
}

// exchangeToken 用 refresh token 换 access token（refresh 也会轮换）。
//
// 上游可能不回传到期时间（此时 expires 为 0），调用方不要拿 0 覆盖已有值。
export async function exchangeToken(site, refreshToken, { signal } = {}) {
  const url = `${trimSlash(site.hosts.oauth)}${EP.exchange}`
  const res = await fetch(url, {
    method: "POST",
    headers: oauthHeaders(),
    body: JSON.stringify({ ClientID: PROFILE.clientId, RefreshToken: refreshToken, ClientSecret: "-", UserID: "" }),
    signal: signal ?? AbortSignal.timeout(30000),
  })
  const text = await res.text()
  if (res.status >= 400) throw new Error(`${site.name} 换令牌失败：HTTP ${res.status} ${text.slice(0, 200)}`)
  let env = {}
  try {
    env = JSON.parse(text)
  } catch {
    throw new Error(`${site.name} 换令牌的响应读不出来（不是 JSON）`)
  }
  const r = env.Result ?? env.result ?? {}
  const access = cleanToken(r.Token ?? r.token ?? "")
  if (!access) throw new Error(`${site.name} 换令牌失败：响应里没有 Token`)
  const expires = secondsToMs(normalizeSeconds(r.TokenExpireAt ?? r.tokenExpireAt)) ||
    (Number.isFinite(Number(r.TokenExpireDuration)) && Number(r.TokenExpireDuration) > 0
      ? Date.now() + Number(r.TokenExpireDuration) * 1000
      : 0)
  return {
    access,
    refresh: cleanToken(r.RefreshToken ?? r.refreshToken ?? "") || refreshToken,
    expires,
  }
}

// fetchUserInfo 读账号信息（uid / 昵称 / 企业 ID）。
export async function fetchUserInfo(site, access, { signal } = {}) {
  const url = `${trimSlash(site.hosts.oauth)}${EP.userInfo}`
  const res = await fetch(url, {
    method: "POST",
    headers: { ...oauthHeaders(), "X-Cloudide-Token": access },
    body: JSON.stringify({ ReqSource: "IDE", IDEVersion: ideInfo(site).version }),
    signal: signal ?? AbortSignal.timeout(30000),
  })
  const text = await res.text()
  if (res.status >= 400) throw new Error(`${site.name} 的账号信息读不出来：HTTP ${res.status}`)
  let env = {}
  try {
    env = JSON.parse(text)
  } catch {
    return { uid: "", nickname: "", enterpriseId: "" }
  }
  const r = env.Result ?? env.result ?? {}
  return {
    uid: String(r.UserID ?? r.userId ?? ""),
    nickname: String(r.ScreenName ?? r.screenName ?? ""),
    enterpriseId: String(r.EnterpriseID ?? r.enterpriseId ?? ""),
  }
}

// parseCredential 解析粘贴进来的凭证 JSON。
//
// 兼容两种形态，与 Go 侧 Parse 一致：
//   嵌套 {"auth":{...},"account":{...}}   —— llm-api 渠道 key 的形态
//   扁平 {"accessToken":…,"uid":…}        —— 本插件导出的形态
//
// 所以 llm-api 里一个 trae 渠道的 key 可以原样粘进来。
export function parseCredential(raw) {
  let obj
  try {
    obj = JSON.parse(String(raw ?? "").trim())
  } catch {
    throw new Error("这段文本不是 JSON")
  }
  if (!obj || typeof obj !== "object") throw new Error("这段 JSON 不是一个对象")
  const nested = "auth" in obj && obj.auth && typeof obj.auth === "object"
  const a = nested ? obj.auth : obj
  const account = nested && obj.account && typeof obj.account === "object" ? obj.account : obj
  const access = cleanToken(a.accessToken ?? a.access_token ?? a.access ?? "")
  const refresh = String(a.refreshToken ?? a.refresh_token ?? a.refresh ?? "")
  if (!access && !refresh) throw new Error("这段文本里既没有 accessToken 也没有 refreshToken")
  return {
    access,
    refresh,
    expires: secondsToMs(normalizeSeconds(Number(a.expiresAt ?? a.expires_at ?? 0))) || expiresOfJWT(access),
    uid: String(account.uid ?? account.UserID ?? ""),
    nickname: String(account.nickname ?? account.ScreenName ?? ""),
    enterpriseId: String(account.enterpriseId ?? account.EnterpriseID ?? ""),
    machineId: String(a.machineId ?? a.machine_id ?? ""),
    deviceId: String(a.deviceId ?? a.device_id ?? ""),
    domain: String(a.domain ?? ""),
  }
}

// cleanToken 去掉令牌上可能带的方案前缀。
export function cleanToken(token) {
  return String(token ?? "")
    .trim()
    .replace(/^Cloud-IDE-JWT\s+/i, "")
    .replace(/^Bearer\s+/i, "")
    .trim()
}

// expiresOfJWT 从 JWT 的 exp 读到期时间（毫秒）。读不出来返回 0。
export function expiresOfJWT(access) {
  const parts = String(access ?? "").split(".")
  if (parts.length < 2) return 0
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"))
    return Number.isFinite(payload?.exp) && payload.exp > 0 ? payload.exp * 1000 : 0
  } catch {
    return 0
  }
}

// expiresOf 把上游的到期时间统一成毫秒。
export function expiresOf(value) {
  return secondsToMs(normalizeSeconds(Number(value) || 0))
}

// normalizeSeconds 把毫秒时间戳（约 1.7e12）归一化为秒（Go 侧 normalizeExpiresAt）。
export function normalizeSeconds(v) {
  const n = Number(v) || 0
  return n > 1e12 ? Math.floor(n / 1000) : n
}

// secondsToMs 秒 → 毫秒；0/负数保持 0。
export function secondsToMs(seconds) {
  const n = Number(seconds) || 0
  return n > 0 ? n * 1000 : 0
}

function parseJSON(text) {
  if (!text) return null
  try {
    const v = JSON.parse(text)
    return v && typeof v === "object" ? v : null
  } catch {
    return null
  }
}

// page 是回调页面的落款：浏览器里看到的一句话。
function page(ok, title, detail) {
  const color = ok ? "#1677ff" : "#d4380d"
  return `<!doctype html><meta charset="utf-8"><title>${escapeHTML(title)}</title>
<body style="font:15px/1.6 system-ui,-apple-system,'Segoe UI',sans-serif;margin:0;display:grid;place-items:center;height:100vh;background:#fafafa">
<div style="text-align:center;padding:32px 40px;background:#fff;border-radius:14px;box-shadow:0 6px 24px rgba(0,0,0,.08)">
<h1 style="margin:0 0 8px;font-size:20px;color:${color}">${escapeHTML(title)}</h1>
<p style="margin:0;color:#555;max-width:36em">${escapeHTML(detail)}</p>
</div></body>`
}

function escapeHTML(s) {
  return String(s).replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c])
}

// newDeviceIDs 给「导入的凭证没带设备」时用：生成一对并随账号保存。
export function newDeviceIDs() {
  return { machineId: randomBytes(16).toString("hex"), deviceId: randomBytes(16).toString("hex") }
}
