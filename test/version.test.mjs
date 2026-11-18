import test from "node:test"
import assert from "node:assert/strict"
import { mkdtempSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import { join } from "node:path"

import {
  FALLBACK_VERSION,
  FALLBACK_VERSION_CODE,
  ideInfo,
  parseLatest,
  probeLatestVersion,
  probeQuery,
  readLocalIde,
  regionOf,
  resetVersionCache,
  startIdeVersionRefresh,
} from "../lib/version.mjs"
import { soloHeaders } from "../lib/headers.mjs"
import { SITES } from "../lib/sites.mjs"
import { startServer } from "./fake.mjs"

// product.jsonOf 造一份本机安装的 product.json（字段名与真机一致）
function productJSON(fields) {
  const dir = mkdtempSync(join(tmpdir(), "trae-version-"))
  const file = join(dir, "product.json")
  writeFileSync(file, JSON.stringify(fields), "utf8")
  return file
}

const CN_PRODUCT = {
  nameShort: "Trae CN",
  version: "1.107.1",
  vscodeVersion: "1.107.1",
  appVersion: "3.4.20",
  traeVersionCode: "20250325",
  providerCode: "cn",
  quality: "stable",
}

test("readLocalIde 读 product.json 的 appVersion（真机发的就是这个值）", () => {
  const file = productJSON(CN_PRODUCT)
  const got = readLocalIde({ files: [file] })
  assert.equal(got.version, "3.4.20")
  assert.equal(got.region, "trae-cn")
  assert.equal(got.file, file)
})

test("readLocalIde：文件不存在 / 没有 appVersion / 版本形状不对都不认", () => {
  assert.equal(readLocalIde({ files: [join(tmpdir(), "nope", "product.json")] }), null)
  assert.equal(readLocalIde({ files: [productJSON({ nameShort: "Trae CN" })] }), null)
  assert.equal(readLocalIde({ files: [productJSON({ appVersion: "dev" })] }), null)
  // 一份坏的后面还有一份好的：继续往下找
  const good = productJSON(CN_PRODUCT)
  assert.equal(readLocalIde({ files: [productJSON({ appVersion: "x" }), good] }).version, "3.4.20")
})

test("regionOf 只有 CN 有实测依据；认不出返回空串", () => {
  assert.equal(regionOf({ providerCode: "cn" }), "trae-cn")
  assert.equal(regionOf({ win32NameVersion: "TRAE CN" }), "trae-cn")
  assert.equal(regionOf({ providerCode: "intl" }), "trae-global")
  assert.equal(regionOf({ appVersion: "3.4.20" }), "")
})

test("ideInfo：没装 IDE 落到内置常量", () => {
  resetVersionCache()
  const got = ideInfo(SITES["trae-cn"], { env: { TRAE_IDE_PRODUCT_JSON: join(tmpdir(), "absent.json") } })
  assert.equal(got.version, FALLBACK_VERSION)
  assert.equal(got.code, FALLBACK_VERSION_CODE)
  assert.equal(got.source, "fallback")
})

test("ideInfo：装了就自动用它的版本，code 仍用常量（没有可靠来源）", () => {
  resetVersionCache()
  const file = productJSON(CN_PRODUCT)
  const got = ideInfo(SITES["trae-cn"], { env: { TRAE_IDE_PRODUCT_JSON: file } })
  assert.equal(got.version, "3.4.20")
  // product.json 里的 traeVersionCode 不是请求头里那个值，不能用它去猜
  assert.equal(got.code, FALLBACK_VERSION_CODE)
  assert.equal(got.source, "local")
  assert.equal(got.file, file)
})

test("ideInfo：本机装的是别区的客户端时，不给这个站点用", () => {
  resetVersionCache()
  const file = productJSON({ ...CN_PRODUCT, providerCode: "intl", nameShort: "Trae", win32NameVersion: "TRAE" })
  const cn = ideInfo(SITES["trae-cn"], { env: { TRAE_IDE_PRODUCT_JSON: file } })
  assert.equal(cn.source, "fallback")
  // 而国际版站点能用它
  resetVersionCache()
  const global = ideInfo(SITES["trae-global"], { env: { TRAE_IDE_PRODUCT_JSON: file } })
  assert.equal(global.version, "3.4.20")
  assert.equal(global.source, "local")
})

test("ideInfo：环境变量优先级最高（可把版本与 code 都钉住）", () => {
  resetVersionCache()
  const file = productJSON(CN_PRODUCT)
  const got = ideInfo(SITES["trae-cn"], {
    env: { TRAE_IDE_PRODUCT_JSON: file, TRAE_IDE_VERSION: "9.9.9", TRAE_IDE_VERSION_CODE: "20990101" },
  })
  assert.deepEqual(
    { version: got.version, code: got.code, source: got.source },
    { version: "9.9.9", code: "20990101", source: "env" },
  )
})

test("probeQuery：只对 CN 拼参数，缺 mid 就不探（少字段上游只回「缺少 X」）", () => {
  const q = probeQuery(SITES["trae-cn"], "machine-1")
  const p = new URLSearchParams(q)
  assert.equal(p.get("mid"), "machine-1")
  assert.equal(p.get("productCode"), "TRAE")
  assert.equal(p.get("packageType"), "stable_cn")
  assert.equal(p.get("branch"), "release_desktop_yoma_win32_cn")
  // 固定发内置常量：它总比线上旧，于是每次都能拿回最新值
  assert.equal(p.get("appVersion"), FALLBACK_VERSION)
  assert.equal(probeQuery(SITES["trae-cn"], ""), "")
  // Global 的参数组合没实测过，不探
  assert.equal(probeQuery(SITES["trae-global"], "machine-1"), "")
})

test("parseLatest 只认形状对的版本号", () => {
  assert.equal(parseLatest({ data: { appVersion: "3.4.22" } }), "3.4.22")
  assert.equal(parseLatest({ data: { appVersion: "3.5" } }), "3.5")
  // needUpdate:false 时上游不回版本
  assert.equal(parseLatest({ data: { needUpdate: false } }), "")
  assert.equal(parseLatest({ data: { appVersion: "dev" } }), "")
  assert.equal(parseLatest(null), "")
})

test("probeLatestVersion 打的是更新检查，失败/错信封都只回空串", async () => {
  const fake = await startServer((req, res) => {
    res.writeHead(200, { "Content-Type": "application/json" })
    if (req.url.includes("appVersion=9")) return res.end(JSON.stringify({ err_code: 1000, err_message: "缺少包类型" }))
    res.end(JSON.stringify({ err_code: 0, data: { needUpdate: true, appVersion: "3.4.22" } }))
  })
  try {
    // Global 没有探测参数组合：不发请求、直接空串
    assert.equal(await probeLatestVersion(SITES["trae-global"], { mid: "m" }), "")
    // 没有 mid 也不发
    assert.equal(await probeLatestVersion(SITES["trae-cn"], {}), "")
  } finally {
    await fake.close()
  }
})

test("startIdeVersionRefresh：本机装了 IDE 就不联网（不产生请求）", async () => {
  let hits = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    hits++
    return new Response(JSON.stringify({ data: { appVersion: "9.9.9" } }), { status: 200 })
  }
  try {
    resetVersionCache()
    const file = productJSON(CN_PRODUCT)
    startIdeVersionRefresh(SITES["trae-cn"], { mid: "m", env: { TRAE_IDE_PRODUCT_JSON: file } })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(hits, 0)
    // 装了就直读它，不去看网络
    assert.equal(ideInfo(SITES["trae-cn"], { env: { TRAE_IDE_PRODUCT_JSON: file } }).source, "local")
  } finally {
    globalThis.fetch = realFetch
  }
})

test("startIdeVersionRefresh：没装 IDE 就联网取最新版本，并进入 ideInfo", async () => {
  let hits = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async (url) => {
    hits++
    // 断言探的是更新检查且带上了 mid
    assert.match(String(url), /check_update/)
    assert.match(String(url), /mid=/)
    return new Response(JSON.stringify({ err_code: 0, data: { needUpdate: true, appVersion: "3.4.22" } }), { status: 200 })
  }
  const env = { TRAE_IDE_PRODUCT_JSON: join(tmpdir(), "absent-product.json") }
  try {
    resetVersionCache()
    startIdeVersionRefresh(SITES["trae-cn"], { mid: "m", env })
    for (let i = 0; i < 40 && hits === 0; i++) await new Promise((r) => setTimeout(r, 5))
    await new Promise((r) => setTimeout(r, 20))
    assert.ok(hits >= 1)
    const info = ideInfo(SITES["trae-cn"], { env })
    assert.equal(info.version, "3.4.22")
    assert.equal(info.source, "network")
    assert.equal(info.code, FALLBACK_VERSION_CODE)
  } finally {
    globalThis.fetch = realFetch
    resetVersionCache()
  }
})

test("startIdeVersionRefresh：TRAE_IDE_NO_PROBE=1 或版本被钉住时不联网", async () => {
  let hits = 0
  const realFetch = globalThis.fetch
  globalThis.fetch = async () => {
    hits++
    return new Response("{}", { status: 200 })
  }
  try {
    const absent = { TRAE_IDE_PRODUCT_JSON: join(tmpdir(), "absent-product.json") }
    startIdeVersionRefresh(SITES["trae-cn"], { mid: "m", env: { ...absent, TRAE_IDE_NO_PROBE: "1" } })
    startIdeVersionRefresh(SITES["trae-cn"], { mid: "m", env: { ...absent, TRAE_IDE_VERSION: "1.2.3" } })
    await new Promise((r) => setTimeout(r, 20))
    assert.equal(hits, 0)
  } finally {
    globalThis.fetch = realFetch
  }
})

test("soloHeaders：版本头跟着探测结果走，其余静态头不变", () => {
  resetVersionCache()
  const file = productJSON(CN_PRODUCT)
  const prev = process.env.TRAE_IDE_PRODUCT_JSON
  process.env.TRAE_IDE_PRODUCT_JSON = file
  try {
    const h = soloHeaders({ access: "tok", uid: "u", machineId: "m", deviceId: "d" }, { stream: true, site: SITES["trae-cn"] })
    assert.equal(h["X-Ide-Version"], "3.4.20")
    assert.equal(h["App-Version"], "3.4.20")
    assert.equal(h["X-App-Version"], "3.4.20")
    assert.equal(h["X-Ide-Version-Code"], FALLBACK_VERSION_CODE)
    assert.equal(h["X-Ide-Version-Type"], "stable")
    // 设备画像仍取内置常量 / 账号自己的
    assert.equal(h["X-Machine-Id"], "m")
    assert.equal(h["X-App-Id"], "6eefa01c-1036-4c7e-9ca5-d891f63bfcd8")
  } finally {
    if (prev === undefined) delete process.env.TRAE_IDE_PRODUCT_JSON
    else process.env.TRAE_IDE_PRODUCT_JSON = prev
    resetVersionCache()
  }
})
