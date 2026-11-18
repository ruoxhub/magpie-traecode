// SOLO 请求头：llm_utils_chat / batch_get_detail_param 需要的那一套。
//
// 对齐 llm-api 的 internal/relay/channel/trae/headers.go。这些头不是装饰：
// 版本头与模型表绑定（X-Ide-Version-Code 决定上游返回哪张目录表，只升一半会
// 出现「列表里有、一点就 4001」）。所以除非有拓包依据，不要改这里任何一个值。
//
// 版本号不写死：本机装了 Trae IDE 就读它的 product.json（真机实测 appVersion 与客户端
// 发出去的 x-ide-version 逐字一致），读不到才回落常量。见 version.mjs。

import { randomBytes, randomUUID } from "node:crypto"

import { ideInfo } from "./version.mjs"

// PROFILE 是 Trae CN IDE 的固定客户端画像（2026-11-10 抓包基线）。
//
// 版本相关的两项不在这里取：由 version.mjs 按本机安装探测（见 soloHeaders）。
export const PROFILE = {
  appId: "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8",
  clientId: "en1oxy7wnw8j9n",
  deviceBrand: "MS-Challenger B760M-F WIFI",
  deviceCPU: "Intel",
  deviceID: "3651926768755481",
  machineID: "a8d68af694ef19c3924a172aea731a7ffb7f0d4f09bdbc946e6d200fb3de362a",
  osVersion: "Windows 11 Pro",
  packageType: "stable_cn",
  lscbdAid: "787976",
  lscbdPlatform: "windows",
  ssDp: "787976",
  neptune: "-11|50:51:59:00:09",
  clientUA: "TraeClient/TTNet",
  ugUA: "VSCode 1.107.1 (TRAE SOLO CN)",
}

// randomHex 生成 nBytes 字节随机数的 hex（小写）。
export function randomHex(nBytes) {
  return randomBytes(nBytes).toString("hex")
}

// uuid 生成 RFC 4122 v4 风格 uuid（带横线）。
export function uuid() {
  return randomUUID()
}

// soloHeaders 拼出 llm_utils_chat / batch_get_detail_param 的完整请求头。
//
// auth 是归一化后的账号（access / uid / machineId / deviceId），可为 null。
// site 用于取该区的 IDE 版本：本机装的是国际版却给 CN 发国际版版本号，只会多一个
// 对不上的信号。
export function soloHeaders(auth, { stream = false, site = null } = {}) {
  const ide = ideInfo(site)
  const h = {
    "Content-Type": "application/json",
    Accept: stream ? "text/event-stream" : "application/json",
    "User-Agent": PROFILE.clientUA,
  }
  if (auth?.access) {
    h.Authorization = `Cloud-IDE-JWT ${auth.access}`
    h["X-Cloudide-Token"] = auth.access
    h["X-Ide-Token"] = auth.access
    if (auth.uid) h["X-Uid"] = String(auth.uid)
  }
  h["X-Machine-Id"] = auth?.machineId || PROFILE.machineID
  h["X-Device-Id"] = auth?.deviceId || PROFILE.deviceID

  h["App-Version"] = ide.version
  h["Package-Type"] = PROFILE.packageType
  h["X-App-Id"] = PROFILE.appId
  // 真机这一格也发版本号（llm-api 发的是 "default"）；两者都通，这里跟真机
  h["X-App-Version"] = ide.version
  h["X-Ide-Version"] = ide.version
  h["X-Ide-Version-Code"] = ide.code
  h["X-App-Version-Code"] = ide.code
  h["X-Ide-Version-Type"] = "stable"
  h["X-Device-Type"] = "windows"
  h["X-Device-Cpu"] = PROFILE.deviceCPU
  h["X-OS-Version"] = PROFILE.osVersion
  h["X-Device-Brand"] = PROFILE.deviceBrand
  h["Request-Traffic-Type"] = "prod"
  h["X-Ahanet-Timeout"] = "86400"
  h["X-Bridge-Transport"] = "aha"
  // 3.4.17 抓包里恒发 0；缺它上游仍 200，但同族头少一个没有理由
  h["X-Agent-Host-Type"] = "0"
  h["X-Lgw-Req-Sdk-Type"] = "3"
  h["X-Lscbd-Aid"] = PROFILE.lscbdAid
  h["X-Lscbd-Platform"] = PROFILE.lscbdPlatform
  h["X-Ss-Dp"] = PROFILE.ssDp
  h["X-Neptune"] = PROFILE.neptune

  // 动态链路追踪标识：每个请求一套
  const trace = randomHex(16)
  h["X-Custom-Trace-Id"] = trace
  h["X-Flow-Traceparent"] = `04-${trace}-${randomHex(8)}-01`
  h["X-Request-Id"] = `req_${uuid()}`
  h["X-Trae-Request-Id"] = uuid()
  h["X-Tt-Trace-Id"] = `00-${randomHex(8)}5cc231941bcaffff-${randomHex(8)}-01`
  return h
}

// ugHeaders 是签到 / 积分接口的头，对齐 Go 侧 ugPost。
//
// 这一组走的是 VSCode 那套身份（X-Market-Client-Id / X-Market-User-Id /
// VSCode-SessionID），与对话那套不是同一组；混用会拿到 403。
export function ugHeaders({ token, profile }) {
  const auth = /^Cloud-IDE-JWT\s/.test(token) ? token : `Cloud-IDE-JWT ${token}`
  const h = {
    Accept: "*/*",
    "Accept-Language": "zh-CN",
    Authorization: auth,
    "Content-Type": "application/json",
    "User-Agent": PROFILE.ugUA,
    "X-Market-Client-Id": "VSCode 1.107.1",
    "X-Market-User-Id": profile.marketUserId,
    "X-User-Region": "CN",
    "X-Device-Id": profile.deviceId,
    "X-Lgw-Req-Sdk-Type": "3",
    "Package-Type": PROFILE.packageType,
    "X-Request-Id": uuid(),
    "X-Lscbd-Aid": PROFILE.lscbdAid,
    "X-Lscbd-Platform": PROFILE.lscbdPlatform,
    "App-Version": "0.1.45",
    "X-Tt-Trace-Id": `00-${randomHex(16)}-01`,
    "Sec-Fetch-Dest": "empty",
    "Sec-Fetch-Mode": "no-cors",
    "Sec-Fetch-Site": "none",
  }
  if (profile.sessionId) h["VSCode-SessionID"] = profile.sessionId
  return h
}

// oauthHeaders 是 ExchangeToken / GetUserInfo 的头（Go 侧 setOAuthHeaders）。
export function oauthHeaders() {
  return {
    "Content-Type": "application/json",
    Accept: "application/json",
    "User-Agent": PROFILE.clientUA,
  }
}
