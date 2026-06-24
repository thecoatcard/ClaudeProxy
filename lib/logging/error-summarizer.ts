/**
 * lib/logging/error-summarizer.ts
 *
 * Summarizes errors into structured, readable formats.
 * Replaces raw stack traces with categorized error summaries.
 */

export interface ErrorSummary {
  errorClass: string;
  errorSource: string;
  errorReason: string;
  recoveryAction: string;
  stackTrace?: string;
}

/**
 * Classify an error into a structured summary.
 */
export function summarizeError(error: unknown, source: string): ErrorSummary {
  if (error instanceof Error) {
    return {
      errorClass: error.constructor.name || 'Error',
      errorSource: source,
      errorReason: error.message,
      recoveryAction: inferRecoveryAction(error),
      stackTrace: error.stack,
    };
  }

  if (typeof error === 'string') {
    return {
      errorClass: 'StringError',
      errorSource: source,
      errorReason: error,
      recoveryAction: 'Check logs for context',
    };
  }

  return {
    errorClass: 'UnknownError',
    errorSource: source,
    errorReason: String(error),
    recoveryAction: 'Investigate source module',
  };
}

/**
 * Create a concise one-line error description (no stack trace).
 */
export function errorOneLiner(error: unknown, source: string): string {
  const summary = summarizeError(error, source);
  return `[${summary.errorClass}] ${summary.errorSource}: ${summary.errorReason}`;
}

/**
 * Infer a recovery action from the error type/message.
 */
function inferRecoveryAction(error: Error): string {
  const msg = error.message.toLowerCase();

  if (msg.includes('429') || msg.includes('rate limit') || msg.includes('quota')) {
    return 'Rotate API key or wait for cooldown';
  }
  if (msg.includes('503') || msg.includes('overloaded') || msg.includes('unavailable')) {
    return 'Fallback to alternate model';
  }
  if (msg.includes('401') || msg.includes('403') || msg.includes('unauthorized')) {
    return 'Check API key validity';
  }
  if (msg.includes('timeout') || msg.includes('ETIMEDOUT') || msg.includes('ECONNRESET')) {
    return 'Retry with backoff';
  }
  if (msg.includes('econnrefused') || msg.includes('ENOTFOUND')) {
    return 'Check service availability';
  }
  if (msg.includes('redis') || msg.includes('ioredis')) {
    return 'Check Redis connection';
  }
  if (msg.includes('token') && msg.includes('limit')) {
    return 'Reduce input size or compact context';
  }

  return 'Retry or escalate';
}
