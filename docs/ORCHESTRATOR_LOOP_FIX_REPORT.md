# ORCHESTRATOR LOOP FIX REPORT

## Date: 2026-05-09

---

## Problem Summary

The orchestrator was entering recursive cycles:

```
orchestrator-status → subagents-assigned → task-decomposition → merge-completed
  → (repeat) orchestrator-status → subagents-assigned → ...
```

Root causes:
1. No terminal state — completed orchestrations could be re-entered
2. No deduplication — identical requests spawned duplicate orchestrations
3. Subagents regenerated on every request instead of being reused
4. Overloaded models retried the same model instead of skipping to fallback
5. Too many concurrent subagents saturated model capacity
6. Path auditor scanned full history → issue count grew across requests

---

## Phase-by-Phase Fixes

### Phase 1 — Terminal State Machine (`lib/agent/orchestrator-state.ts`)

Added lifecycle states: `PENDING → RUNNING → MERGED → COMPLETED | FAILED`

```
isTerminalState(state) → true for COMPLETED, FAILED, MERGED
transitionOrchestrationState() → ignores transitions out of terminal states
```

**Before**: No state — orchestration re-ran on every call.  
**After**: `isTerminalState` blocks re-entry; `finalizeMerge` transitions to COMPLETED permanently.

### Phase 2 — Deduplication (`lib/agent/orchestrator-lock.ts`)

Request fingerprint = `SHA-256(userId + model + firstMessage[:512])` — stored in Redis with 5-minute TTL.

`checkOrchestrationDedup(fingerprint)` returns `{ reuse: true, parentId, tasks }` when active orchestration exists.

**Before**: Each request spawned a new orchestration, including retransmissions.  
**After**: Duplicate requests reuse the existing orchestration.

### Phase 3 — Subagent Reuse (`lib/agent/orchestrator-lock.ts`)

When dedup finds an active orchestration, it loads the existing subagent tasks from Redis instead of regenerating them.

**Before**: New subtask stubs created on every call.  
**After**: Existing tasks reused; no duplicate execution.

### Phase 4 — Overload Protection (`lib/agent/subagent-executor.ts`)

`isOverloadError(message)` detects: `overloaded`, `overload_error`, `resource_exhausted`, `503`, `rate limit`, `quota exceeded`.

When detected: **immediately skip to next model in fallback chain** (no retry delay on overloaded model).

Updated fallback priority:
```
gemini-2.5-flash → gemini-3-flash-preview → gemini-3.1-flash-lite-preview → gemma-4-31b-it
```

**Before**: Overloaded model was retried (wasting time, causing cascading failures).  
**After**: Overloaded model is skipped immediately; next available model handles the task.

### Phase 5 — Concurrency Limiter (`lib/agent/subagent-executor.ts`)

`MAX_ACTIVE_EXECUTIONS = 3` — semaphore with queue.

`acquireSlot()` / `releaseSlot()` ensures at most 3 subagents execute simultaneously. Overflow tasks queue and execute when a slot opens.

**Before**: All subagents launched in parallel, saturating model rate limits.  
**After**: Maximum 3 concurrent executions; the rest queue.

### Phase 6 — Path Auditor Reset (`lib/agent/behavior-auditor.ts`)

Changed path audit scope from `messages.slice(-20)` to `[lastAssistantMessage]`.

```typescript
const lastAssistantMsg = [...messages].reverse().find((m) => m.role === 'assistant');
const pathScopeMessages = lastAssistantMsg ? [lastAssistantMsg] : [];
const pathIssues = inspectHistoryPaths(pathScopeMessages);
```

**Before**: Scanned last 20 messages → old path issues re-reported on every subsequent request.  
**After**: Only the most recent assistant turn is scanned → issues reset per request.

### Phase 7 — Merge Finalization (`lib/agent/orchestrator-state.ts`)

`finalizeMerge(parentId, output)` persists final output and transitions `RUNNING → MERGED → COMPLETED`.

The `finalOutput` field is stored in the orchestration record in Redis.

**Before**: Merge output was transient — not persisted; orchestration could reopen.  
**After**: Final output stored; state is COMPLETED (terminal) after merge.

### Phase 8 — Loop Detector (`lib/agent/orchestrator-state.ts`)

`checkAndIncrementLoopCount(parentId)` tracks `entryCount` per orchestration.

- Threshold: `MAX_LOOP_COUNT = 2`
- After 2 entries: forces COMPLETED, returns `{ allowed: false }`
- Terminal states: always return `{ allowed: false }`

**Before**: Same orchestration could loop indefinitely.  
**After**: After 2 re-entries, orchestration is force-completed.

### Phase 9 — Stream Safety (`lib/agent/orchestrator-enforcer.ts`)

`finalizeOrchestration()` now accepts `finalOutput` parameter and calls `finalizeMerge`.
Calling after stream end → COMPLETED (prevents re-entry).

Updated signature:
```typescript
finalizeOrchestration(ctx, artifacts?, finalOutput?)
```

**Before**: Stream end didn't guarantee terminal state.  
**After**: `finalizeOrchestration` always transitions to COMPLETED on call.

---

## Success Criteria

- [x] No orchestration recursion (terminal state blocks re-entry)
- [x] No subagent thrashing (dedup + reuse prevents regeneration)
- [x] Overload recovery works (immediate skip to fallback model)
- [x] Path auditor resets correctly (per-request scope only)
- [x] Completed tasks do not reopen (isTerminalState enforced)
- [x] Concurrency limited to MAX=3 (semaphore queues excess)
- [x] 108/108 tests passing
- [x] TypeScript: 0 errors
