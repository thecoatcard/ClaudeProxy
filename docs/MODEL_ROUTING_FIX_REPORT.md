# Model Routing Fix Report

## Root Cause Analysis

The routing editor was successfully writing to Redis (`models:registry`), but runtime behavior could stay on old models because sticky model selection had higher priority than registry values.

Primary issue:
- Sticky route key (`route:last:{user}:{model}`) was used before configured routing, so users remained pinned to stale models until TTL expiry.

Secondary issues:
- No explicit routing cache invalidation API.
- No versioned registry signal to invalidate process-local caches across instances.
- Admin API GET was not guaranteed to return the same effective registry path used by runtime mapping.

## Fixes Implemented

### Source of Truth and Priority

Implemented runtime source precedence exactly as requested:
1. Redis registry (`models:registry`)
2. Local JSON defaults (`lib/routing/default-model-routing.json`)
3. Hardcoded emergency defaults (`HARD_DEFAULT_MODEL_ROUTING`)

### Registry Loading and Persistence

- Added version key: `models:registry:version`
- Added timestamp key: `models:registry:updatedAt`
- Added central save API in router layer: `saveRoutingRegistry(models)`
- Added diagnostics API in router layer: `getRoutingDiagnostics()`
- Added effective registry accessor: `getEffectiveRoutingRegistry()`

### Sticky Routing Fix

- Sticky key is now version-scoped: `route:last:v{version}:{user}:{model}`
- Registry updates bump version, automatically invalidating old sticky pins
- Sticky model no longer overrides configured routing for normal traffic

## Admin Dashboard Integration

- `app/api/admin/models/route.ts` now saves through `saveRoutingRegistry()`
- POST returns live reload diagnostics (source, version, alias count)
- GET now returns effective runtime registry, not a separate ad-hoc path

## Runtime Logging Improvements

Added routing logs with:
- requested model
- resolved model
- routing source (`redis|local|hardcoded`)
- task type
- route version

Fallback-switch logs now include fallback reason:
- `server_overload`
- `server_error`
- `bad_request_400`
- `exception_400`

## Outcome

- Routing JSON updates now affect runtime immediately
- No process restart required
- Redis registry is the runtime source-of-truth
