# Performance Audit Report

## Overview

Full performance and logical audit of the gateway to fix bottlenecks causing overload, slowness, and poor recovery.

## Critical Issues Fixed

### 1. Tool-Count Complexity Removed ✅
**File:** `lib/agent/task-complexity.ts`
**Problem:** `toolCount >= 3` forced COMPLEX classification regardless of user intent.
**Fix:** Removed tool-count logic entirely. Complexity now depends on user intent, scope, and task keywords only.

### 2. Early Intent Short-Circuit ✅
**Status:** Already implemented in Task 10. `lib/agent/intent-detector.ts` detects trivial chat/questions and short-circuits before orchestrator.

### 3. Multi-Key Parallel Racing ✅
**File:** `lib/racing/key-racer.ts` (NEW)
**Problem:** Serial key retry: key1 → fail → backoff → key2 → fail → backoff = high latency.
**Fix:** Race up to 3 healthy keys simultaneously. First 2xx response wins, others abandoned. Configurable via `KEY_RACE_COUNT` env var.

### 4. Multi-Model Parallel Racing ✅
**File:** `lib/racing/model-racer.ts` (NEW)
**Problem:** Serial model fallback on overload: model1 → 503 → backoff → model2 → 503 → backoff.
**Fix:** Race primary + 2 fallback models simultaneously. Winner takes all. Text-only models get images stripped via `bodyTransformer`. Configurable via `MODEL_RACE_ENABLED` env var.

### 5. Token-Pressure Compactor ✅
**File:** `lib/transformers/compaction.ts`
**Problem:** Compaction only triggered when BOTH message count AND token budget were exceeded (AND logic). High token pressure with few long messages was never compacted.
**Fix:** Changed to OR logic — compact if EITHER limit is exceeded.

### 6. Admin Dashboard Decoupling ✅
**Files:** `lib/admin-cache.ts` (NEW), `app/api/admin/stats/route.ts`, `app/api/admin/activity/route.ts`
**Problem:** Every dashboard poll made 17+ Redis calls to stats endpoint.
**Fix:** In-memory cache with 10s TTL (configurable via `ADMIN_CACHE_TTL_MS`). Dashboard polls hit the cache instead of Redis on repeated requests within the TTL window.

### 7. Polling Reduction ✅
**Files:** `app/dashboard/logs/page.tsx`, `app/dashboard/orchestrator/page.tsx`
**Problem:** Logs page polled every 5s, orchestrator every 10s.
**Fix:** All dashboard pages now poll at 30s minimum. Logs auto-refresh defaults to OFF.

### 8. Fast Overload Failover ✅
**Status:** Already implemented in Task 10. Backoff: 500ms/1s/2s (was 2s/5s/10s). Combined with racing, worst case drops from ~26s to ~3s.

### 9. Orchestrator Short-Circuit ✅
**Status:** Already implemented in Task 10. `orchestrator-enforcer.ts` skips all orchestrator overhead for TRIVIAL_CHAT and QUESTION intents.

### 10. Dashboard Chart Fix ✅
**Files:** `app/dashboard/page.tsx`, `app/dashboard/stats/page.tsx`
**Problem:** `ResponsiveContainer` rendered with `width(-1) height(-1)` when parent not yet laid out.
**Fix:** Added `minWidth={100} minHeight={100} debounce={50}` to all `ResponsiveContainer` instances.

### 11. Performance Metrics ✅
**Files:** `lib/metrics/performance-tracker.ts` (NEW), `app/api/admin/performance/route.ts` (NEW), `lib/retry-engine.ts`
**Tracks:** TTFB, routing latency, key race latency, model race latency, compaction latency, total latency, overload recovery latency.
**Storage:** Redis with daily aggregation (p50, p95, avg). 2-day TTL per metric.
**API:** GET `/api/admin/performance?date=YYYY-MM-DD`

## Architecture: Racing Pipeline

```
Request → Key Race (3 keys parallel) → Winner? → Return
                                     ↓ No winner
         Model Race (3 models parallel) → Winner? → Return
                                        ↓ No winner
         Serial Retry Loop (existing, with overload recovery)
```

## Files Changed

| File | Action | Description |
|------|--------|-------------|
| `lib/agent/task-complexity.ts` | MODIFIED | Removed tool-count complexity logic |
| `lib/racing/key-racer.ts` | NEW | Parallel key racing (3 keys) |
| `lib/racing/model-racer.ts` | NEW | Parallel model racing (3 models) |
| `lib/retry-engine.ts` | MODIFIED | Integrated key+model racing before serial loop, perf metrics |
| `lib/transformers/compaction.ts` | MODIFIED | OR-based token pressure compaction |
| `lib/admin-cache.ts` | NEW | In-memory cache for admin API |
| `lib/metrics/performance-tracker.ts` | NEW | Performance metrics tracking |
| `app/api/admin/stats/route.ts` | MODIFIED | Cached with 10s TTL |
| `app/api/admin/activity/route.ts` | MODIFIED | Cached with 5s TTL |
| `app/api/admin/performance/route.ts` | NEW | Performance metrics API |
| `app/dashboard/page.tsx` | MODIFIED | Chart minWidth/minHeight fix |
| `app/dashboard/stats/page.tsx` | MODIFIED | Chart minWidth/minHeight fix |
| `app/dashboard/logs/page.tsx` | MODIFIED | 30s polling, auto-refresh off |
| `app/dashboard/orchestrator/page.tsx` | MODIFIED | 30s polling |
| `tests/task-complexity.test.ts` | MODIFIED | Updated tool-count expectation |

## New Test Files

| File | Tests | Description |
|------|-------|-------------|
| `tests/key-racer.test.ts` | 6 | Key racing: no keys, single, multi, dedup, failures |
| `tests/model-racer.test.ts` | 5 | Model racing: no keys, single, multi, all fail, transformer |
| `tests/performance-tracker.test.ts` | 5 | Metrics recording, percentiles, timer |
| `tests/admin-cache.test.ts` | 6 | Cache hit/miss, invalidation, TTL expiry |
| `tests/token-pressure-compaction.test.ts` | 3 | OR-based compaction triggers |
| `tests/complexity-no-toolcount.test.ts` | 3 | Tool count no longer drives complexity |

## Test Results

- **405 tests passing** across 42 suites (up from 376)
- **0 test failures**
- **29 new tests** added this task
- 23 empty suite warnings (pre-existing)

## Success Criteria

- [x] Tool-count complexity removed
- [x] Trivial requests fast-path
- [x] Parallel key racing works
- [x] Parallel model racing works
- [x] Token-pressure compactor works
- [x] Dashboard decoupled
- [x] Polling reduced
- [x] Overload recovery fast
- [x] Latency reduced
