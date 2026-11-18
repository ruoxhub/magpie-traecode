import test from "node:test"
import assert from "node:assert/strict"

import { classify, classifyStreamError, errorOf } from "../lib/errors.mjs"
import { SITES } from "../lib/sites.mjs"

const CN = SITES["trae-cn"]
const GLOBAL = SITES["trae-global"]

test("errorOf 认三种信封：OpenAI 风格 / Trae 自己的 / 火山 ResponseMetadata", () => {
  assert.deepEqual(errorOf(JSON.stringify({ error: { code: "4001", message: "bad" } })), { code: "4001", message: "bad" })
  assert.deepEqual(errorOf(JSON.stringify({ code: 1005, message: "额度不足" })), { code: 1005, message: "额度不足" })
  assert.deepEqual(errorOf(JSON.stringify({ ResponseMetadata: { Error: { Code: "X", Message: "boom" } } })), { code: "X", message: "boom" })
  // 裸文本（上游偶尔回 HTML）也要有话说
  assert.match(errorOf("<html>bad gateway</html>").message, /bad gateway/)
})

test("令牌失效：1001（CN）与 20101（仅 Global）都给 401 + expired", () => {
  assert.equal(classify(CN, { status: 200, code: "1001" }).status, 401)
  assert.equal(classify(CN, { status: 200, code: "1001" }).signIn, "expired")
  assert.equal(classify(GLOBAL, { status: 200, code: "20101" }).status, 401)
  // 20101 不在 CN 的码表里：CN 站点表下它不算失效
  assert.equal(classify(CN, { status: 200, code: "20101" }).status, 502)
})

test("额度类：4008 / 1005（CN）、4011（Global）→ 429 rate_limit_error", () => {
  for (const code of ["4008", "1005"]) {
    const r = classify(CN, { status: 200, code, message: "额度不足" })
    assert.equal(r.status, 429)
    assert.equal(r.type, "rate_limit_error")
  }
  assert.equal(classify(GLOBAL, { status: 200, code: "4011" }).status, 429)
  assert.equal(classify(CN, { status: 429 }).status, 429)
})

test("HTTP 403 只在文案像「没登录」/「额度」时才改写，否则原样透传", () => {
  assert.equal(classify(CN, { status: 403, message: "unauthorized: 未登录" }).status, 401)
  assert.equal(classify(CN, { status: 403, message: "quota exceeded" }).status, 429)
  const other = classify(CN, { status: 403, message: "Api Scope Forbidden" })
  assert.equal(other.status, 403)
  assert.equal(other.signIn, undefined)
})

test("认不出的错误：状态原样（未知状态当 502），文案带上 code", () => {
  assert.equal(classify(CN, { status: 500, code: "9", message: "boom" }).status, 500)
  const unknown = classify(CN, { status: 0, code: "4023", message: "nope" })
  assert.equal(unknown.status, 502)
  assert.match(unknown.message, /4023/)
  assert.match(unknown.message, /nope/)
})

test("classifyStreamError 用同一套口径处理流内错误", () => {
  const quota = classifyStreamError(CN, { errorCode: 1005, errorMessage: "额度不足" })
  assert.equal(quota.status, 429)
  const lapsed = classifyStreamError(CN, { errorCode: 1001, errorMessage: "not logged in" })
  assert.equal(lapsed.status, 401)
  assert.equal(lapsed.signIn, "expired")
})