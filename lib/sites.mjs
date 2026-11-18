// Trae 的两个站点：trae-cn 与 trae-global。
//
// 站点由 provider id 决定，不由 base_url 或凭证 domain 猜测：猜错就是请求打到
// 另一个区域、上游回 401，错误来自上游几乎无法定位。
//
// 协议面（端点、请求头、请求体加密、信封）整体对齐 llm-api 的
// internal/relay/channel/trae 包 —— 那是唯一被生产跑过的一版。Global 的两个
// 域名（模型域与积分域）llm-api 没有覆盖，取自上一版插件的实测表，见注释。

// EP 是各端点路径，与 Go 侧 Ep* 常量逐条一致。
export const EP = {
  chat: "/api/agent/v3/llm_utils_chat", // 对话
  models: "/api/ide/v1/batch_get_detail_param", // 模型表
  exchange: "/cloudide/api/v3/trae/oauth/ExchangeToken", // refresh → access
  userInfo: "/cloudide/api/v3/trae/GetUserInfo", // 账号信息
  checkinStatus: "/trae/api/v2/ug/checkin_credits/status", // 签到状态
  checkinClaim: "/trae/api/v2/ug/checkin_credits/claim", // 签到
  entUsage: "/trae/api/v2/pay/ide_user_ent_usage", // 积分包用量
}

// CHAT_FUNCTION 是 llm_utils_chat 的通道标识（function 路由），不是 agent 身份。
//
// 上游按 function 选「用哪张模型表」：同一个模型名在不同 function 下可能可用也
// 可能 4001。取 chat_v3 是因为 2026-11-10 抓包的 110 个模型里 chat_v3 覆盖 59
// 个，且 IDE 自己的 Chat 模式在 create_agent_task 上用的也是 chat_v3。
export const CHAT_FUNCTION = "chat_v3"

// DEFAULT_MODEL 是请求没带 model 时的兜底 config_name。
export const DEFAULT_MODEL = "glm-5.2"

// MODELS_CN 是 CN 上游默认支持的模型（Go 侧 ModelList）。
//
// 名字必须与上游模型表（batch_get_detail_param）的 config_name 逐字一致：
// config_name 大小写敏感，小写的 doubao-* / deepseek-* 会被上游判为
// 4001 "config item is empty"。真实可用列表由 provider.models 从上游同步。
export const MODELS_CN = [
  "Doubao-Seed-Evolving",
  "Doubao-Seed-2.1-Pro",
  "Doubao-Seed-2.1-Turbo",
  "Doubao-Seed-Code",
  "DeepSeek-V4-Flash-Official",
  "DeepSeek-V4-Pro-Official",
  "glm-5.3-flash",
  "glm-5.3",
  "glm-5.2",
  "kimi-k3",
  "kimi-k2.7-code",
  "minimax-m3",
  "qwen3.8-flash",
  "qwen3.8-max",
  "qwen-3.7-plus",
]

// MODELS_GLOBAL 是 Global 的兜底清单。
//
// llm-api 只覆盖 CN，这份清单取自上一版插件记录的 Global 目录（两地目录几乎不
// 重叠），真实列表同样由上游同步覆盖它。
export const MODELS_GLOBAL = ["gpt-5.4", "gemini-3-flash", "kimi-k2.5", "minimax-m2", "deepseek-v3.2"]

export const SITES = {
  "trae-cn": {
    id: "trae-cn",
    name: "Trae CN",
    region: "CN",
    // 登录页与错误文案里的裸域名
    webHost: "trae.cn",
    hosts: {
      // 授权页（Go 侧 ConsoleHost）
      web: "https://www.trae.cn",
      // ExchangeToken / GetUserInfo（Go 侧 OAuthHost）
      oauth: "https://api.trae.com.cn",
      // llm_utils_chat / batch_get_detail_param（Go 侧 AgentHost）
      api: "https://api5-normal.mchost.guru",
      // 签到 / 积分（Go 侧 UgHost）
      ug: "https://api.trae.cn",
    },
    // 签到端点在 CN 上实测可用（Go 侧 DoCheckin）
    checkin: true,
    // 错误码表：1001 是 Trae 的「未登录」，4008 / 1005 是额度类。
    // 表来自上一版插件在真账号上的实测（llm-api 只单独认了流内的 1005）。
    codes: { lapsed: ["1001", "401"], quota: ["4008", "1005"] },
    models: MODELS_CN,
  },
  "trae-global": {
    id: "trae-global",
    name: "Trae Global",
    region: "Global",
    webHost: "trae.ai",
    hosts: {
      // 授权页（Go 侧 ConsoleHostAI）
      web: "https://www.trae.ai",
      // ExchangeToken / GetUserInfo（Go 侧 OAuthHostAI）
      oauth: "https://api.trae.ai",
      // llm-api 没有 Global 的对话域；这里取上一版插件的实测值（SG 部署）。
      // 换区域（US）或换部署时这里就是第一个要改的地方。
      api: "https://coresg-normal.trae.ai",
      // 积分域同上，未被 llm-api 覆盖
      ug: "https://api-sg-central.trae.ai",
    },
    // Global 的签到端点没有实测依据（CN 的 ug 域名不服务 trae.ai 账号），
    // 不给这个钩子，界面上就不会出现签到入口
    checkin: false,
    // 国际版多两个码：20101（令牌不再被接受）、4011（额度类）
    codes: { lapsed: ["1001", "20101", "401"], quota: ["4008", "1005", "4011"] },
    models: MODELS_GLOBAL,
  },
}

export const SITE_IDS = Object.keys(SITES)
