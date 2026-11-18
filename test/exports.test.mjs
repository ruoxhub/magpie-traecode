import test from "node:test"
import assert from "node:assert/strict"
import { readFileSync } from "node:fs"
import { existsSync } from "node:fs"
import { fileURLToPath } from "node:url"
import { dirname, join } from "node:path"

import * as index from "../index.mjs"
import * as v1 from "../opencode.mjs"
import v2 from "../opencode2.mjs"

const here = dirname(fileURLToPath(import.meta.url))
const pkg = JSON.parse(readFileSync(join(here, "..", "package.json"), "utf8"))

test("index.mjs 只导出插件函数（OpenCode 1.x 拒绝一个导出里混进别的包）", () => {
  const entries = Object.entries(index)
  assert.deepEqual(
    entries.map(([k]) => k),
    ["TraeCNPlugin", "TraeGlobalPlugin"],
  )
  for (const [, v] of entries) assert.equal(typeof v, "function")
})

test("opencode.mjs 就是 1.x 的入口，转发同一批插件", () => {
  assert.equal(v1.TraeCNPlugin, index.TraeCNPlugin)
  assert.equal(v1.TraeGlobalPlugin, index.TraeGlobalPlugin)
  assert.equal(pkg.main, "./opencode.mjs")
})

test("opencode2.mjs 默认导出 {id, setup}，且 exports['.'] 指向它", () => {
  assert.equal(typeof v2.setup, "function")
  assert.equal(v2.id, pkg.name)
  assert.match(pkg.exports["."].import, /opencode2\.mjs$/)
})

for (const [k, v] of Object.entries(pkg.exports["."].import ? { ".": pkg.exports["."].import } : {})) {
  test(`package.json 的 exports[${k}] 指向的文件真的存在`, () => {
    assert.ok(existsSync(join(here, "..", v)), v)
  })
}

test("opencode2 的 setup 能在一份最小宿主上跑起来并给出清理函数", async () => {
  const ctx = {
    location: { directory: join(here, "..") },
    storage: { get: async () => undefined, set: async () => {} },
    event: {
      // 一个立刻结束的事件流：setup 里的订阅循环要能自然退出
      subscribe: async function* () {},
    },
    integration: {
      connection: {
        active: async () => undefined,
        resolve: async () => undefined,
      },
      // 2.x 每次重新加载都会把 transform 再跑一遍：给它一个能记账的实现，
      // 这样 setup 里的注册路径真的被走到（而不是被 try/catch 吞掉）
      transform: async (fn) => {
        const edits = []
        await fn({
          update: (id, f) => edits.push([id, f]),
          add: () => {},
          remove: () => {},
          method: { update: (arg) => edits.push(["method", arg]) },
        })
        return edits
      },
    },
  }
  const dispose = await v2.setup(ctx)
  assert.equal(typeof dispose, "function")
  dispose()
})