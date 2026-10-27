import { config } from '../../config.js';

/**
 * 统一 HTTP 客户端：超时 + 指数退避重试 + 可选出口代理。
 *
 * 为什么要自己做：
 *  - Node 内置 fetch 默认无超时，一个挂住的请求能把回填脚本卡死；
 *  - 交易所/链上数据接口偶发 5xx 与限流，重试是必需品而非可选项；
 *  - 部署环境可能只有代理出口，需要能显式指定（国内直连 / 国外走代理）。
 */

const DEFAULT_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36';

/**
 * www.binance.com 的 WAF 会按请求指纹挑刺：
 * 默认 fetch 的 UA（如 'kline-practice/2.0'）会被判成爬虫返回 403 HTML。
 * 这些都是公开行情接口，这里统一带常规浏览器请求头，避免被误伤。
 */
const DEFAULT_HEADERS = {
  Accept: 'application/json, text/plain, */*',
  'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
  Referer: 'https://www.binance.com/',
  Origin: 'https://www.binance.com',
};

let dispatcherPromise = null;

async function getDispatcher() {
  if (!config.fetchProxy) return undefined;
  if (!dispatcherPromise) {
    dispatcherPromise = import('undici').then(({ ProxyAgent }) => {
      const agent = new ProxyAgent(config.fetchProxy);
      console.log(`[http] 出口代理: ${config.fetchProxy}`);
      return agent;
    });
  }
  return dispatcherPromise;
}

function sleep(ms) {
  return new Promise((r) => setTimeout(r, ms));
}

/**
 * 发起请求并解析 JSON。失败会重试（网络错误 / 5xx / 429）。
 * @returns {Promise<any>}
 */
export async function httpJson(url, opts = {}) {
  const {
    method = 'GET',
    body = null,
    headers = {},
    timeoutMs = 20_000,
    retries = 2,
    label = '',
  } = opts;

  const dispatcher = await getDispatcher();
  let lastErr;

  for (let attempt = 0; attempt <= retries; attempt++) {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(url, {
        method,
        body: body ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined,
        headers: {
          'User-Agent': DEFAULT_UA,
          ...DEFAULT_HEADERS,
          ...(body ? { 'Content-Type': 'application/json' } : {}),
          ...headers,
        },
        signal: ctrl.signal,
        dispatcher,
      });

      const text = await res.text();
      if (!res.ok) {
        // 4xx（除 429/403）不重试：请求本身有问题，重试无意义
        // 403：WAF 瞬时拦截，换个指纹/退避后再试往往能过
        const retryable = res.status >= 500 || res.status === 429 || res.status === 403;
        const err = new Error(
          `HTTP ${res.status} ${label} ${url.slice(0, 120)} :: ${text.slice(0, 200)}`,
        );
        err.status = res.status;
        err.retryable = retryable;
        throw err;
      }

      try {
        return JSON.parse(text);
      } catch {
        throw new Error(`响应不是合法 JSON ${label} :: ${text.slice(0, 200)}`);
      }
    } catch (err) {
      lastErr = err;
      const isAbort = err?.name === 'AbortError';
      const nonRetryable = err?.retryable === false;
      if (attempt < retries && !nonRetryable) {
        // 429 是配额型限流，需要退得更久才有意义
        const base = err?.status === 429 ? 5000 : 800;
        const wait = base * 2 ** attempt + Math.random() * 400;
        console.warn(
          `[http] ${label} 第 ${attempt + 1} 次失败(${isAbort ? '超时' : err.message.slice(0, 80)})，${Math.round(wait)}ms 后重试`,
        );
        await sleep(wait);
      } else if (nonRetryable) {
        break;
      }
    } finally {
      clearTimeout(timer);
    }
  }

  throw lastErr ?? new Error(`请求失败 ${label}`);
}
