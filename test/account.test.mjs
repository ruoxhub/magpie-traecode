import test from "node:test"
import assert from "node:assert/strict"

import {
  checkinOf,
  claimCheckin,
  deviceProfile,
  extractUserID,
  genMarketUUID,
  getCheckinStatus,
  randDigits,
  seededStream,
  ugDeviceOf,
  usageOf,
} from "../lib/account.mjs"
import { SITES } from "../lib/sites.mjs"
import { startServer } from "./fake.mjs"

const siteAt = (base) => ({ ...SITES["trae-cn"], hosts: { ...SITES["trae-cn"].hosts, ug: base } })

// 一个签名不校验的假 JWT（只填 payload）
const jwt = (payload) => `header.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.sig`

test("seededStream 是确定性的 SHA-256 派生（对齐 auto_checkin.py 的 _seeded_stream）", () => {
  assert.equal(seededStream("u1", "devid", 8).toString("hex"), seededStream("u1", "devid", 8).toString("hex"))
  assert.notEqual(seededStream("u1", "devid", 8).toString("hex"), seededStream("u2", "devid", 8).toString("hex"))
  // 盐不同就是另一条流
  assert.notEqual(seededStream("u1", "devid", 8).toString("hex"), seededStream("u1", "sess", 8).toString("hex"))
  assert.equal(seededStream("u1", "devid", 100).length, 100)
})

test("同一个账号每次派生出同一套设备指纹（随机设备会被上游按 9095 拒掉）", () => {
  const a = deviceProfile("user-42")
  const b = deviceProfile("user-42")
  assert.deepEqual(a, b)
  assert.match(a.deviceId, /^\d{15}$/)
  assert.match(a.marketUserId, /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
  assert.match(a.sessionId, /^[0-9a-f]{64}$/)
  assert.notDeepEqual(a, deviceProfile("user-43"))
})

test("randDigits / genMarketUUID 的无 seed 分支也是合法形态", () => {
  assert.match(randDigits(15, ""), /^\d{15}$/)
  assert.match(genMarketUUID(""), /^[0-9a-f-]{36}$/)
})

test("extractUserID 认 JWT 的 data.id / auth_id / sub", () => {
  assert.equal(extractUserID(jwt({ data: { id: "111" }, auth_id: "222" })), "111")
  assert.equal(extractUserID(jwt({ auth_id: "222" })), "222")
  assert.equal(extractUserID(jwt({ sub: "333" })), "333")
  assert.equal(extractUserID("Cloud-IDE-JWT " + jwt({ sub: "444" })), "444")
  assert.equal(extractUserID("not-a-jwt"), "")
})

test("getCheckinStatus 读 data 信封，字段缺失按 false 处理", async () => {
  const fake = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ code: 0, data: { checked_in: true, did_checked_in: false, credits: 120, enable: true } }))
  })
  try {
    const info = await getCheckinStatus(siteAt(fake.base), "tok", deviceProfile("u1"))
    assert.deepEqual(info, { checkedIn: true, didCheckedIn: false, credits: 120, extraCredits: 0, enable: true })
    // 用的是 VSCode 那套身份头，不是对话那套
    const req = fake.seen[0]
    assert.equal(req.url, "/trae/api/v2/ug/checkin_credits/status")
    assert.equal(req.headers.authorization, "Cloud-IDE-JWT tok")
    assert.equal(req.headers["x-market-client-id"], "VSCode 1.107.1")
    assert.ok(req.headers["x-market-user-id"])
    assert.ok(req.headers["vscode-sessionid"])
  } finally {
    await fake.close()
  }
})

test("已签到 → done，活动没开 → inactive，命中都不 claim", async () => {
  const already = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    if (req.url.endsWith("/status")) res.end(JSON.stringify({ code: 0, data: { checked_in: true, credits: 50, enable: true } }))
    else res.end(JSON.stringify({ code: 9999, message: "不该走到这里" }))
  })
  const off = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ code: 0, data: { checked_in: false, enable: false } }))
  })
  try {
    const done = await checkinOf(siteAt(already.base), { token: "tok", uid: "u1" })
    assert.equal(done.outcome, "done")
    assert.equal(done.credit, 50)
    // 只发了 status，没发 claim
    assert.equal(already.seen.length, 1)

    const inactive = await checkinOf(siteAt(off.base), { token: "tok", uid: "u1" })
    assert.equal(inactive.outcome, "inactive")
  } finally {
    await already.close()
    await off.close()
  }
})

test("没签到 → claim 成功给 claimed", async () => {
  const fake = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    if (req.url.endsWith("/status")) res.end(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }))
    else res.end(JSON.stringify({ code: 0 }))
  })
  try {
    const res = await checkinOf(siteAt(fake.base), { token: "tok", uid: "u1" })
    assert.equal(res.outcome, "claimed")
    assert.equal(fake.seen.length, 2)
  } finally {
    await fake.close()
  }
})

test("遇到 9095（同设备今日已签）换新设备重试，最多两次", async () => {
  let claim = 0
  const fake = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    if (req.url.endsWith("/status")) return res.end(JSON.stringify({ code: 0, data: { checked_in: false, enable: true } }))
    claim++
    // 前两次都撞同设备限制，第三次才成功
    res.end(claim < 3 ? JSON.stringify({ code: 9095, message: "当前设备今日已经签到" }) : JSON.stringify({ code: 0 }))
  })
  try {
    const res = await claimCheckin(siteAt(fake.base), "tok", deviceProfile("u1"), { delay: async () => {} })
    assert.equal(res.ok, true)
    assert.equal(claim, 3)
    // 第一次用原设备，重试用的是新设备（Go 侧重试同样取全新随机设备）
    const devices = fake.seen.filter((r) => r.url.endsWith("/claim")).map((r) => r.headers["x-device-id"])
    assert.equal(devices.length, 3)
    assert.equal(devices[0], deviceProfile("u1").deviceId)
    assert.ok(!devices.slice(1).includes(devices[0]))
  } finally {
    await fake.close()
  }
})

test("非重试类错误直接失败，把上游文案带上", async () => {
  const fake = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ code: 4003, message: "活动已结束" }))
  })
  try {
    const res = await claimCheckin(siteAt(fake.base), "tok", deviceProfile("u1"), { delay: async () => {} })
    assert.deepEqual(res, { ok: false, message: "活动已结束" })
  } finally {
    await fake.close()
  }
})

test("ugDeviceOf：只接受 15 位纯数字，对话设备号（32 位 hex / 16 位）不能用", () => {
  assert.equal(ugDeviceOf("123456789012345"), "123456789012345")
  // 对话用的那种设备号（登录时的 32 位 hex）会被签到口子 9074 拒，不能用
  assert.equal(ugDeviceOf("3651926768755481"), "")
  assert.equal(ugDeviceOf("a8d68af694ef19c3924a172aea731a7ffb7f0d4f09bdbc946e6d200fb3de362a"), "")
  assert.equal(ugDeviceOf(""), "")
})

test("签到用传入的 15 位设备号，其它形状则用 uid 派生的那个", async () => {
  const devices = []
  const fake = await startServer((req, res) => {
    devices.push(req.headers["x-device-id"])
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ code: 0, data: { checked_in: true, enable: true } }))
  })
  try {
    await checkinOf(siteAt(fake.base), { token: "tok", uid: "u1", deviceId: "123456789012345" })
    await checkinOf(siteAt(fake.base), { token: "tok", uid: "u1", deviceId: "deadbeefdeadbeefdeadbeefdeadbeef" })
    assert.equal(devices[0], "123456789012345")
    assert.equal(devices[1], deviceProfile("u1").deviceId)
  } finally {
    await fake.close()
  }
})

test("usageOf 优先用上游的 usage_summary（真机的官方口径）", () => {
  // 2026-11-18 真机响应：3500 / 130.39 在 usage_summary 里，包的 quota 里不一定有 credits_limit
  const out = usageOf({
    is_credits_billing: true,
    total_balance: 3369.61,
    usage_summary: { total_amount: 3500, consumed_amount: 130.39, consumption_ratio: 0.0372 },
    user_entitlement_pack_list: [
      // 这个包只有能力开关，没有 credits_limit：不能因此把卡片搞空
      { entitlement_base_info: { quota: { enable_solo_agent: true } }, usage: {} },
      { expire_time: 1796054399, entitlement_base_info: { quota: { credits_limit: 3500 } }, usage: { credits_amount: 130.39 } },
    ],
  })
  assert.equal(out.plan, "Credits")
  assert.equal(out.windows[0].limit, 3500)
  assert.equal(out.windows[0].amount, 130.39)
  assert.equal(out.windows[0].display, "130.39 / 3.5k")
  // 重置时间仍从包算
  assert.equal(out.windows[0].resetsAt, new Date(1796054399 * 1000).toISOString())
})

test("usageOf 只算未过期且还有剩余的积分包", () => {
  const now = Date.UTC(2026, 0, 10)
  const sec = (ms) => Math.floor(ms / 1000)
  const pack = (limit, used, expireMs) => ({
    expire_time: sec(expireMs),
    entitlement_base_info: { quota: { credits_limit: limit } },
    usage: { credits_amount: used },
  })
  const out = usageOf(
    [
      pack(100, 40, now + 86_400_000), // 有效：剩 60
      pack(50, 50, now + 86_400_000), // 用完了，但仍是本轮已用的额度
      pack(200, 10, now - 86_400_000), // 过期了，不计
    ],
    now,
  )
  assert.equal(out.windows.length, 1)
  const w = out.windows[0]
  // 与 Go 的 UserEntUsage 同算术：剩余 = Σ(limit − used)，已用 = 总量 − 剩余
  assert.equal(w.limit, 150)
  assert.equal(w.amount, 90)
  assert.equal(w.display, "90 / 150")
  assert.equal(Math.round(w.used), 60)
  // 最近一个到期日与届时作废的额度
  assert.equal(w.resetsAt, new Date(now + 86_400_000).toISOString())
  assert.equal(w.runsOut, 60)
})

test("usageOf：credits_limit 为 -1 是无上限，不能当额度 0", () => {
  const out = usageOf([{ entitlement_base_info: { quota: { credits_limit: -1 } }, usage: { credits_amount: 0 } }])
  assert.equal(out.balance, "unlimited")
  assert.deepEqual(out.windows, [])
})

test("usageOf：到期日可以是 ISO 字符串（上游两种写法都给过）", () => {
  const now = Date.parse("2026-01-10T00:00:00Z")
  const out = usageOf(
    [
      { entitlement_base_info: { quota: { credits_limit: 100 }, end_time: "2026-02-01T00:00:00Z" }, usage: { credits_amount: 10 } },
      { entitlement_base_info: { quota: { credits_limit: 100 }, end_time: "2025-12-01T00:00:00Z" }, usage: { credits_amount: 99 } },
    ],
    now,
  )
  // 过去那个包已被视为过期，不进总量
  assert.equal(out.windows[0].limit, 100)
  assert.equal(out.windows[0].resetsAt, "2026-02-01T00:00:00.000Z")
})

test("usageOf 没有可用积分包时给空窗口（卡片不硬编一个 0/0）", () => {
  assert.deepEqual(usageOf([], Date.now()), { plan: "", windows: [] })
})