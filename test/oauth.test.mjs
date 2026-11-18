import test from "node:test"
import assert from "node:assert/strict"

import {
  cleanToken,
  exchangeToken,
  expiresOfJWT,
  normalizeSeconds,
  parseCredential,
  secondsToMs,
  startSignIn,
} from "../lib/oauth.mjs"
import { SITES } from "../lib/sites.mjs"
import { startServer } from "./fake.mjs"

const jwt = (payload) => `h.${Buffer.from(JSON.stringify(payload)).toString("base64url")}.s`

test("parseCredential 认 llm-api 渠道 key 的嵌套形态", () => {
  const key = JSON.stringify({
    auth: { accessToken: "Cloud-IDE-JWT abc", refreshToken: "ref", expiresAt: 1731111111, machineId: "m1", deviceId: "d1", domain: "trae.cn" },
    account: { uid: "u1", enterpriseId: "e1", nickname: "小明" },
  })
  const one = parseCredential(key)
  assert.equal(one.access, "abc") // 方案前缀被去掉
  assert.equal(one.refresh, "ref")
  assert.equal(one.expires, 1731111111000) // 秒 → 毫秒
  assert.equal(one.uid, "u1")
  assert.equal(one.enterpriseId, "e1")
  assert.equal(one.nickname, "小明")
  assert.equal(one.machineId, "m1")
  assert.equal(one.deviceId, "d1")
})

test("parseCredential 认扁平形态，access 缺失时用 JWT 的 exp 兜底到期时间", () => {
  const one = parseCredential(JSON.stringify({ refreshToken: "ref", uid: "u2", accessToken: jwt({ exp: 1900000000 }) }))
  assert.equal(one.refresh, "ref")
  assert.equal(one.expires, 1900000000000)
})

test("parseCredential：非 JSON / 空令牌都要给出人话错误", () => {
  assert.throws(() => parseCredential("not json"), /不是 JSON/)
  assert.throws(() => parseCredential(JSON.stringify({ uid: "u" })), /既没有 accessToken 也没有 refreshToken/)
})

test("cleanToken 去掉 Cloud-IDE-JWT / Bearer 前缀", () => {
  assert.equal(cleanToken("Cloud-IDE-JWT abc"), "abc")
  assert.equal(cleanToken("Bearer abc"), "abc")
  assert.equal(cleanToken("  abc  "), "abc")
})

test("normalizeSeconds / secondsToMs 把毫秒时间戳归一化", () => {
  assert.equal(normalizeSeconds(1731111111000), 1731111111)
  assert.equal(normalizeSeconds(1731111111), 1731111111)
  assert.equal(secondsToMs(1731111111), 1731111111000)
  assert.equal(secondsToMs(0), 0)
  assert.equal(expiresOfJWT(jwt({ exp: 1900000000 })), 1900000000000)
  assert.equal(expiresOfJWT("nope"), 0)
})

test("exchangeToken 按 Go 的请求体换令牌，refresh 轮换时跟着换", async () => {
  const fake = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(
      JSON.stringify({
        Result: { Token: "Cloud-IDE-JWT new-token", RefreshToken: "new-refresh", TokenExpireAt: 1731111111000 },
      }),
    )
  })
  try {
    const site = { ...SITES["trae-cn"], hosts: { ...SITES["trae-cn"].hosts, oauth: fake.base } }
    const got = await exchangeToken(site, "old-refresh")
    assert.equal(got.access, "new-token")
    assert.equal(got.refresh, "new-refresh")
    assert.equal(got.expires, 1731111111000)

    const req = fake.seen[0]
    assert.equal(req.url, "/cloudide/api/v3/trae/oauth/ExchangeToken")
    assert.equal(req.headers["user-agent"], "TraeClient/TTNet")
    assert.deepEqual(JSON.parse(req.body), {
      ClientID: "en1oxy7wnw8j9n",
      RefreshToken: "old-refresh",
      ClientSecret: "-",
      UserID: "",
    })
  } finally {
    await fake.close()
  }
})

test("exchangeToken：没有 RefreshToken 时沿用旧值，HTTP 错误要抛", async () => {
  const noRotate = await startServer((_req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    res.end(JSON.stringify({ Result: { Token: "t2" } }))
  })
  const bad = await startServer((_req, res) => {
    res.writeHead(400)
    res.end("nope")
  })
  try {
    const site = (base) => ({ ...SITES["trae-cn"], hosts: { ...SITES["trae-cn"].hosts, oauth: base } })
    const got = await exchangeToken(site(noRotate.base), "keep-me")
    assert.equal(got.refresh, "keep-me")
    await assert.rejects(() => exchangeToken(site(bad.base), "x"), /HTTP 400/)
  } finally {
    await noRotate.close()
    await bad.close()
  }
})

test("startSignIn：授权地址带齐 IDE 的参数，回调落在本机临时端口，取消能收尾", async () => {
  const ac = new AbortController()
  const started = await startSignIn(SITES["trae-cn"], { signal: ac.signal })
  const url = new URL(started.url)
  assert.equal(url.origin, "https://www.trae.cn")
  assert.equal(url.pathname, "/authorization")
  const q = url.searchParams
  assert.equal(q.get("client_id"), "en1oxy7wnw8j9n")
  assert.equal(q.get("auth_from"), "solo")
  assert.equal(q.get("login_channel"), "native_ide")
  assert.equal(q.get("x_app_version"), "3.4.17")
  assert.match(q.get("machine_id"), /^[0-9a-f]{32}$/)
  assert.match(q.get("device_id"), /^[0-9a-f]{32}$/)
  const callback = new URL(q.get("auth_callback_url"))
  assert.equal(callback.hostname, "127.0.0.1")
  assert.equal(callback.pathname, "/authorize")
  assert.ok(Number(callback.port) > 0)

  // 用户放弃登录时不能把调用方永远挂在那里
  ac.abort()
  const res = await started.callback()
  assert.equal(res.type, "failed")
  assert.match(res.error, /取消/)
})

test("startSignIn：浏览器回调把令牌读成一份 magpie 账号（含设备标识）", async () => {
  const started = await startSignIn(SITES["trae-cn"])
  const q = new URL(started.url).searchParams
  const userJwt = JSON.stringify({ Token: "Cloud-IDE-JWT good", RefreshToken: "ref-1", TokenExpireAt: 1731111111 })
  const userInfo = JSON.stringify({ UserID: "u-9", ScreenName: "阿九" })
  const callback = new URL(q.get("auth_callback_url"))
  callback.searchParams.set("userJwt", userJwt)
  callback.searchParams.set("userInfo", userInfo)

  const res = await fetch(callback)
  assert.equal(res.status, 200)
  const html = await res.text()
  assert.match(html, /已登录/)

  const auth = await started.callback()
  assert.equal(auth.type, "success")
  assert.equal(auth.access, "good")
  assert.equal(auth.refresh, "ref-1")
  assert.equal(auth.expires, 1731111111000)
  assert.equal(auth.uid, "u-9")
  assert.equal(auth.accountId, "阿九")
  assert.equal(auth.machineId, q.get("machine_id"))
  assert.equal(auth.deviceId, q.get("device_id"))
})

test("startSignIn：回调没带令牌要说清楚，不能静默成功", async () => {
  const started = await startSignIn(SITES["trae-cn"])
  const callback = new URL(new URL(started.url).searchParams.get("auth_callback_url"))
  const res = await fetch(callback)
  assert.match(await res.text(), /登录没有完成/)
  const auth = await started.callback()
  assert.equal(auth.type, "failed")
  assert.match(auth.error, /没有回传令牌/)
})

test("startSignIn：回调带的是一个坏掉的 userJwt 时不能抛空指针", async () => {
  const started = await startSignIn(SITES["trae-cn"])
  const callback = new URL(new URL(started.url).searchParams.get("auth_callback_url"))
  callback.searchParams.set("userJwt", "not-json")
  await fetch(callback)
  const auth = await started.callback()
  assert.equal(auth.type, "failed")
  // 人话：说没拿到令牌，而不是 "Cannot read properties of null"
  assert.match(auth.error, /没有回传 access token/)
})