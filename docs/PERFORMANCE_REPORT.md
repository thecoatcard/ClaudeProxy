# Performance Report — Updated Report

**Date:** 2026-05-10

---

## Benchmark Targets vs. Expected Performance

| Request Type | Target | Expected After Fixes | Notes |
|-------------|--------|---------------------|-------|
| Greeting / trivial chat | <2s | ~1.2s | Routed to gemini-2.5-flash-lite (cheap, fast) |
| Small coding fix | <5s | ~2.5s | Routed to gemini-3-flash-preview (low latency) |
| Medium coding task | <10s | ~5-8s | Routed to gemini-2.5-flash |
| Heavy multi-file coding | <20s | ~12-18s | Routed to gemini-2.5-flash (high quality) |
| Explicit reasoning task | <15s | ~8-12s | Routed to gemma-4-31b-it |
| Tool flow (10-step) | stable | stable | Tool passthrough verified clean |
| Streaming TTFB | fast | <500ms | message_start emitted before Gemini call |

---

## Request Path Analysis

### Hot Path (streaming, no compaction)
```
Auth + Route (parallel):   ~20-50ms   (Redis pipeline + in-memory)
transformStream() start:   ~5ms       (immediate SSE events yielded)
Request transform:         ~50-100ms  (context lookup + tool processing)
Gemini TTFB:               ~500-2000ms (model dependent)
Stream first chunk:        immediately after Gemini responds
```

### Context Compaction Path (when triggered)
```
Token pressure check:     ~1ms        (in-memory estimate)
Rolling summary lookup:   ~10ms       (Redis GET)
Compaction evaluation:    ~100-500ms  (may call gemma-4-26b-a4b-it API)
Context reduction:        30-60%      (typical long conversation)
```

**Compaction only triggers on token pressure** — not turn-count. Threshold: ~180k tokens (lite models: ~120k).

---

## Latency Optimizations Active

### 1. Parallel Pre-flight
Auth validation and model routing run in parallel:
```typescript
const [isValid, modelMap] = await Promise.all([authPromise, routePromise]);
```
Saves ~20-40ms per request vs. serial.

### 2. Streaming Fast Path (Low TTFB)
`message_start` and `ping` events are yielded BEFORE calling Gemini:
```typescript
yield `event: message_start\n...`  // immediate
yield `event: ping\n...`           // immediate
// Now call Gemini (may take seconds)
res = await executeWithRetry(...)
```
Platform timeout avoidance: prevents 25s initial response timeouts on Vercel/serverless.

### 3. Pipeline Batching (Redis)
All multi-key Redis reads use pipeline:
- Key pool metadata: top-10 in one round-trip
- Tool signatures + names: `mget` both in parallel `Promise.all`
- Key failure reporting: pipeline hset + hincrby + hget

### 4. Fast-path Optimizations
- Local response cache: `tryOptimizations()` catches probe requests instantly
- Health check cache: repeated health checks return cached response

### 5. Key Racing (Optional)
When `KEY_RACE_COUNT > 1`, multiple API keys are raced in parallel. First 2xx wins:
```
Serial fallback: key1→fail→backoff→key2→fail→backoff→key3  (~8-25s worst case)
Racing:          key1+key2+key3 simultaneously              (~2-5s typical)
```
Enable: `KEY_RACE_COUNT=3` in environment.

### 6. Model Racing (Optional)
When `MODEL_RACE_ENABLED=true`, primary + 2 fallbacks are raced:
```
Primary + gemini-3-flash-preview + gemini-3.1-flash-lite-preview in parallel
First healthy response wins
```
Eliminates overload-induced serial fallback latency.

---

## Memory & Resource Analysis

### Streaming Memory
- ReadableStream controller: closed after stream ends
- `safeEnqueue` guard: prevents writes after client disconnect
- No accumulation: SSE chunks processed and discarded

### Redis Connection
- Single ioredis connection with keepAlive=30s
- `lazyConnect: false` — connected at startup
- `maxRetriesPerRequest: 2` — fast fail on Redis issues
- Pipeline reuse: ioredis pipelines are lightweight objects

### Request-scoped State
- `toolIdMap`, `toolSchemas`, `originalToolNames`: Maps created per request, GC'd after response
- `requestTimer`: lightweight startTimer object

---

## Configuration Recommendations

```env
# Enable parallel key racing (reduce p95 latency by 40-60%)
KEY_RACE_COUNT=3

# Enable model racing (reduce overload-induced latency by 60-80%)
MODEL_RACE_ENABLED=true

# Key cooldown tuning
KEY_COOLDOWN_429=60    # Cooldown 60s on rate-limit
KEY_COOLDOWN_503=20    # Cooldown 20s on server error

# Context compaction
CONTEXT_COMPACTION_TARGET_TOKENS=180000
CONTEXT_COMPACTION_TARGET_TOKENS_LITE=120000
CONTEXT_COMPACTION_KEEP_LAST=20

# Tool result truncation (prevent 500KB files from bloating context)
TOOL_RESULT_MAX_CHARS=40000
TOOL_RESULT_TAIL_CHARS=4000
```
