// Network helpers shared by the PyPI and GitHub readers: per-request timeout, a global
// concurrency cap, and one retry with backoff on rate limiting (429) or server errors (5xx).

export type FetchLike = (input: string, init?: RequestInit) => Promise<Response>;

export const REQUEST_TIMEOUT_MS = 10_000;
export const MAX_CONCURRENCY = 6;
const RETRY_STATUSES = new Set([429, 500, 502, 503, 504]);
const MAX_RETRY_DELAY_MS = 5_000;

export class HttpError extends Error {
  constructor(
    message: string,
    readonly status: number | null,
  ) {
    super(message);
    this.name = "HttpError";
  }
}

/** A tiny counting semaphore. */
export class Limiter {
  private active = 0;
  private readonly queue: (() => void)[] = [];

  constructor(private readonly max: number) {}

  async run<T>(task: () => Promise<T>): Promise<T> {
    if (this.active >= this.max) await new Promise<void>((resolve) => this.queue.push(resolve));
    this.active++;
    try {
      return await task();
    } finally {
      this.active--;
      this.queue.shift()?.();
    }
  }
}

export interface HttpOptions {
  fetchImpl?: FetchLike;
  limiter?: Limiter;
  timeoutMs?: number;
  /** Injected for tests so retries do not really wait. */
  sleep?: (ms: number) => Promise<void>;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));
const sharedLimiter = new Limiter(MAX_CONCURRENCY);

export interface HttpResult {
  status: number;
  text: string;
}

/**
 * GET a URL. Resolves with the status and body for any final HTTP status (callers decide what
 * 404 means); rejects with HttpError on timeout, network failure, or a 429/5xx that persists
 * after one retry.
 */
export async function httpGet(url: string, headers: Record<string, string>, opts: HttpOptions = {}): Promise<HttpResult> {
  const fetchImpl = opts.fetchImpl ?? ((input: string, init?: RequestInit) => fetch(input, init));
  const limiter = opts.limiter ?? sharedLimiter;
  const timeoutMs = opts.timeoutMs ?? REQUEST_TIMEOUT_MS;
  const sleep = opts.sleep ?? defaultSleep;

  for (let attempt = 0; attempt < 2; attempt++) {
    const result = await limiter.run(async () => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs);
      try {
        const resp = await fetchImpl(url, { headers, signal: controller.signal, credentials: "omit", redirect: "follow" });
        const text = await resp.text();
        return { status: resp.status, text, retryAfter: resp.headers.get("Retry-After") };
      } catch (err) {
        if (controller.signal.aborted) throw new HttpError(`timed out after ${timeoutMs / 1000} s`, null);
        throw new HttpError(`network error: ${err instanceof Error ? err.message : String(err)}`, null);
      } finally {
        clearTimeout(timer);
      }
    });
    if (RETRY_STATUSES.has(result.status)) {
      if (attempt === 0) {
        await sleep(retryDelay(result.retryAfter));
        continue;
      }
      throw new HttpError(result.status === 429 ? "rate limited (HTTP 429)" : `server error (HTTP ${result.status})`, result.status);
    }
    return { status: result.status, text: result.text };
  }
  throw new HttpError("unreachable", null);
}

function retryDelay(retryAfter: string | null): number {
  const seconds = retryAfter ? Number(retryAfter) : NaN;
  if (Number.isFinite(seconds) && seconds >= 0) return Math.min(seconds * 1000, MAX_RETRY_DELAY_MS);
  return 1_000;
}
