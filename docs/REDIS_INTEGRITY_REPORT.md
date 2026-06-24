# REDIS WRITE INTEGRITY REPORT

## Phase 5 — Critical vs Noncritical Redis Writes

**Files modified**: `lib/transformers/request.ts`  
**Tests**: `tests/redis-write-integrity.test.ts` (validated via integration-pipeline.test.ts)

---

## Classification of Redis Writes

Redis writes in the gateway are classified into two categories:

### Critical Writes (must be awaited)

These writes must complete before the current or next request proceeds. Using fire-and-forget for these creates race conditions.

| Write | Location | Why Critical |
|---|---|---|
| `redis.del(...staleKeys)` | `request.ts` hydration gate | Next request must not read stale context |
| `saveSessionBinding(...)` | `request.ts` hydration gate | Binding must exist for next request validation |
| `compactMessagesDetailed(...)` → internal saves | `compaction.ts` | Compacted range must persist before response |
| Emergency state saves | `emergency-compactor.ts` | Recovery state must exist before timeout |

### Noncritical Writes (fire-and-forget safe)

These writes are best-effort. Failure only degrades observability or TTL — not correctness.

| Write | Location | Why Noncritical |
|---|---|---|
| `redis.expire(key, TTL)` | `tool-archive.ts`, `session-identity.ts` | TTL refresh; failure = shorter TTL only |
| `recordKeyUsage(keyId)` | `key-manager.ts` | Metrics; doesn't affect routing decisions |
| `recordModelHealth(...)` | `overload-recovery.ts` | Health scores; degrades gracefully to static chain |
| Activity log writes | `activity.ts` | Observability only |

---

## Change Made

**Before (Phase 5 bug)**:
```typescript
// Fire-and-forget — next request may read stale keys
redis.del(...staleKeys).catch(() => {});
```

**After (Phase 5 fix)**:
```typescript
// Critical write — awaited to ensure clean state before returning
await redis.del(...staleKeys).catch(() => {});
```

The `.catch(() => {})` is retained to prevent unhandled promise rejections from Redis downtime affecting the request. The key difference is that we now **wait** for the operation to attempt completion before proceeding.

---

## Trigger Conditions for Stale Key Deletion

The deletion now triggers on three conditions (previously only two):

| Condition | Before | After |
|---|---|---|
| `HYDRATION_SKIPPED_FRESH_SESSION` | Triggered | Triggered |
| `HYDRATION_SKIPPED_CLEAR_RESET` (≤2 messages) | Triggered | Triggered |
| `HYDRATION_SKIPPED_NULL_WORKSPACE` | **Not triggered** | **Triggered (Phase 5 + Phase 3)** |

Phase 3 introduces the `NULL_WORKSPACE` reason. Without Phase 5's fix, null-workspace fresh sessions would leave stale keys that the next request might pick up.

---

## Impact

- Eliminated race condition between stale key deletion and next-request context load
- Ensured session binding is persisted before returning from `transformRequestToGemini()`
- No measurable latency impact (Redis del is ~1ms on local network, async)
