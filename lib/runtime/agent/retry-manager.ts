import type { AgentTaskNode } from './contracts';

export type RetryErrorKind =
  | 'network'       // transient network errors — always retry
  | 'timeout'       // timeout — retry with backoff
  | 'rate_limit'    // rate limited — retry with extended backoff
  | 'auth'          // authentication error — never retry
  | 'not_found'     // resource not found — never retry
  | 'overloaded'    // model overloaded — retry with fallback signal
  | 'approval'      // approval required — never retry automatically
  | 'cancelled'     // user cancelled — never retry
  | 'unknown';      // unknown — retry up to limit

export interface RetryDecision {
  /** Whether the runtime should retry this task. */
  shouldRetry: boolean;
  /** Human-readable reason for the decision. */
  reason: string;
  /** The attempt number that would be executed next (1-based). */
  nextAttempt: number;
  /** Classified error kind. */
  errorKind: RetryErrorKind;
  /** Milliseconds to wait before the next attempt (0 = immediate). */
  delayMs: number;
  /**
   * When true, the caller should try a different model provider before retrying.
   * Set when the error is an overloaded or rate-limit error.
   */
  suggestProviderFallback: boolean;
}

const BASE_DELAY_MS = 1_000;
const MAX_DELAY_MS = 30_000;

function classifyError(message: string): RetryErrorKind {
  const lower = message.toLowerCase();
  if (/approval_required|approval required/.test(lower)) return 'approval';
  if (/cancelled|cancell/.test(lower)) return 'cancelled';
  if (/authentication|unauthorized|forbidden|invalid.*key|api.*key/i.test(lower)) return 'auth';
  if (/not found|404/.test(lower)) return 'not_found';
  if (/rate.limit|too.many.request|429/.test(lower)) return 'rate_limit';
  if (/overload|capacity|503|529/.test(lower)) return 'overloaded';
  if (/timeout|timed.out|etimedout/.test(lower)) return 'timeout';
  if (/econnreset|econnrefused|network|socket|fetch failed/i.test(lower)) return 'network';
  return 'unknown';
}

/** Compute exponential backoff with full jitter: delay = min(cap, base * 2^attempt) * random(0, 1) */
function computeBackoffMs(attempt: number, errorKind: RetryErrorKind): number {
  const multiplier = errorKind === 'rate_limit' ? 3 : errorKind === 'overloaded' ? 2 : 1;
  const exponential = Math.min(MAX_DELAY_MS, BASE_DELAY_MS * multiplier * Math.pow(2, attempt - 1));
  // Full jitter: randomize within [0, computed] to spread concurrent retries
  return Math.floor(Math.random() * exponential);
}

const NON_RETRIABLE: ReadonlySet<RetryErrorKind> = new Set(['auth', 'not_found', 'approval', 'cancelled']);

/**
 * RuntimeRetryManager decides whether a failed task should be retried and
 * computes the appropriate delay using exponential backoff with full jitter.
 *
 * RETRY STRATEGIES:
 * - network / timeout / unknown → retry up to maxAttempts, immediate or short delay
 * - rate_limit → retry up to maxAttempts with extended backoff (3× multiplier)
 * - overloaded → retry up to maxAttempts, suggest provider fallback to caller
 * - auth / not_found / approval / cancelled → never retry
 */
export class RuntimeRetryManager {
  decide(task: AgentTaskNode, error: unknown): RetryDecision {
    const maxAttempts = task.maxAttempts ?? 1;
    const currentAttempts = task.attempts ?? 0;
    const nextAttempt = currentAttempts + 1;
    const message = error instanceof Error ? error.message : String(error);
    const errorKind = classifyError(message);

    const isNonRetriable = NON_RETRIABLE.has(errorKind);
    const budgetExhausted = nextAttempt > maxAttempts;
    const shouldRetry = !isNonRetriable && !budgetExhausted;

    if (!shouldRetry) {
      return {
        shouldRetry: false,
        reason: isNonRetriable
          ? `Non-retriable error (${errorKind}) for task ${task.id}: ${message}`
          : `Retry budget exhausted (${currentAttempts}/${maxAttempts}) for task ${task.id}`,
        nextAttempt,
        errorKind,
        delayMs: 0,
        suggestProviderFallback: false,
      };
    }

    const delayMs = computeBackoffMs(nextAttempt, errorKind);
    const suggestProviderFallback = errorKind === 'overloaded' || errorKind === 'rate_limit';

    return {
      shouldRetry: true,
      reason: `Retry ${nextAttempt}/${maxAttempts} for task ${task.id} (${errorKind}, delay=${delayMs}ms)`,
      nextAttempt,
      errorKind,
      delayMs,
      suggestProviderFallback,
    };
  }

  /**
   * Waits for the delay specified in a RetryDecision before returning.
   * This should be called in the runtime loop after receiving a shouldRetry=true decision.
   */
  async waitForDelay(decision: RetryDecision): Promise<void> {
    if (decision.delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, decision.delayMs));
    }
  }
}
