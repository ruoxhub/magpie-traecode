// magpie / OpenCode provider plugin for Trae (ByteDance 的 AI IDE)。
//
// 两个 provider，各为一个站点：
//   - trae-cn      国区：授权页 www.trae.cn，换令牌 api.trae.com.cn，对话 api5-normal.mchost.guru
//   - trae-global  国际版：授权页 www.trae.ai，换令牌 api.trae.ai，对话 coresg-normal.trae.ai
//
// 站点由 provider id 决定，不由 base_url 或凭证 domain 猜测：猜错就是请求打到另一个
// 区域、上游回 401，错误来自上游几乎无法定位。
//
// 协议面（对话端点、SOLO 请求头、请求体 AES-256-GCM 加密、SSE 事件、模型表、
// 换令牌、签到、积分）整体对齐 llm-api 的 internal/relay/channel/trae —— 那是唯一
// 被生产跑过的一版实现，也是这个包的设计图纸。
//
// 这个文件只导出两个插件函数，别的什么都不导出：OpenCode 1.x 会拒绝一个导出里除了
// 插件还有别的东西的包。OpenCode 2.x 由 opencode2.mjs 适配。插件工厂在 lib/plugin.mjs。

import { SITES } from "./lib/sites.mjs"
import { makePlugin } from "./lib/plugin.mjs"

export const TraeCNPlugin = makePlugin(SITES["trae-cn"])
export const TraeGlobalPlugin = makePlugin(SITES["trae-global"])