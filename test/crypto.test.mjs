import test from "node:test"
import assert from "node:assert/strict"
import { randomBytes } from "node:crypto"

import { DEFAULT_BASE_KEY_HEX, NONCE_LEN, SALT_LEN, baseKey, decryptBody, deriveKey, encryptBody } from "../lib/crypto.mjs"

const KEY = baseKey()

test("deriveKey 只异或前 8 字节，其余字节不动（对齐 Go 的 DeriveKey）", () => {
  const salt = Buffer.alloc(SALT_LEN, 0xff)
  const k = deriveKey(KEY, salt)
  for (let i = 0; i < SALT_LEN; i++) assert.equal(k[i], KEY[i] ^ 0xff)
  for (let i = SALT_LEN; i < 32; i++) assert.equal(k[i], KEY[i])
})

test("加密的布局是 base64(nonce[12] || ct || tag[16])，aad 是秒级时间戳", () => {
  const plaintext = JSON.stringify({ function: "chat_v3", messages: [{ role: "user", content: [{ type: "text", text: "hi" }] }] })
  const enc = encryptBody(plaintext, { at: 1731111111 })
  const blob = Buffer.from(enc.bodyBase64, "base64")
  // 12 nonce + 明文 + 16 tag
  assert.equal(blob.length, NONCE_LEN + Buffer.byteLength(plaintext) + 16)
  assert.equal(enc.requestPin.length, 16) // 8 字节 → 16 hex
  assert.match(enc.requestPin, /^[0-9a-f]{16}$/)
  assert.equal(enc.requestedAt, "1731111111")
  // 密文不是明文，且三段都能对上自己的盐
  assert.ok(!enc.bodyBase64.includes("chat_v3"))
  const back = decryptBody(enc.bodyBase64, enc.requestPin, enc.requestedAt)
  assert.equal(back.toString("utf8"), plaintext)
})

test("换错的 pin / 时间戳解不开（GCM 认证真的在校验）", () => {
  const enc = encryptBody("payload", { at: 1731111111 })
  // 换 pin：派生密钥不同，认证失败
  assert.throws(() => decryptBody(enc.bodyBase64, randomBytes(SALT_LEN).toString("hex"), enc.requestedAt))
  // 换 aad：认证失败
  assert.throws(() => decryptBody(enc.bodyBase64, enc.requestPin, "1731111112"))
})

test("两次加密的 salt 与 nonce 都不同", () => {
  const a = encryptBody("x")
  const b = encryptBody("x")
  assert.notEqual(a.requestPin, b.requestPin)
  assert.notEqual(a.bodyBase64, b.bodyBase64)
})

test("TRAE_BASE_KEY 可覆盖内置常量，长度不对要报错", () => {
  const custom = randomBytes(32).toString("hex")
  assert.deepEqual(baseKey(custom), Buffer.from(custom, "hex"))
  assert.throws(() => baseKey("abcd"), /32 字节/)
  // 缺省值就是客户端内置的那个常量
  assert.deepEqual(baseKey(""), Buffer.from(DEFAULT_BASE_KEY_HEX, "hex"))
  assert.equal(DEFAULT_BASE_KEY_HEX.length, 64)
})
