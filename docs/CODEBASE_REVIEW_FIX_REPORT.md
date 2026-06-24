# Codebase Review Fix Report

## Scope

This pass focused on concrete, high-confidence bugs and architectural weak points that could be fixed safely without widening runtime risk:

1. Admin login brute-force exposure
2. Admin stats route failing hard on partial Redis read failures
3. Sticky route cache persisting an overloaded model after fallback
4. Model routing registry reads blocking on slow Redis metadata fetches

## Fixes Applied

### 1. Admin login rate limiting

File: `app/api/admin/session/login/route.ts`

- Added IP-based rate limiting using Redis
- Window: 60 seconds
- Limit: 5 attempts before returning `429`
- Successful login clears the attempt counter
- Redis failures do not block admin login entirely

Why this matters:

- Prevents trivial brute-force attempts against the admin session endpoint
- Keeps the route usable during transient Redis issues

### 2. Admin stats graceful degradation

File: `app/api/admin/stats/route.ts`

- Added `safeRedis()` wrappers around all stats reads
- Partial Redis failures now fall back to safe defaults instead of failing the whole response
- Daily stats generation now also degrades gracefully per key

Why this matters:

- The dashboard remains visible during partial Redis outages
- Operators get partial telemetry instead of a hard `500`

### 3. Sticky route invalidation on fallback

File: `lib/retry-engine.ts`

- Added `forgetLastWorkingModel()` helper
- Clears sticky route cache before switching away from a failing model
- Applied on 503 fallback transitions, overload recovery model switches, and fallback-based 400 recovery switches

Why this matters:

- Prevents a user from being pinned to a model that has already proven unhealthy
- Reduces repeated bad routing after overload events

### 4. Redis timeout protection for routing registry reads

File: `lib/model-router.ts`

- Wrapped routing registry/version Redis reads with `withTimeout(..., REDIS_TIMEOUT, ...)`
- Registry lookup now falls back faster when Redis is slow or stalled

Why this matters:

- Reduces request stalls caused by metadata reads
- Preserves hardcoded/local fallback routing under Redis instability

## Tests Added

- `tests/admin-session-login.test.ts`
- `tests/admin-stats-route.test.ts`
- `tests/retry-engine-sticky-route.test.ts`

## Validation Run

Focused validation:

- `npx jest tests/admin-session-login.test.ts tests/admin-stats-route.test.ts tests/retry-engine-sticky-route.test.ts`
- `npx jest tests/admin-api-performance.test.ts tests/route-contract.test.ts tests/model-router-imports.test.ts tests/model-router-redis.test.ts`
- `npx jest tests/subagent-retry.test.ts`
- `npx tsc --noEmit`
- `npx jest --passWithNoTests`

Final result:

- TypeScript: clean
- Jest: `65 passed, 65 total`
- Tests: `669 passed, 669 total`

## Remaining Risks Not Fixed In This Pass

These still look worth addressing, but they require a larger change surface or a dedicated design decision:

1. Admin session flow still relies on simple cookie presence rather than a stronger CSRF/session-binding scheme
2. Fire-and-forget Redis telemetry paths can still drop observability data silently during Redis failures
3. Web search tests still emit asynchronous console warnings after completion when provider env vars are missing
4. Key-manager lazy recovery behavior would benefit from stronger atomicity if concurrent recovery churn becomes visible in production

## Recommendation

The codebase is in a materially better state for admin safety and routing resilience after this pass. The next safe follow-up should target observability loss and the async web-search warning behavior, because both affect operator trust more than baseline correctness.