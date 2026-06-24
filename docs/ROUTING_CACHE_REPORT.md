# Routing Cache Report

## Cache Model

### In-Memory Registry Cache

Model router now keeps a process-local registry cache with metadata:
- `version`
- `source`
- `loadedAt`
- `registry`

On each load:
- Compare Redis `models:registry:version` with cached version
- If same, reuse in-memory cache
- If changed, reload registry and replace cache

### Force Reload

Added `forceReloadRouting()`:
- clears in-memory cache
- reloads registry immediately
- returns diagnostics (`source`, `version`, `aliases`, `loadedAt`)

### Save-Time Invalidation

`saveRoutingRegistry()` does:
1. writes `models:registry`
2. increments `models:registry:version`
3. sets `models:registry:updatedAt`
4. calls `forceReloadRouting()`

This ensures save operations are live without restart.

### Sticky Cache Invalidation

Sticky routing keys now include registry version:
- old: `route:last:{user}:{model}`
- new: `route:last:v{version}:{user}:{model}`

Effect:
- route version bump invalidates stale sticky records automatically
- avoids stale model pinning after dashboard updates

## Tests

Validated by:
- `tests/routing-cache.test.ts`
  - force reload refreshes in-memory cache
  - save increments version and applies without restart
