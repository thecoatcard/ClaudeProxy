# How Overload Is Decided

## Purpose

This file explains how the gateway decides that a request is overloaded and what it does next.

The decision is not based on a single check. It is based on a combination of:
- HTTP status codes
- provider error messages
- model-call timeouts
- request size and token pressure
- retry-engine context about the current model and key

## Main Decision Points

### 1. Overload classification

Primary code:
- `lib/recovery/overload-recovery.ts`
- `isOverloadError(...)`
- `isRecoverableError(...)`

The gateway treats a failure as overload-like when the status or message contains signals such as:
- `429`
- `503`
- `529`
- `overloaded`
- `overload_error`
- `capacity_error`
- `resource_exhausted`
- `rate limit`
- `quota exceeded`
- `too many requests`

This means overload is decided from both:
- explicit status codes
- provider message text

## 2. Timeout-based overload

Primary code:
- `lib/retry-engine.ts`
- `lib/runtime/response-watchdog.ts`

A model call timeout is also treated as overload-like behavior.

Why:
- sometimes the provider returns a clean `529`
- sometimes the provider does not fail fast and the call just hangs
- hanging on one model is operationally the same as overload for the current request

So if `callGemini(...)` exceeds the per-attempt timeout, the gateway treats it like capacity failure and enters the same recovery path.

## 3. Token-pressure-based overload prevention

Primary code:
- `lib/recovery/overload-recovery.ts`
- `detectTokenPressure(...)`
- `compactBodyForOverload(...)`
- `lib/retry-engine.ts`

The gateway also tries to predict overload risk before a model call.

It estimates pressure from the size of:
- system text
- Gemini `contents`
- Anthropic `messages`

If the request is too large, the gateway shrinks the middle of the conversation before racing or retrying.

This is not a direct overload signal from the provider.
It is a proactive decision that says:
- this request is large enough that it is likely to fail, stall, or waste retries

## 4. Retry-engine decision path

Primary code:
- `lib/retry-engine.ts`

When a request is executed, the retry engine checks the model result in this order:

1. `403`
- key/auth problem
- mark key bad
- move on

2. `429`
- rate-limit or overload-like
- trigger overload recovery

3. `503` or `>= 500`
- treat as backend overload/capacity failure
- trigger overload recovery

4. parsed body errors with transient backend wording
- also treated as overload-like

5. thrown overload-like exceptions
- same recovery path again

6. timeout exceptions
- also sent into overload recovery

So the retry engine does not rely only on one specific provider response shape.
It converges many failure shapes into one recovery decision.

## 5. What happens after overload is decided

Once overload is decided, the gateway does several things.

### A. Mark the current model as overloaded for this request

This prevents the same request from wasting time on the same failed model again.

### B. Cool down the failing key

Primary code:
- `cooldownOverloadedKey(...)`

The key is temporarily placed on cooldown in Redis so the selector is less likely to pick it immediately again.

### C. Rotate to a different key

Primary code:
- `rotateToFreshKey(...)`

The gateway tries to get a fresh key that is not currently cooled down.

### D. Move to a fallback model

Primary code:
- `getNextFallbackModel(...)`
- router fallback chain in `lib/model-router.ts`

The request advances to the next model instead of retrying the same one forever.

### E. Compact the request body

Primary code:
- `compactBodyForOverload(...)`
- `performEmergencyCompaction(...)`

There are two levels:
- fast synchronous shrink of the middle turns
- deeper emergency compaction with canonical future replacement

The current compact behavior is designed to preserve:
- the original opening prompt
- the newest active tail

And remove:
- the least useful middle turns

### F. Retry with shorter budgets

The retry loop now uses:
- shorter serial per-model timeouts
- a single pass through the model chain
- shorter overload backoff

This is meant to reduce the bad experience where a request sits for minutes before failing.

## 6. What is NOT treated as overload

Some failures are not overload decisions.

### Bad request `400`

If the payload itself is wrong, the gateway usually does request repair instead of overload recovery.
Examples:
- `thought_signature` mismatch
- invalid cache reference
- token-limit formatting issues
- malformed thinking config for the target model

These cases trigger payload degradation or cleanup, not overload cooldown logic.

### Pure authentication failure

`401` or `403` auth failures are key or credential problems, not overload.

## 7. Why the decision is intentionally broad

The provider does not always fail the same way.
Sometimes overload appears as:
- `529`
- `503`
- `429`
- `resource_exhausted`
- a hanging call that times out

If the gateway only watched for one exact signal, many overload cases would slip through and create long stalls.

So the overload decision is intentionally broad:
- if the model is unavailable
- or capacity is exhausted
- or rate limits are hit
- or the model hangs long enough to be useless

then the gateway treats it as overload for that request.

## 8. Practical summary

In simple words, the gateway decides overload like this:

- If the provider explicitly says it is overloaded, rate-limited, or unavailable, it is overload.
- If the provider hangs long enough to hit the request timeout for that attempt, it is also overload.
- If the request is huge, the gateway may shrink it before the provider fails, to prevent overload from happening.
- Once overload is decided, the gateway cools down the key, changes key/model, compacts context, and retries with shorter limits.

## 9. Main Files To Read

- `lib/recovery/overload-recovery.ts`
- `lib/retry-engine.ts`
- `lib/runtime/response-watchdog.ts`
- `lib/context/emergency-compactor.ts`
- `lib/model-router.ts`
