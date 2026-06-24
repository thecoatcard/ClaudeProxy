# SESSION HARDENING REPORT
## Phases 1–8 — Gateway Security Hardening Pass

**Date**: Phase 9 completion  
**Test status**: 830/830 passing, 0 TypeScript errors  
**Files changed**: 12 source files, 7 new test files, 3 new session modules

---

## Overview

This report documents the 8-phase hardening pass applied to the coatcardaimagic gateway. Each phase addresses a specific correctness or security weakness in the session management, context hydration, and model routing systems.

---

## Phase 1 — Hard Session Identity

**Problem**: Fallback `conversationId` was derived from `hash(userId + systemText + firstMessage)`. Two different sessions opening the same workspace with the same first message would collide onto the same conversationId and share compacted context.

**Fix**: `lib/session/session-identity.ts`
- `getOrCreateSessionNonce(hashId)` — retrieves or creates a cryptographically-distinct nonce stored in Redis under `session:nonce:{slotHash}` (6 h TTL).
- `deriveHardSessionId(userId, workspaceFingerprint, nonce)` — new final identity: `hash(userId | workspaceFingerprint | nonce)`.
- `deriveSlotHash(userId, systemText, firstMessage)` — only used to address the nonce store (not exposed as conversationId).

The `summaryKey` retains the legacy anchor for backwards compatibility with stored summaries.

**Impact**: Eliminates session collision for anonymous sessions. Each new browser/terminal window gets a unique nonce → unique conversationId.

---

## Phase 2 — Workspace Fingerprinting

**Problem**: Workspace identity relied only on parsing Claude's system-text blocks with ad-hoc regex. Format changes or missing fields silently degraded isolation.

**Fix**: `lib/session/workspace-fingerprint.ts`
- `extractWorkspaceRoot(systemText, messages)` — multi-source extraction in priority order: `<workspacePath>` tag → `<cwd>` tag → `Cwd:` header → `Current Working Directory (...)` → message scan (first 4 messages).
- `normalizePath(rawPath)` — backslash→slash, lowercase, trim trailing slash.
- `computeWorkspaceFingerprint(systemText, messages)` — returns `{ fingerprint, normalizedPath, confidence }`.
- `compareWorkspaceFingerprints(a, b)` — returns `'match' | 'mismatch' | 'unknown'`.

The fingerprint (8-char hex) is used in session binding and logged for observability.

---

## Phase 3 — Safe Null Workspace Policy

**Problem**: `workspacesMatch()` in `hydration-guard.ts` returned `true` when both workspace roots were null/undefined, silently allowing hydration for sessions with no workspace proof.

**Fix**: `lib/context/hydration-guard.ts`
- `workspacesMatch(current, stored, hasExplicitConversationId)` — **both null → `return false`** unless `hasExplicitConversationId` is true.
- New `HydrationSkipReason`: `'HYDRATION_SKIPPED_NULL_WORKSPACE'`
- `evaluateHydration()` — workspace gate now distinguishes null-null (→ `NULL_WORKSPACE`) from real mismatches (→ `WORKSPACE_MISMATCH`).
- `evaluateHydrationForEstablishedSession()` — compacted-marker sessions are exempt (compacted marker itself proves workspace at time of compaction).

**Exception**: Explicit `conversationId` from client metadata is trusted → null-null is permitted (client manages own lifecycle).

**Impact**: Prevents cross-session context leakage for sessions without workspace detection.

---

## Phase 4 — Session Token Binding

**Problem**: No mechanism to verify that a `conversationId` was created by the same user and workspace. A different user could attempt to use a known conversationId to access another user's context.

**Fix**: `lib/session/session-binding.ts`
- `saveSessionBinding(conversationId, userId, fingerprint, nonce)` — stores `{ userHash, workspaceFingerprint, nonce, createdAt }` in Redis under `session:binding:{conversationId}` (6 h TTL, NX semantics — first writer wins).
- `validateBinding(binding, userId, fingerprint)` — returns `'valid' | 'mismatch' | 'new'`.
- New gate in `evaluateHydration()` and `evaluateHydrationForEstablishedSession()`: `HYDRATION_SKIPPED_BINDING_MISMATCH`.
- `userHash = stableHash(userId)` — raw API key is never stored in Redis.

**Impact**: Cross-user context access now denied at the hydration layer.

---

## Phase 5 — Critical vs Noncritical Redis Writes

**Problem**: The stale key deletion in `transformRequestToGemini()` was fire-and-forget (`redis.del(...).catch(() => {})`). If the event loop moved to the next request before deletion completed, the next request could read stale context.

**Fix**: `lib/transformers/request.ts`
- Stale key deletion is now **awaited**: `await redis.del(...).catch(() => {})`.
- Trigger expanded to include `HYDRATION_SKIPPED_NULL_WORKSPACE` (Phase 3 new reason).
- Session binding save is awaited on new sessions.
- Noncritical writes (metrics, TTL refreshes, fire-and-forget logs) remain `.catch(() => {})`.

**Classification**:
| Write | Category | Rationale |
|---|---|---|
| `redis.del(staleKeys)` | **Critical** | Next request must see clean state |
| `saveSessionBinding(...)` | **Critical** | Binding must exist before next request |
| `redis.expire(...)` TTL refresh | Noncritical | Best-effort; failure = shorter TTL |
| `recordKeyUsage(...)` | Noncritical | Metrics; doesn't affect correctness |

---

## Phase 6 — Tool Archive Miss Recovery

**Problem**: When `[GATEWAY ARCHIVE: ...]` reference tags appeared in conversation history but Redis TTL had expired, the gateway returned no content — the model saw a broken reference token with no explanation.

**Fix**: `lib/tool-archive.ts`
- `buildArchiveMissPlaceholder(toolName, hash)` — returns `"[GATEWAY ARCHIVE EXPIRED: {toolName} output (ref:{hash}) is no longer in cache. Re-run {toolName} to retrieve the content again.]"`.
- `recoverArchivedOutput(sessionKey, toolName, hash)` — attempts `retrieveArchivedOutput()`, returns actual content on hit, or `buildArchiveMissPlaceholder()` on miss. **Never returns null or empty string.**

**Impact**: Model now receives a meaningful explanation on archive miss, prompting it to re-run the tool rather than hallucinating the missing data.

---

## Phase 7 — Dynamic Key Race Timeout

**Problem**: `getFastPathRaceTimeoutMs()` returned a fixed 3500ms (or env override). Short interactive tasks (CHAT) wasted 3.5s on races; complex tasks (REASONING) had insufficient time.

**Fix**: `lib/retry-engine.ts`
- `getFastPathRaceTimeoutMs(taskType?)` — adaptive per task type:

| Task Type | Timeout | Rationale |
|---|---|---|
| CHAT / HEALTH_CHECK | 2000ms | Fast responses expected |
| LIGHT_CODING / WEB_SEARCH / COMPACTION | 3500ms | Default (unchanged) |
| HEAVY_CODING | 5000ms | Complex tasks need more time |
| REASONING | 6000ms | Gemma reasoning is slower |
| OVERLOAD | 3000ms | Recovery path: don't add extra wait |

- `FAST_PATH_RACE_TIMEOUT` env override still respected (clamped to 1000ms–MODEL_CALL_TIMEOUT).
- Both `keyRace` and `modelRace` call sites now pass `modelMap.taskType`.

---

## Phase 8 — Provider Health-Aware Model Ordering

**Problem**: `OVERLOAD_FALLBACK_CHAIN` was a static priority list. If `gemini-3-flash-preview` was experiencing sustained outage, it would still be tried before healthier models.

**Fix**: `lib/recovery/overload-recovery.ts`
- `recordModelHealth(model, outcome, latencyMs)` — stores `{ failures, successes, totalLatencyMs, overloadCount, updatedAt }` in Redis under `provider:health:{model}` (1 h TTL).
- `getModelHealth(model)` — loads stored health, returns zero-initialized record for unknown models.
- `getHealthAwareFallbackChain(currentModel, triedModels)` — dynamically re-ranks candidates by health score: `(failures × 10) + (overloadCount × 5) − successes`. Gemma models get +50 penalty to preserve last-resort ordering unless Gemini models are all degraded.
- `getNextFallbackModelHealthAware(currentModel, triedModels)` — async wrapper; degrades to static `getNextFallbackModel()` on Redis error.
- `recoverFromOverload()` now uses `getNextFallbackModelHealthAware()`.

---

## Verification

```
Test Suites: 74 passed, 74 total
Tests:       830 passed, 830 total
Snapshots:   0 total
TypeScript errors: 0
```

## Success Checklist

- [x] Hard session identity implemented (`lib/session/session-identity.ts`)
- [x] Workspace fingerprinting added (`lib/session/workspace-fingerprint.ts`)
- [x] Null workspace hydration denied (`lib/context/hydration-guard.ts` Phase 3)
- [x] Session binding enforced (`lib/session/session-binding.ts`)
- [x] Redis writes categorized (critical: awaited; noncritical: fire-and-forget)
- [x] Archive miss recovery safe (`lib/tool-archive.ts` Phase 6)
- [x] Adaptive key timeout working (`lib/retry-engine.ts` Phase 7)
- [x] Provider health-aware routing working (`lib/recovery/overload-recovery.ts` Phase 8)
