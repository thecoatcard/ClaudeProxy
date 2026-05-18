/**
 * lib/runtime/response-watchdog.ts
 *
 * Tracks request lifecycle and enforces hard timeouts.
 * Prevents indefinite hangs in model calls, compaction, Redis, and web search.
 */

// ─── Timeout Constants ───────────────────────────────────────────────────────

/** Hard timeout for a single Gemini model call (ms)
 * Raised from 20 s → 55 s because multi-turn conversations with long
 * context (tool results, extended histories) can take Gemini 20–50 s to
 * begin streaming the second/third response. A 20 s limit caused spurious
 * mid-task timeouts that looked like dropped streams from the client side.
 */
export const MODEL_CALL_TIMEOUT = Number(process.env.MODEL_CALL_TIMEOUT || 55_000);

/** Hard timeout for context compaction (ms) */
export const COMPACTOR_TIMEOUT = Number(process.env.COMPACTOR_TIMEOUT || 8_000);

/** Hard timeout for Redis operations (ms) */
export const REDIS_TIMEOUT = Number(process.env.REDIS_TIMEOUT || 3_000);

/** Hard timeout for web search (ms) */
export const WEB_SEARCH_TIMEOUT = Number(process.env.WEB_SEARCH_TIMEOUT || 8_000);

/** Hard timeout for model fallback selection (ms) */
export const FALLBACK_TIMEOUT = Number(process.env.FALLBACK_TIMEOUT || 5_000);

/** Hard timeout for entire request (ms) — default supports 40+ minute agentic runs */
export const REQUEST_TIMEOUT = Number(process.env.REQUEST_TIMEOUT || 2_700_000);

/** If no progress for this many ms, trigger recovery */
export const STALL_DETECTION_MS = Number(process.env.STALL_DETECTION_MS || 30_000);

// ─── withTimeout ─────────────────────────────────────────────────────────────

/**
 * Wraps a promise with a hard timeout. On timeout, rejects with a descriptive error.
 * If controller is provided, it will be aborted automatically on timeout.
 */
export function withTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
  label: string,
  controller?: AbortController,
): Promise<T> {
  if (timeoutMs <= 0) return promise;
  return new Promise<T>((resolve, reject) => {
    let settled = false;
    const timer = setTimeout(() => {
      if (settled) return;
      settled = true;
      if (controller) {
        try { controller.abort(`Timeout: ${label} exceeded ${timeoutMs}ms`); } catch { /* ignore */ }
      }
      reject(new Error(`Timeout: ${label} exceeded ${timeoutMs}ms`));
    }, timeoutMs);
    timer.unref?.();

    promise.then(
      (val) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        resolve(val);
      },
      (err) => {
        if (settled) return;
        settled = true;
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

// ─── RequestWatchdog ─────────────────────────────────────────────────────────

export interface WatchdogState {
  requestId: string;
  startTime: number;
  lastActivityTime: number;
  lastPhase: string;
  isStalled: boolean;
}

/**
 * Tracks a single request's lifecycle for stall detection.
 */
export class RequestWatchdog {
  private state: WatchdogState;
  private onStall?: (state: WatchdogState) => void;
  private checkTimer: ReturnType<typeof setInterval> | null = null;

  constructor(requestId: string, onStall?: (state: WatchdogState) => void) {
    this.state = {
      requestId,
      startTime: Date.now(),
      lastActivityTime: Date.now(),
      lastPhase: 'init',
      isStalled: false,
    };
    this.onStall = onStall;
  }

  /** Start periodic stall checks */
  start(): this {
    this.checkTimer = setInterval(() => {
      const elapsed = Date.now() - this.state.lastActivityTime;
      if (elapsed >= STALL_DETECTION_MS && !this.state.isStalled) {
        this.state.isStalled = true;
        this.onStall?.(this.state);
      }
    }, 5_000);
    return this;
  }

  /** Record activity to reset stall timer */
  activity(phase: string): void {
    this.state.lastActivityTime = Date.now();
    this.state.lastPhase = phase;
    this.state.isStalled = false;
  }

  /** Check if total request time exceeds budget */
  isOverBudget(): boolean {
    return (Date.now() - this.state.startTime) >= REQUEST_TIMEOUT;
  }

  /** Get elapsed time */
  elapsed(): number {
    return Date.now() - this.state.startTime;
  }

  /** Stop watching */
  stop(): void {
    if (this.checkTimer) {
      clearInterval(this.checkTimer);
      this.checkTimer = null;
    }
  }

  getState(): Readonly<WatchdogState> {
    return this.state;
  }
}
