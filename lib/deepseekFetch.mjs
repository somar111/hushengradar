// DeepSeek HTTP 请求共用：瞬时网络错误 / 5xx / 429 自动重试，避免各处重复 fetch 逻辑。

export const DEEPSEEK_URL = "https://api.deepseek.com/chat/completions";

const DEFAULT_RETRY_DELAYS_MS = [400, 1000];

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function isRetryableStatus(status) {
  return status === 429 || status === 502 || status === 503 || status === 504;
}

/** @param {unknown} err */
export function isDeepSeekRetryableError(err) {
  if (!err || typeof err !== "object") return false;
  if (/** @type {{ name?: string }} */ (err).name === "AbortError") return false;

  const status = /** @type {{ status?: number }} */ (err).status;
  if (typeof status === "number" && isRetryableStatus(status)) return true;

  const msg = String(/** @type {{ message?: string }} */ (err).message || "");
  if (msg.includes("fetch failed")) return true;

  const cause = /** @type {{ cause?: { code?: string } }} */ (err).cause;
  const code = cause?.code;
  return code === "ECONNRESET"
    || code === "ETIMEDOUT"
    || code === "ENOTFOUND"
    || code === "EAI_AGAIN"
    || code === "ECONNREFUSED"
    || code === "UND_ERR_CONNECT_TIMEOUT";
}

/** @param {unknown} err */
export function formatDeepSeekUserError(err) {
  const msg = err instanceof Error ? err.message : String(err);
  if (msg.includes("fetch failed") || isDeepSeekRetryableError(err)) {
    return "AI 服务暂时不可用，请稍后重试";
  }
  if (msg.includes("DEEPSEEK_API_KEY") || msg.includes("未配置")) return msg;
  if (msg.startsWith("DeepSeek")) return "AI 服务暂时不可用，请稍后重试";
  return msg || "AI 服务暂时不可用，请稍后重试";
}

/**
 * @param {string} url
 * @param {RequestInit} init
 * @param {{ maxRetries?: number; retryDelaysMs?: number[] }} [opts]
 */
export async function fetchDeepSeekWithRetry(url, init, opts = {}) {
  const maxRetries = opts.maxRetries ?? 2;
  const retryDelaysMs = opts.retryDelaysMs ?? DEFAULT_RETRY_DELAYS_MS;
  /** @type {unknown} */
  let lastError = null;

  for (let attempt = 0; attempt <= maxRetries; attempt++) {
    if (init.signal?.aborted) {
      throw new DOMException("The operation was aborted.", "AbortError");
    }

    try {
      const res = await fetch(url, init);
      if (res.ok) return res;

      const text = await res.text();
      const err = new Error(`DeepSeek API 出错：${text}`);
      /** @type {Error & { status?: number }} */ (err).status = res.status;
      if (!isRetryableStatus(res.status) || attempt >= maxRetries) throw err;
      lastError = err;
    } catch (err) {
      if (/** @type {{ name?: string }} */ (err).name === "AbortError") throw err;
      if (!isDeepSeekRetryableError(err) || attempt >= maxRetries) throw err;
      lastError = err;
    }

    await sleep(retryDelaysMs[attempt] ?? retryDelaysMs[retryDelaysMs.length - 1] ?? 800);
  }

  throw lastError instanceof Error ? lastError : new Error("DeepSeek 请求失败");
}

function composeAbortSignal(signals) {
  const active = signals.filter(Boolean);
  if (active.length === 0) return undefined;
  if (typeof AbortSignal.any === "function") return AbortSignal.any(active);
  const ctrl = new AbortController();
  for (const s of active) {
    if (s.aborted) {
      ctrl.abort();
      break;
    }
    s.addEventListener("abort", () => ctrl.abort(), { once: true });
  }
  return ctrl.signal;
}

/** 回复建议专用：更短超时、更少重试，避免长 prompt 多次重试拖慢体验。 */
export async function fetchDeepSeekForReply(url, init, opts = {}) {
  const timeoutMs = opts.timeoutMs ?? 50_000;
  const timeoutSignal = typeof AbortSignal.timeout === "function" ? AbortSignal.timeout(timeoutMs) : null;
  const signal = composeAbortSignal([init?.signal, timeoutSignal].filter(Boolean));
  return fetchDeepSeekWithRetry(url, { ...init, signal }, {
    maxRetries: opts.maxRetries ?? 1,
    retryDelaysMs: opts.retryDelaysMs ?? [250, 600],
  });
}
