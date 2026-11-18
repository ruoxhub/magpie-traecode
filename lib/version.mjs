// IDE 版本：优先读本机 Trae 安装里的 product.json，读不到才回落常量。
//
// 为什么值得自动取：版本头是「是不是那版客户端」的信号，写死的版本只会越来越旧。
// 实测（2026-11-18，真机 Trae CN 3.4.20）：`product.json` 的 `appVersion` 就是客户端
// 发出去的 `x-ide-version` / `x-app-version`，逐字一致 —— 所以本机装了 IDE 就有真值，
// 不必联网，也不必跟着上游发版手动改代码。
//
// `x-ide-version-code`（真机 20261110）**没有**可靠来源：product.json 里的
// `traeVersionCode`（20250325）不是它，模型表 / 客户端配置 / 更新检查的响应里也都没有。
// 所以这一个仍用常量 + 环境变量覆盖，不去猜一个看起来像的日期。
//
// 没有安装 IDE 的机器（OpenCode 用户常见）也能取到版本：调 Trae 自己的更新检查。
// 实测（2026-11-18）：故意发一个旧 appVersion，端点就把当前最新版本回在
// `data.appVersion`（当时 3.4.22）；不需要账号令牌，只要一组机器与渠道参数。
//
// 没做的一件事：Global 通道的探测。试探 `api.trae.ai` + `stable_sg` 只回
// `needUpdate: false`，说明参数或渠道不对，所以 Global 仍只用本机安装 / 常量。
//
// 优先级：环境变量 > 本机安装（区域匹配）> 联网探测（仅 CN）> 内置常量。

import { readFileSync } from "node:fs"
import { join } from "node:path"

// 内置基线：llm-api 的实测常量（2026-11-10 抓包）
export const FALLBACK_VERSION = "3.4.17"
export const FALLBACK_VERSION_CODE = "20261029"

// 本机安装位置的候选（按平台拼，找不到的路径读文件时会静默失败）
const APP_PATHS = {
  win32: [
    ["LOCALAPPDATA", "Programs/Trae CN/resources/app/product.json"],
    ["LOCALAPPDATA", "Programs/Trae/resources/app/product.json"],
    ["PROGRAMFILES", "Trae CN/resources/app/product.json"],
    ["PROGRAMFILES", "Trae/resources/app/product.json"],
    ["PROGRAMFILES(X86)", "Trae CN/resources/app/product.json"],
  ],
  darwin: [
    ["", "/Applications/Trae CN.app/Contents/Resources/app/product.json"],
    ["", "/Applications/Trae.app/Contents/Resources/app/product.json"],
    ["HOME", "Applications/Trae CN.app/Contents/Resources/app/product.json"],
    ["HOME", "Applications/Trae.app/Contents/Resources/app/product.json"],
  ],
  linux: [
    ["", "/usr/share/trae-cn/resources/app/product.json"],
    ["", "/usr/share/trae/resources/app/product.json"],
    ["", "/opt/trae-cn/resources/app/product.json"],
    ["", "/opt/trae/resources/app/product.json"],
  ],
}

// defaultFiles 列出本平台上值得一试的 product.json 路径。
export function defaultFiles(env = process.env) {
  // 显式指定就只用它：这是「指定哪个安装」的语义，而不是「先试这个再试别的」。
  // 测试也靠这一点把版本钉住（指向一个不存在的路径 = 没有安装）。
  if (env.TRAE_IDE_PRODUCT_JSON) return [env.TRAE_IDE_PRODUCT_JSON]
  const list = APP_PATHS[process.platform] ?? []
  const out = []
  for (const [base, rel] of list) {
    if (base === "") {
      out.push(rel)
      continue
    }
    const root = env[base]
    if (root) out.push(join(root, rel))
  }
  return out
}

// regionOf 从 product.json 判断这个安装是哪个区的客户端。
//
// 只有 CN 的取值是实测过的（`providerCode: "cn"`）；国际版没有安装样本，所以认不出时
// 返回空串，由调用方决定「不分区域地用它」还是「不用」。
export function regionOf(product) {
  const s = `${product?.providerCode ?? ""} ${product?.win32NameVersion ?? ""} ${product?.nameShort ?? ""}`.toLowerCase()
  if (/\bcn\b|-cn\b|trae cn/.test(s)) return "trae-cn"
  if (/intl|global|international|\bus\b/.test(s)) return "trae-global"
  return ""
}

// readLocalIde 读本机安装的版本信息；没装或读不到返回 null。
//
// files 可传入以覆盖候选路径（测试用）。
export function readLocalIde({ files = defaultFiles() } = {}) {
  for (const file of files) {
    let product
    try {
      product = JSON.parse(readFileSync(file, "utf8"))
    } catch {
      continue
    }
    const version = String(product?.appVersion ?? "").trim()
    if (!/^\d+\.\d+(\.\d+)?$/.test(version)) continue
    return { version, region: regionOf(product), file }
  }
  return null
}

// 缓存：读一个几百字节的 json 很便宜，但也没必要每个请求都读
const TTL_MS = 5 * 60 * 1000
let cached = null
let cachedAt = 0
let probed_ = false

// 探测结果缓存：按站点存版本与时间。失败也记时间（退避 10 分钟），
// 否则端点不通时每次插件装配都会再打一次。
const probed = new Map()
const PROBE_TTL_MS = 6 * 60 * 60 * 1000
const RETRY_MS = 10 * 60 * 1000

// UPDATE_ENDPOINT 是更新检查地址（只列参数组合实测过的站点）。
export const UPDATE_ENDPOINT = {
  "trae-cn": "https://api.trae.com.cn/icube/api/v1/package/check_update",
}

// probeQuery 拼探测参数。少 mid / branch 这类字段时上游只回「缺少 X」，所以把实测能用的
// 那组写全；appVersion 固定用内置常量 —— 它总比线上旧，于是每次都能拿到最新值。
export function probeQuery(site, mid) {
  if (site?.id !== "trae-cn" || !mid) return ""
  return new URLSearchParams({
    productCode: "TRAE",
    platform: "Win",
    packageType: "stable_cn",
    userRegion: "CN",
    branch: "release_desktop_yoma_win32_cn",
    arch: "x64",
    tenant: "marscode",
    appVersion: FALLBACK_VERSION,
    mid,
  }).toString()
}

// parseLatest 从更新检查的响应里读版本号；读不出返回空串。
export function parseLatest(env) {
  const v = String(env?.data?.appVersion ?? "").trim()
  return /^\d+\.\d+(\.\d+)?$/.test(v) ? v : ""
}

// probeLatestVersion 问一次上游的最新版本。失败返回空串（不影响任何请求）。
export async function probeLatestVersion(site, { mid, signal } = {}) {
  const url = UPDATE_ENDPOINT[site?.id]
  const query = probeQuery(site, mid)
  if (!url || !query) return ""
  try {
    const res = await fetch(`${url}?${query}`, {
      headers: { "User-Agent": "TraeClient/TTNet", Accept: "application/json" },
      signal: signal ?? AbortSignal.timeout(15000),
    })
    if (!res.ok) return ""
    return parseLatest(await res.json())
  } catch {
    return ""
  }
}

// startIdeVersionRefresh 开后台探测：本机装了 IDE（或版本被钉住）就不联网；否则立即探
// 一次，之后每 6 小时一次。不阻塞、不把进程留住，失败就继续用常量。
//
// 故意不放在请求路径上：取版本失败不该影响对话。
export function startIdeVersionRefresh(site, { mid, env = process.env } = {}) {
  if (env.TRAE_IDE_NO_PROBE === "1") return
  if (env.TRAE_IDE_VERSION) return // 版本被钉住，不用探
  const local = readLocalIde({ files: defaultFiles(env) })
  if (local && (!local.region || !site || local.region === site.id)) return
  const run = async () => {
    const last = probed.get(site.id)
    const age = last ? Date.now() - last.at : Infinity
    if (age < (last?.version ? PROBE_TTL_MS : RETRY_MS)) return
    const version = await probeLatestVersion(site, { mid })
    // 成功与失败都落时间戳：成功按 6h 刷新，失败按 10min 再试
    probed.set(site.id, { version: version || last?.version || "", at: Date.now() })
  }
  void run()
  const timer = setInterval(() => void run(), PROBE_TTL_MS)
  timer.unref?.()
}

// resetVersionCache 清掉缓存（测试与「IDE 刚升级」时用）。
export function resetVersionCache() {
  cached = null
  cachedAt = 0
  probed_ = false
  probed.clear()
}

// ideInfo 返回当前生效的版本头取值。
//
// 优先级：环境变量 > 本机安装（且区域与站点匹配）> 后台探测到的最新版本 > 内置常量。
// site 用来判断「本机装的是不是这个区的客户端」：装了国际版却给 CN 发国际版的版本号，
// 只会让上游多一个对不上的信号。
export function ideInfo(site, { now = Date.now(), env = process.env } = {}) {
  const version = String(env.TRAE_IDE_VERSION ?? "").trim()
  const code = String(env.TRAE_IDE_VERSION_CODE ?? "").trim()
  if (version || code) {
    return {
      version: version || FALLBACK_VERSION,
      code: code || FALLBACK_VERSION_CODE,
      source: "env",
      file: "",
    }
  }
  if (!probed_ || now - cachedAt > TTL_MS) {
    cached = readLocalIde({ files: defaultFiles(env) })
    cachedAt = now
    probed_ = true
  }
  const local = cached
  if (local && (!local.region || !site || local.region === site.id)) {
    return { version: local.version, code: FALLBACK_VERSION_CODE, source: "local", file: local.file }
  }
  // 没装 IDE：用后台探测到的最新版本（还没探到时就是常量）
  const remote = site ? probed.get(site.id) : null
  if (remote?.version) {
    return { version: remote.version, code: FALLBACK_VERSION_CODE, source: "network", file: "" }
  }
  return { version: FALLBACK_VERSION, code: FALLBACK_VERSION_CODE, source: "fallback", file: "" }
}
