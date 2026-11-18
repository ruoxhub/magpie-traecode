// 账号域：签到与积分，对齐 llm-api 的
// internal/relay/channel/trae/credit.go。
//
// 这一组走 api.trae.cn 上的 /trae/api/v2/…，用 VSCode 那套身份头，与对话那套
// （api5-normal.mchost.guru + Cloud-IDE-JWT + SOLO 头）不是同一条通道。
//
// 设备指纹是确定性的：同一个账号每次都派生同一个 device_id / market_user_id /
// session_id（对齐 Go 侧 GetDeviceProfile 与 TraeWorkAssistant 的 auto_checkin.py）。
// 随机设备会被上游按「当前设备今日已签到」(9095) 拒掉。

import { createHash } from "node:crypto"
import { gunzipSync } from "node:zlib"

import { EP } from "./sites.mjs"
import { ugHeaders } from "./headers.mjs"

const trimSlash = (s) => String(s ?? "").replace(/\/+$/, "")

// be32 写大端 4 字节整数（seededStream 的分块序号）。
function be32(n) {
  const b = Buffer.alloc(4)
  b.writeUInt32BE(n >>> 0, 0)
  return b
}

// seededStream 用 SHA-256 派生确定性字节流（对齐 auto_checkin.py 的 _seeded_stream）。
export function seededStream(seed, salt, nbytes) {
  const data = Buffer.from(`${salt}:${seed}`, "utf8")
  const out = []
  let len = 0
  for (let i = 0; len < nbytes; i++) {
    const h = createHash("sha256").update(data).update(be32(i)).digest()
    out.push(h)
    len += h.length
  }
  return Buffer.concat(out).subarray(0, nbytes)
}

// randDigits 生成 n 位数字串；给 seed 时确定性派生。
export function randDigits(n, seed) {
  if (!seed) {
    const b = Buffer.alloc(n)
    for (let i = 0; i < n; i++) b[i] = 0x30 + Math.floor(Math.random() * 10)
    return b.toString("latin1")
  }
  const bs = seededStream(seed, "devid", n + 1)
  const b = Buffer.alloc(n)
  for (let i = 0; i < n; i++) b[i] = 0x30 + (bs[i] % 10)
  return b.toString("latin1")
}

// randHex 生成 n 位 hex 串；给 seed 时确定性派生。
export function randHex(n, seed) {
  if (!seed) {
    return Array.from({ length: Math.ceil(n / 2) }, () => Math.floor(Math.random() * 256).toString(16).padStart(2, "0")).join("").slice(0, n)
  }
  return seededStream(seed, "sess", Math.ceil(n / 2)).toString("hex").slice(0, n)
}

// genMarketUUID 生成 UUID v4；给 seed 时确定性派生。
export function genMarketUUID(seed) {
  const bs = seed ? Buffer.from(seededStream(seed, "market", 16)) : Buffer.from(Array.from({ length: 16 }, () => Math.floor(Math.random() * 256)))
  bs[6] = (bs[6] & 0x0f) | 0x40
  bs[8] = (bs[8] & 0x3f) | 0x80
  const h = bs.toString("hex")
  return `${h.slice(0, 8)}-${h.slice(8, 12)}-${h.slice(12, 16)}-${h.slice(16, 20)}-${h.slice(20, 32)}`
}

// deviceProfile 是签到要的设备指纹。同一个 seed（账号 uid）永远得到同一套。
export function deviceProfile(seed = "") {
  return {
    deviceId: randDigits(15, seed),
    marketUserId: genMarketUUID(seed),
    sessionId: randHex(64, seed),
  }
}

// ugDeviceOf 把账号的对话设备号换成签到/积分能用的那个。
//
// 实测（上一版插件，plugins#709）：签到这个口子只收 **15 位纯数字**。用 16 位或
// 登录时那个 32 位 hex 的对话设备号去 claim，会被 9074（当前设备频控）拒；同一账号
// 同一秒换个 15 位数字就过。所以这里只在账号设备号本来就是 15 位数字时才用它，
// 其余一律用从 uid 派生的那个（稳定、不轮换）。
export function ugDeviceOf(deviceId) {
  const id = String(deviceId ?? "")
  return /^\d{15}$/.test(id) ? id : ""
}

// extractUserID 从 JWT payload 里取账号 id（不校验签名，对齐 Go 侧 ExtractUserID）。
export function extractUserID(token) {
  const parts = String(token ?? "")
    .trim()
    .replace(/^Cloud-IDE-JWT\s+/i, "")
    .replace(/^Bearer\s+/i, "")
    .split(".")
  if (parts.length < 2) return ""
  try {
    const payload = JSON.parse(Buffer.from(parts[1].replace(/-/g, "+").replace(/_/g, "/"), "base64").toString("utf8"))
    return String(payload?.data?.id ?? payload?.auth_id ?? payload?.sub ?? "")
  } catch {
    return ""
  }
}

// ugPost 发签到 / 积分类请求，返回解析后的响应体。
export async function ugPost(site, path, { token, profile, body = "{}", signal } = {}) {
  const res = await fetch(`${trimSlash(site.hosts.ug)}${path}`, {
    method: "POST",
    headers: ugHeaders({ token, profile: profile ?? deviceProfile("") }),
    body,
    signal: signal ?? AbortSignal.timeout(20000),
  })
  const buf = Buffer.from(await res.arrayBuffer())
  // 上游偶尔在缺 Content-Encoding 时也回 gzip（魔数 1f 8b），Go 侧有同样的兜底
  const text = buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b ? gunzipSync(buf).toString("utf8") : buf.toString("utf8")
  if (res.status >= 400) throw new Error(`${site.name}：HTTP ${res.status} ${text.slice(0, 120)}`)
  try {
    return JSON.parse(text)
  } catch {
    throw new Error(`${site.name} 的响应不是 JSON`)
  }
}

// shift 读 code/message：这一段的上游有两种信封（顶层与 data 里）。
function codeOf(env) {
  const code = env?.code !== undefined ? Number(env.code) : env?.data?.code !== undefined ? Number(env.data.code) : 0
  const message = String(env?.message ?? env?.data?.message ?? env?.msg ?? "")
  return { code: Number.isFinite(code) ? code : 0, message }
}

// getCheckinStatus 查签到状态。
export async function getCheckinStatus(site, token, profile, { signal } = {}) {
  const env = await ugPost(site, EP.checkinStatus, { token, profile, body: "{}", signal })
  const { code, message } = codeOf(env)
  if (code !== 0) throw new Error(`${site.name} 的签到状态读不出来：${message || `code ${code}`}`)
  const d = env?.data && typeof env.data === "object" ? env.data : env
  return {
    checkedIn: d.checked_in === true,
    didCheckedIn: d.did_checked_in === true,
    credits: Number(d.credits) || 0,
    extraCredits: Number(d.extra_credits) || 0,
    enable: d.enable === true,
  }
}

// isRetryable 判断签到失败能不能换设备重试（同设备当日限制与频控）。
export function isRetryable(code, message) {
  if (code === 9095 || code === 9074) return true
  return ["当前设备", "参与用户太多", "过于频繁", "稍后再试"].some((s) => String(message).includes(s))
}

// claimCheckin 执行签到；遇到同设备 / 频控换一套新设备重试（最多两次）。
//
// delay 是退避函数，测试里换成空实现。
export async function claimCheckin(site, token, profile, { signal, retry = 0, delay } = {}) {
  const env = await ugPost(site, EP.checkinClaim, { token, profile, body: "{}", signal })
  const { code, message } = codeOf(env)
  if (code === 0) return { ok: true }
  if (isRetryable(code, message) && retry < 2) {
    const wait = delay ?? ((ms) => new Promise((r) => setTimeout(r, ms)))
    await wait((retry + 1) * 600)
    return claimCheckin(site, token, deviceProfile(""), { signal, retry: retry + 1, delay })
  }
  return { ok: false, message: message || `code ${code}` }
}

// checkinOf 跑一次签到，返回 magpie 的 checkin 钩子要的
// { outcome, credit?, message? }。
//
// outcome 取值：claimed（刚签到）、done（今天已在）、inactive（活动没开）、
// failed。先读状态再决定要不要真签到 —— 直接 claim 会在已签到时拿到 9095。
export async function checkinOf(site, { token, uid, deviceId } = {}, { signal, delay } = {}) {
  const seed = uid || extractUserID(token)
  let profile = deviceProfile(seed)
  const own = ugDeviceOf(deviceId)
  if (own) profile = { ...profile, deviceId: own }

  let status
  try {
    status = await getCheckinStatus(site, token, profile, { signal })
  } catch (e) {
    // 状态读不到不影响签到：预检失败仍尝试 claim（Go 侧同样容错）
    status = null
  }
  if (status) {
    if (status.checkedIn) return { outcome: "done", message: "今日已签到", ...(status.credits > 0 ? { credit: status.credits } : {}) }
    if (!status.enable) return { outcome: "inactive", message: "签到活动未开启" }
    // 当前设备今天已被用过：提前换一套干净设备，别等 9095
    if (status.didCheckedIn) profile = deviceProfile("")
  }

  const claimed = await claimCheckin(site, token, profile, { signal, delay })
  if (!claimed.ok) return { outcome: "failed", message: claimed.message }
  return { outcome: "claimed", message: "签到成功" }
}

// entUsage 读积分包的用量，返回 magpie 的 usage 卡窗口。
//
// 口径对齐 Go 侧 UserEntUsage：只算未过期（expire_time 或 end_time）且还有剩余的
// 积分包；过期包不计入。这里同时给出总量与已用，卡片才有进度条。
export async function entUsage(site, { token, uid, deviceId } = {}, { signal } = {}) {
  const profile = deviceProfile(uid || extractUserID(token))
  const own = ugDeviceOf(deviceId)
  if (own) profile.deviceId = own
  const env = await ugPost(site, EP.entUsage, {
    token,
    profile,
    body: JSON.stringify({ require_usage: true, req_source: 2 }),
    signal,
  })
  const { code, message } = codeOf(env)
  if (code !== 0) throw new Error(`${site.name} 的积分读不出来：${message || `code ${code}`}`)
  const packs = Array.isArray(env.user_entitlement_pack_list)
    ? env.user_entitlement_pack_list
    : Array.isArray(env?.data?.user_entitlement_pack_list)
      ? env.data.user_entitlement_pack_list
      : []
  return usageOf(env, Date.now())
}

// whenOf 把上游的到期时间读成毫秒：秒、毫秒、ISO 字符串都认。
//
// 三种都见过（上一版插件的 whenOf 同口径）；读不出来返回 0，调用方按「没有到期日」
// 处理。
export function whenOf(v) {
  if (v === undefined || v === null || v === "") return 0
  if (typeof v === "string" && !/^\d+$/.test(v.trim())) {
    const t = Date.parse(v)
    return Number.isNaN(t) ? 0 : t
  }
  const n = Number(v)
  if (!Number.isFinite(n) || n <= 0) return 0
  return n < 1e11 ? n * 1000 : n
}

// usageOf 把积分响应聚合成 magpie 的 usage 卡。
//
// 优先用上游自己的汇总（`usage_summary.total_amount` / `consumed_amount`）——
// 2026-11-18 抓到的真实响应里这就是 3500 / 130.39，是官方口径；没有汇总时才按积分包
// 累加（llm-api 的 UserEntUsage 就是算包）。入参可以是整个响应体，也可以只是包数组。
//
// 包在这里的用处是回答「什么时候重置、届时会损失多少」（resetsAt / runsOut）：积分包
// 逐包到期作废，不给这两个字段用户就不知道快过期的那些。
// 另有两条实测事实：credits_limit 为 -1 是「无上限」；到期日可能是秒、毫秒或 ISO。
export function usageOf(input, now = Date.now()) {
  const packs = Array.isArray(input) ? input : Array.isArray(input?.user_entitlement_pack_list) ? input.user_entitlement_pack_list : []
  const summary = Array.isArray(input) ? null : input?.usage_summary
  const unlimitedPacks = packs.some((p) => Number(p?.entitlement_base_info?.quota?.credits_limit) === -1)

  // 包里的到期日：最近一个「还有剩余」的包的到期时间
  let soonest = 0
  let lapsing = 0
  for (const p of packs) {
    const total = Number(p?.entitlement_base_info?.quota?.credits_limit)
    if (!Number.isFinite(total) || total <= 0) continue
    const spent = Number(p?.usage?.credits_amount) || 0
    if (total - spent <= 0) continue
    const end = whenOf(p?.expire_time) || whenOf(p?.entitlement_base_info?.end_time) || whenOf(p?.end_time)
    if (end && end <= now) continue
    if (!end) continue
    const rest = Math.max(0, total - spent)
    if (!soonest || end < soonest) {
      soonest = end
      lapsing = rest
    } else if (end === soonest) {
      lapsing += rest
    }
  }

  let limit = 0
  let used = 0
  const total = Number(summary?.total_amount)
  const consumed = Number(summary?.consumed_amount)
  if (Number.isFinite(total) && total > 0) {
    limit = total
    used = Number.isFinite(consumed) ? Math.max(0, consumed) : 0
  } else {
    for (const p of packs) {
      const t = Number(p?.entitlement_base_info?.quota?.credits_limit)
      if (!Number.isFinite(t) || t < 0) continue
      // 与 llm-api 同口径：过期包不计入
      const end = whenOf(p?.expire_time) || whenOf(p?.entitlement_base_info?.end_time) || whenOf(p?.end_time)
      if (end && end <= now) continue
      limit += t
      used += Number(p?.usage?.credits_amount) || 0
    }
  }

  const plan = input && !Array.isArray(input) && input.is_credits_billing ? "Credits" : ""
  if (unlimitedPacks) return { plan, balance: "unlimited", windows: [] }
  if (limit <= 0) return { plan, windows: [] }
  const window = {
    name: "Credits",
    used: Math.max(0, Math.min(100, (100 * used) / limit)),
    display: `${compact(used)} / ${compact(limit)}`,
    amount: used,
    limit,
    unit: "credits",
  }
  if (soonest) {
    window.resetsAt = new Date(soonest).toISOString()
    if (lapsing > 0) window.runsOut = lapsing
  }
  return { plan, windows: [window] }
}

// compact 把数字压成 "1.2k" 之类的短写法。
function compact(n) {
  if (!Number.isFinite(n)) return "0"
  if (Math.abs(n) >= 1000) return `${(n / 1000).toFixed(n % 1000 === 0 ? 0 : 1)}k`
  return Number.isInteger(n) ? String(n) : n.toFixed(2).replace(/0+$/, "").replace(/\.$/, "")
}
