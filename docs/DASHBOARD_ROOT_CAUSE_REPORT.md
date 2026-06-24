# Dashboard Root-Cause Analysis Report

## Summary
Deep root-cause analysis and fix of gateway dashboard and runtime issues across 20 phases.

## Issues Found & Fixed

### 1. Route Handler Contract Violation (Phase 1)
**Root Cause**: Admin route handlers returned `boolean` instead of `Response` objects.
**Fix**: All handlers now return `NextResponse.json(...)`.

### 2. Duplicate Auth API Calls (Phase 2, 5)
**Root Cause**: Both `layout.tsx` and `page.tsx` independently called `/api/auth/me`.
**Fix**: Created `AuthProvider` React context (`components/auth-provider.tsx`). Single fetch shared via `useAuth()` hook.

### 3. Chart Dimension Errors (Phase 3)
**Root Cause**: Recharts `ResponsiveContainer` rendered with 0-width/height before parent had layout.
**Fix**: CSS `min-height: 100px` on `.chart-wrap` / `.chart-wrap-lg` in `globals.css`.

### 4. Admin API N+1 Redis Pattern (Phase 4, 7)
**Root Cause**: `for` loops with individual `hgetall`/`hset` calls (e.g., 30 serial Redis calls for 6 models × 5 ops).
**Fix**: Converted to `redis.pipeline()` batch operations in 5 files:
- `app/api/admin/keys/route.ts` (GET, PATCH)
- `app/api/admin/user-keys/route.ts` (GET)
- `app/api/admin/system/route.ts` (healthCheck, activateAll, clearFailed)
- `app/api/admin/logs/route.ts` (modelObservability, keyObservability)

**Expected Speedup**: 10-50x for admin endpoints.

### 5. No Error Boundaries (Phase 9)
**Root Cause**: Any component crash took down the entire dashboard.
**Fix**: `DashboardErrorBoundary` wraps dashboard children in `layout.tsx`.

### 6. No Hard Timeouts on Model Calls (Phase 14, 17)
**Root Cause**: Model calls had 60s timeout; retry loop could stall for 12 minutes.
**Fix**: Created `lib/runtime/response-watchdog.ts`:
- `MODEL_CALL_TIMEOUT` = 20s
- `REQUEST_TIMEOUT` = 240s
- `withTimeout()` wrapper on all async operations
- `RequestWatchdog` class for stall detection

### 7. Stream Read Stall (Phase 15)
**Root Cause**: `reader.read()` in stream transformer had no timeout — could hang forever.
**Fix**: Wrapped with `withTimeout(reader.read(), 30_000, 'stream-chunk-read')`.

### 8. Retry Loop Unbounded (Phase 16)
**Root Cause**: Serial retry loop had no time budget check.
**Fix**: Added `requestTimer.elapsed() >= REQUEST_TIMEOUT` check at loop start.

## Test Results
- **428 tests passing**, 0 failures
- New test files: `response-watchdog`, `route-contract`, `admin-api-performance`, `stall-safety`

## Files Changed
| File | Change |
|------|--------|
| `lib/runtime/response-watchdog.ts` | NEW — timeout constants + withTimeout + RequestWatchdog |
| `components/auth-provider.tsx` | NEW — auth context provider |
| `components/error-boundary.tsx` | NEW — dashboard error boundary |
| `app/api/admin/keys/route.ts` | N+1 → pipeline |
| `app/api/admin/user-keys/route.ts` | N+1 → pipeline |
| `app/api/admin/system/route.ts` | N+1 → pipeline |
| `app/api/admin/logs/route.ts` | N+1 → pipeline |
| `app/dashboard/layout.tsx` | AuthProvider + ErrorBoundary |
| `app/dashboard/page.tsx` | useAuth() hook |
| `app/globals.css` | Chart min-height |
| `lib/retry-engine.ts` | Hard timeouts + time budget |
| `lib/gemini-adapter.ts` | 60s → 25s timeout |
| `lib/transformers/stream.ts` | 30s chunk read timeout |
| `lib/redis/client.ts` | Pipeline methods (exists, lrange, scan) |
