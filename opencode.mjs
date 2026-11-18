// 本包的 OpenCode 1.x 插件，OpenCode 1.x 与 magpie 的插件宿主都这样加载它：
// 只有插件函数，别的什么都不导出（1.x 会拒绝一个导出里除了插件还有别的东西的包）。
// OpenCode 2.x 加载 opencode2.mjs，由它运行这里的插件。
export { TraeCNPlugin, TraeGlobalPlugin } from "./index.mjs"