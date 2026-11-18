// 上游错误的分类：登录失效 / 额度用尽 / 其它。
//
// 分类口径取自上一版插件（apps/plugins/packages/trae）实测出来的码表：
//
//	1001            Trae 的「未登录」，国际版还会用 20101
//	4008 / 1005     CN 的额度类（1005 = 额度不足，llm-api 也认这个）
//	4011            国际版的额度类
//	429             HTTP 层的额度/限频
//
// llm-api 的 trae 渠道只单独处理了流内的 1005（→ 400 额度不足），其余的靠框架
// 通用映射；这里把两边的口径合起来：认得出的说清楚，认不出的原样透传。
//
// 「说清楚」的意义在客户端体验上：401 + X-Magpie-Sign-In: expired 会让 magpie 在
// 账号卡上提示重新登录，429 会显示成额度/限频，而不是一个 502 加一句上游原文。

// errorOf 从上游的错误体里读 {code, message}。
//
// 三种信封都见过：OpenAI 风格 {error:{code,message}}、Trae 自己的
// {code,message}、以及火山风格的 {ResponseMetadata:{Error:{Code,Message}}}。
export function errorOf(body) {
  let v = body
  if (typeof v === "string") {
    try {
      v = JSON.parse(v)
    } catch {
      return { code: "", message: String(body).trim().slice(0, 300) }
    }
  }
  if (!v || typeof v !== "object") return { code: "", message: "" }
  const meta = v.ResponseMetadata?.Error
  if (meta && (meta.Code || meta.Message)) {
    return { code: meta.Code ?? "", message: String(meta.Message ?? meta.Code ?? "") }
  }
  const e = v.error && typeof v.error === "object" ? v.error : v
  const code = e?.code ?? e?.Code ?? v.code ?? ""
  const message = e?.message ?? e?.msg ?? e?.Message ?? (typeof v.error === "string" ? v.error : "") ?? ""
  return { code, message: String(message || "") }
}

// 登录失效的措辞：HTTP 403 且文案像「没登录」时才判失效（403 也可能是权限类）。
const lapsedWords = /not ?log(ged)? ?in|unauthori[sz]ed|token (is )?(expired|invalid)|jwt|未登录|登录(已)?(过期|失效)/i
// 额度/限频的措辞，同样只在 403 上兜底用。
const quotaWords = /quota|credit|insufficient|exceed|limit|额度|积分|次数|上限|用完/i

// classify 把一次失败归成 {status, message, signIn, type}。
//
// status 是给客户端的 HTTP 状态；signIn 是给 magpie 的标记（"expired" 会提示重新
// 登录）；type 是 OpenAI 的错误类别。
export function classify(site, { status = 0, code = "", message = "" } = {}) {
  const c = String(code ?? "")
  const text = String(message ?? "")
  const lapsed = site?.codes?.lapsed ?? ["1001", "401"]
  const quota = site?.codes?.quota ?? ["4008", "1005"]
  const name = site?.name ?? "Trae"

  if (status === 401 || lapsed.includes(c) || (status === 403 && lapsedWords.test(text))) {
    return {
      status: 401,
      signIn: "expired",
      type: "authentication_error",
      message: `${name} 的登录已失效${text ? `（${text}）` : ""}，请重新登录`,
    }
  }
  if (status === 429 || quota.includes(c) || (status === 403 && quotaWords.test(text))) {
    return {
      status: 429,
      type: "rate_limit_error",
      message: `${name}: ${text || "额度或频率受限"}`,
    }
  }
  return {
    status: status >= 400 ? status : 502,
    type: "api_error",
    message: `${name}: ${text || "上游没有给出原因"}${c ? `（code ${c}）` : ""}`,
  }
}

// classifyStreamError 是流内 event:error 的分类：没有 HTTP 状态，只有码与文案。
export function classifyStreamError(site, ev) {
  return classify(site, { status: 200, code: ev?.errorCode ?? ev?.code ?? "", message: ev?.errorMessage ?? ev?.message ?? "" })
}
