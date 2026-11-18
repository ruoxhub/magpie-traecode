// 请求体加密：AES-256-GCM，对齐 llm-api 的 internal/relay/channel/trae/crypto.go。
//
//	key       = BASE_KEY[32]
//	key[0:8] ^= salt8                      # salt8 即请求头 x-request-pin（16 hex 字符）
//	nonce     = random(12)
//	aad       = ascii(unix_seconds)        # 即请求头 x-requested-at
//	ct||tag   = AES-256-GCM(key, nonce, plaintext, aad)
//	body      = base64_std( nonce || ct || tag )
//
// BASE_KEY 是 Trae 客户端内置的常量，取自 Trae CN 客户端
// resources/app/extensions/ai-completion/resource/aiserver/server.js。

import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto"

export const DEFAULT_BASE_KEY_HEX =
  "6195f24ca4d430f8a4833de7db8dac37d148a084e7464a351ffa68585c16b955"

export const NONCE_LEN = 12
export const SALT_LEN = 8
export const KEY_LEN = 32
const TAG_LEN = 16

// baseKey 读 BASE_KEY：环境变量 TRAE_BASE_KEY 优先，缺省用内置常量。
//
// 上游换掉客户端密钥时不用改代码，先临时用环境变量顶上。
export function baseKey(hex) {
  const src = String(hex ?? process.env.TRAE_BASE_KEY ?? "").trim() || DEFAULT_BASE_KEY_HEX
  const key = Buffer.from(src, "hex")
  if (key.length !== KEY_LEN) {
    throw new Error(`BASE_KEY 必须是 ${KEY_LEN} 字节的 hex（当前 ${key.length} 字节）`)
  }
  return key
}

// deriveKey 把 BASE_KEY 的前 8 字节与 salt8 异或，得到本次请求的实际密钥。
export function deriveKey(key, salt) {
  if (key.length !== KEY_LEN) throw new Error(`invalid base key length: ${key.length}`)
  if (salt.length !== SALT_LEN) throw new Error(`invalid salt length: ${salt.length}`)
  const k = Buffer.from(key)
  for (let i = 0; i < SALT_LEN; i++) k[i] ^= salt[i]
  return k
}

// encryptBody 加密请求体，返回密文与需要配套发送的两个请求头值。
//
// at 是秒级时间戳，只给测试用：它同时是 GCM 的 aad，解密侧要拿到同一个值。
export function encryptBody(plaintext, { key = baseKey(), at } = {}) {
  const salt = randomBytes(SALT_LEN)
  const nonce = randomBytes(NONCE_LEN)
  const requestedAt = String(at ?? Math.floor(Date.now() / 1000))
  const cipher = createCipheriv("aes-256-gcm", deriveKey(key, salt), nonce)
  cipher.setAAD(Buffer.from(requestedAt, "utf8"))
  const body = Buffer.concat([
    cipher.update(Buffer.from(plaintext)),
    cipher.final(),
    cipher.getAuthTag(),
  ])
  return {
    bodyBase64: Buffer.concat([nonce, body]).toString("base64"),
    requestPin: salt.toString("hex"),
    requestedAt,
  }
}

// decryptBody 解上游密文（服务端在部分链路上会把响应体也加密）。
//
// 对话响应实测不在加密链路上，保留这个方向是为了「上游开始加密」时不至于要重写
// 整个响应层，也为了让加密实现对得上双向。
export function decryptBody(bodyBase64, requestPinHex, requestedAt, { key = baseKey() } = {}) {
  const blob = Buffer.from(String(bodyBase64), "base64")
  if (blob.length < NONCE_LEN + TAG_LEN) throw new Error("encrypted blob too short")
  const salt = Buffer.from(String(requestPinHex), "hex")
  const nonce = blob.subarray(0, NONCE_LEN)
  const sealed = blob.subarray(NONCE_LEN)
  const decipher = createDecipheriv("aes-256-gcm", deriveKey(key, salt), nonce)
  decipher.setAAD(Buffer.from(String(requestedAt), "utf8"))
  decipher.setAuthTag(sealed.subarray(sealed.length - TAG_LEN))
  return Buffer.concat([decipher.update(sealed.subarray(0, sealed.length - TAG_LEN)), decipher.final()])
}
