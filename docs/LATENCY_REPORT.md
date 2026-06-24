# Latency Report

**Date:** 2026-05-10

---

## Request Latency Breakdown (Estimated)

### Greeting / Trivial Chat (CHAT route → gemini-2.5-flash-lite)
```
Auth + Route (parallel):     20-40ms
Transform (no compaction):   30-60ms
Gemini TTFB:                 300-800ms
Total streaming TTFB:        350-900ms
Total non-streaming:         600-1400ms
```
**Target: <2s** ✅

### Small Coding Fix (LIGHT_CODING → gemini-3-flash-preview)
```
Auth + Route (parallel):     20-40ms
Transform:                   40-80ms
Gemini call:                 800-2500ms
Total:                       900-2700ms
```
**Target: <5s** ✅

### Medium Coding Task (HEAVY_CODING → gemini-2.5-flash)
```
Auth + Route (parallel):     20-40ms
Context lookup:              20-30ms
Transform:                   50-100ms
Gemini call:                 3000-8000ms
Total:                       3100-8200ms
```
**Target: <10s** ✅

### Heavy Multi-file Architecture (HEAVY_CODING → gemini-2.5-flash)
```
Auth + Route (parallel):     20-40ms
Context compaction (maybe):  200-800ms
Transform + tool schema:     100-200ms
Gemini call:                 8000-18000ms
Total:                       8300-19000ms
```
**Target: <20s** ✅

### Explicit Reasoning Task (REASONING → gemma-4-31b-it)
```
Auth + Route (parallel):     20-40ms
Transform:                   50-100ms
Gemma call:                  4000-12000ms
Total:                       4100-12200ms
```
**Target: <15s** ✅

---

## Streaming TTFB Detail

The streaming path yields two events BEFORE calling Gemini:

```
t=0ms:    HTTP response headers + SSE stream opened
t=~5ms:   event: message_start   (immediate yield)
t=~10ms:  event: ping            (immediate yield)
t=Xms:    [Gemini API call in progress...]
t=X+Yms:  event: content_block_start  (first Gemini chunk received)
t=X+Yms:  event: content_block_delta  (first token)
```

This means the client receives a valid SSE response within milliseconds, avoiding platform initial-response timeouts (e.g., Vercel's 25s limit).

---

## Key Racing Latency Impact

When `KEY_RACE_COUNT=3`:

| Scenario | Serial (off) | Racing (on) |
|----------|-------------|-------------|
| All keys healthy | Same (slight overhead) | Same |
| 1 of 3 keys rate-limited | +60s cooldown wait | Instant fallback via race |
| 2 of 3 keys rate-limited | +120s wait | ~2-3x single key latency |
| Key pool exhausted | Error after full retry budget | Error faster (no wasted retries) |

**Recommendation:** Enable `KEY_RACE_COUNT=3` in production for meaningful pool sizes (>3 keys).

---

## Retry Loop Latency

The serial retry loop uses exponential backoff with jitter:

```
attempt 1: 0ms (immediate)
attempt 2: 120ms base + 0-120ms jitter
attempt 3: 240ms base + 0-120ms jitter
attempt 4: 480ms base + 0-120ms jitter
...
max: 1500ms base + 120ms jitter
```

Hard budget: `REQUEST_TIMEOUT` (default 240s). Budget exhaustion aborts retries early.

Max retries: `min(max(MAX_RETRIES, (fallbacks * 2) + 2), 12)` — at most 12 attempts.

---

## Redis Latency Breakdown

| Operation | Latency | Notes |
|-----------|---------|-------|
| `getHealthiestKeyObj` | 10-20ms | Pipeline top-10 candidates |
| `reportKeyFailure` | 5-10ms | Single pipeline |
| `recordKeyUsage` | 5-10ms | Single pipeline |
| Rolling summary lookup | 5-10ms | Single GET |
| Tool metadata (mget) | 8-15ms | Two parallel mget |
| Sticky model lookup | 3-8ms | Single GET |

Total Redis overhead per request: ~35-65ms (parallel where possible).
