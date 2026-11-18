// 测试用：一台记录请求的假上游。
//
// 每个测试自己拼 handler，handle 里能拿到原始 body 与请求头 —— 加密链路的验证
// 只能在这一层做（解出来的明文才是「客户端真正发了什么」）。

import { createServer } from "node:http"
import { tmpdir } from "node:os"
import { join } from "node:path"

export function startServer(handler) {
  return new Promise((resolve) => {
    const seen = []
    const server = createServer(async (req, res) => {
      const chunks = []
      for await (const c of req) chunks.push(c)
      const raw = Buffer.concat(chunks).toString("utf8")
      const entry = { method: req.method, url: req.url, headers: req.headers, body: raw }
      seen.push(entry)
      await handler(entry, res)
    })
    server.listen(0, "127.0.0.1", () =>
      resolve({
        server,
        base: `http://127.0.0.1:${server.address().port}`,
        seen,
        close: () => new Promise((r) => server.close(r)),
      }),
    )
  })
}

// sse 把一个事件的 event 名与载荷写成上游的 SSE 帧。
export function sse(event, data) {
  return `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`
}

// readText 读完整条响应体。
export function readText(res) {
  return res.text()
}

// 一份拿来当「真实上游」的最小对话流：正文 + 思维链 + 工具调用 + 用量 + done。
export function fakeChatStream({ withToolCall = false } = {}) {
  const frames = [
    sse("output", { reasoning_content: "想一想" }),
    sse("output", { response: "你好" }),
  ]
  if (withToolCall) {
    frames.push(
      sse("output", {
        tool_calls: [
          {
            id: "call_1",
            index: 0,
            function_call: { name: "read_file", arguments: '{"path":"a"}', namespace: "fs", partial_arguments: "" },
          },
        ],
      }),
    )
  }
  frames.push(
    sse("token_usage", {
      prompt_tokens: 11,
      completion_tokens: 7,
      total_tokens: 18,
      reasoning_tokens: 3,
      cache_read_input_tokens: 5,
    }),
  )
  frames.push(sse("done", { finish_reason: "stop" }))
  return frames.join("")
}
// 测试默认钉住内置版本：版本探测读的是开发机上装没装 Trae IDE，若不钉住，
// 同一套断言在两台机器上会得到不同的 x-ide-version。需要探测本身的测试
// （version.test.mjs）自己传 files / env，不受这里影响。
process.env.TRAE_IDE_PRODUCT_JSON ??= join(tmpdir(), "trae-no-ide-installed", "product.json")
// 同时禁掉联网版本探测：单元测试不该打上游
process.env.TRAE_IDE_NO_PROBE ??= "1"
