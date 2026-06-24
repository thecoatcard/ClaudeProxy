# Full Codebase Audit Report

**Date:** 2026-05-10  
**Scope:** Full gateway optimization and compatibility refactor  
**Goal:** Make gateway behave as transparent Anthropic-compatible infrastructure layer

---

## 1. Executive Summary

The gateway is a Next.js 16.2.4 application that translates Anthropic API calls to Google Gemini/Gemma API calls. After prior stabilization work (Phase 20), this audit identified and fixed remaining architectural issues across six categories: test infrastructure, model pool enforcement, smart routing, context compaction, streaming correctness, and Redis optimization.

**Result:** 0 architectural violations remaining. 69/69 test suites pass. 681/681 tests pass. TypeScript strict-mode clean.

---

## 2. Issues Found & Fixed

### 2.1 Test Harness (Critical)
**Problem:** 23 Jest test suites were failing silently. 22 test files imported `describe`/`it`/`beforeEach` from `node:test` (native Node.js runner) instead of using Jest globals. The tests ran under node:test but Jest saw 0 tests per suite and marked them as failed.

**Root causes:**
- All 22 files had `import { describe, it, ... } from 'node:test'` — incompatible with Jest
- `tests/redis-client.test.ts` imported `../lib/redis/client.js` (`.js` extension not resolved by ts-jest)
- `tests/tool-structure.test.ts` failed because `nanoid` v5+ is ESM-only and ts-jest uses CommonJS
- `tests/operational-context.test.ts` expected `opstate:v2:*` key but code uses `opstate:v3:*`
- `tests/redis-vector-store.test.ts` mocked `./embedding-engine` (local path) but module lives at `@/lib/memory/embedding-engine`
- `tests/task-router.test.ts` REASONING classification was missing from router

**Fixes:**
- Removed `node:test` imports from all 22 affected test files (Jest globals take over)
- Added `moduleNameMapper: { '^(\\.{1,2}/.*)\\.js$': '$1' }` to `jest.config.ts` to handle `.js` extension imports
- Added `moduleNameMapper: { '^nanoid$': '<rootDir>/__mocks__/nanoid.js' }` to handle nanoid ESM
- Created `__mocks__/nanoid.js` — CJS-compatible nanoid implementation
- Updated `tests/operational-context.test.ts` to expect `opstate:v3:*`
- Fixed `tests/redis-vector-store.test.ts` mock path to `@/lib/memory/embedding-engine`
- Restored REASONING classification in `lib/routing/task-router.ts` with precise keyword patterns

### 2.2 Model Pool Enforcement (High)
**Problem:** No enforcement of the allowed model pool. Redis config or code bugs could route to arbitrary model names, producing 404/400 errors from Gemini API.

**Allowed pool:**
- `gemma-4-31b-it`, `gemini-2.5-flash`, `gemma-4-26b-a4b-it`, `gemini-2.5-flash-lite`
- `gemini-3.1-flash-lite-preview`, `gemini-flash-latest`, `gemini-flash-lite-latest`, `gemini-3-flash-preview`

**Fixes:**
- Added `ALLOWED_MODEL_POOL` set in `lib/routing/task-router.ts` — exported for reuse
- Added `enforceModelPool()` and `enforceRoutePool()` in `lib/model-router.ts`
- Applied enforcement on all resolved chains before returning from `getModelMapping()`
- Sticky model from Redis validated against pool before use (prevent stale/invalid stickies)
- Default emergency fallback is always `gemini-2.5-flash` (always in pool)

### 2.3 Smart Model Routing (High)
**Problem:** Model chains did not match the specified routing strategy. LIGHT_CODING routed to `gemini-2.5-flash-lite` (chat model) instead of `gemini-3-flash-preview` (fast coding). COMPACTION routed to `gemma-4-31b-it` (larger) instead of `gemma-4-26b-a4b-it` (more efficient). REASONING detection was completely missing.

**Fixes applied to `lib/routing/task-router.ts`:**

| Task Type | Primary (Before) | Primary (After) | Reason |
|-----------|-----------------|-----------------|--------|
| REASONING | ❌ (Missing) | `gemma-4-31b-it` | Explicit reasoning restored |
| HEAVY_CODING | `gemini-2.5-flash` ✓ | `gemini-2.5-flash` ✓ | Correct |
| LIGHT_CODING | `gemini-2.5-flash-lite` | `gemini-3-flash-preview` | Fast coding, lower latency |
| CHAT | `gemini-2.5-flash-lite` ✓ | `gemini-2.5-flash-lite` ✓ | Correct |
| HEALTH_CHECK | `gemini-2.5-flash-lite` ✓ | `gemini-2.5-flash-lite` ✓ | Correct |
| COMPACTION | `gemma-4-31b-it` | `gemma-4-26b-a4b-it` | Efficient summarization |

REASONING detection restored with high-precision keyword patterns:
- `contradiction analysis`, `root cause reasoning`, `causal reasoning`
- `logical deduction`, `chain-of-thought`, `step-by-step reasoning`
- `mathematical proof`, `formal proof`, `bayesian reasoning`

Ordinary Claude Code work (`analyze`, `think`, `plan`) is NOT routed to Gemma — gateway is infrastructure only.

### 2.4 Context Compaction Model (Medium)
**Problem:** `lib/transformers/request.ts` hardcoded `model: 'gemma-4-31b-it'` for AI compaction. Per spec, compaction should use the smaller `gemma-4-26b-a4b-it` (more efficient for summarization).

**Fix:** Changed to `model: 'gemma-4-26b-a4b-it'`.

### 2.5 Streaming Path (Verified Clean)
**Status:** No issues found. Streaming already:
- Sends `message_start` + `ping` events immediately (low TTFB)
- Uses 30s per-chunk timeout via `withTimeout(reader.read(), 30_000)`
- Has `safeEnqueue` guard for client disconnects
- Has 5s keepalive ping interval to prevent upstream timeouts
- Correctly emits all SSE event types: `message_start`, `ping`, `content_block_start`, `content_block_delta`, `content_block_stop`, `message_delta`, `message_stop`
- Handles thinking blocks natively (Gemini `thought: true` parts)

### 2.6 Tool Passthrough (Verified Clean)
**Status:** No gateway interference detected. Tools pass through correctly:
- `lib/transformers/tools.ts`: Converts Anthropic `input_schema` → Gemini `functionDeclarations` format
- `lib/transformers/response.ts`: Converts Gemini `functionCall` → Anthropic `tool_use` format
- All Anthropic fields preserved: `tool_use.id`, `tool_use.name`, `tool_use.input`
- `tool_choice` → Gemini `toolConfig.functionCallingConfig` translation complete
- No gateway interception of tool results — they pass through as `tool_result` → Gemini user turn

### 2.7 Redis Optimization (Verified Efficient)
**Status:** Redis is well-optimized. Key patterns already in use:
- `getHealthiestKeyObj`: Pipelines top-10 key metadata in one round-trip
- `reportKeyFailure`: Single pipeline for hset + hincrby + hget
- `recordKeyUsage`: Single pipeline for all usage counters
- `restoreKeys`: Batch pipeline for cooldown recovery (runs on ~30% of requests)
- `request.ts`: Parallel `Promise.all([redis.get(summaryKey), getHealthiestKeyObj()])` for context lookup
- `request.ts`: Single `Promise.all([redis.mget(sigs), redis.mget(names)])` for tool metadata

---

## 3. Architecture Review

### 3.1 Request Flow (Clean)
```
Claude Code → POST /api/v1/messages
  → Auth check (hgetall user:key:{token})
  → Parallel: validateUserKey + getModelMapping
  → stream=true?
      → transformStream() — yields immediate events
          → transformRequestToGemini() — Redis lookups, compaction
          → executeWithRetry() → callGemini() → SSE stream
      → false:
          → transformRequestToGemini()
          → executeWithRetry() → callGemini() → JSON
          → transformGeminiToAnthropic()
```

### 3.2 No Orchestration (Confirmed)
- `prepareOrchestration`/`finalizeOrchestration` removed from live path
- `ENABLE_GATEWAY_ORCHESTRATOR=true` required to activate (default OFF)
- Gateway does NOT decompose tasks, create subagents, or merge results

### 3.3 Key Racing
- Parallel key racing: set `KEY_RACE_COUNT=3` (default 1 = disabled)
- Parallel model racing: set `MODEL_RACE_ENABLED=true` (default OFF)
- Serial retry loop: always active as fallback

### 3.4 Dashboard Isolation (Confirmed)
- Dashboard routes: `/api/admin/*`, `/dashboard/*`
- Inference route: `/api/v1/messages`
- Admin cache TTL: configurable via `ADMIN_CACHE_TTL_MS` (default 30s)
- Dashboard polling uses shared auth context — one auth call per layout render

---

## 4. Pre-existing Items (Not Changed)

The following were reviewed and confirmed acceptable:

| Item | Status |
|------|--------|
| 469 ESLint warnings (no-explicit-any, no-require-imports) | Pre-existing debt, not blocking |
| `console.info` in retry-engine.ts line 131 | Minimal, routing debug info |
| Unused imports in `lib/racing/key-racer.ts` | ESLint warns, no runtime impact |
| `math.random()` for key restore sampling (30%) | Acceptable for best-effort restore |

---

## 5. Recommendations for Future Work

1. **Enable racing by default**: Set `KEY_RACE_COUNT=3` and `MODEL_RACE_ENABLED=true` in production for lower p95 latency
2. **ESLint debt**: Fix `no-explicit-any` warnings incrementally — ~469 warnings across codebase
3. **Load testing**: Run load tests at 50/100/500 RPS to validate benchmark targets
4. **Embedding freshness**: Periodically re-embed system prompts as workspace context evolves
