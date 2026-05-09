# Overload Recovery Report

## Summary

Implemented a complete overload recovery pipeline that prevents hard failures when Gemini API returns 503/overloaded errors. The pipeline follows the sequence: **compact → rotate key → fallback model → resume task**.

## Success Criteria

- [x] Overload no longer hard fails — `recoverFromOverload()` returns recovery options
- [x] Compaction triggers automatically — `compactBodyForOverload()` + proactive `detectTokenPressure()`
- [x] Key rotates correctly — `cooldownOverloadedKey()` + `rotateToFreshKey()` with 30s cooldown
- [x] Fallback model used — priority chain: `gemini-2.5-flash → gemini-3-flash-preview → gemini-3.1-flash-lite-preview → gemma-4-31b-it`
- [x] Subagent resumes correctly — `resumeOrchestratedExecution()` re-runs only PENDING/FAILED tasks
- [x] Orchestration preserved — completed subagent tasks survive recovery

## Architecture

```
overloaded_error / 503 / 429
  │
  ├─ 1. Classify error (isOverloadError / isRecoverableError)
  │
  ├─ 2. Cooldown overloaded key (30s Redis TTL)
  │
  ├─ 3. Detect token pressure (>900k chars → compact)
  │
  ├─ 4. Compact body (keep first 2 + last 4 messages, summarize middle)
  │
  ├─ 5. Rotate to fresh API key (up to 3 attempts, skip cooldown keys)
  │
  ├─ 6. Fallback to next model in priority chain
  │
  ├─ 7. Compute exponential backoff (2s → 5s → 10s + jitter)
  │
  ├─ 8. Save partial stream state (Redis-backed, 5min TTL)
  │
  └─ 9. Resume orchestrated subagents (only re-execute PENDING/FAILED)
```

## Integration Points

### retry-engine.ts (4 integration points)

1. **No-key-available path** — calls `recoverFromOverload()` before throwing
2. **Proactive token pressure** — compacts on attempt 1 if body > 900k chars
3. **Status 503/500 handler** — full recovery pipeline replaces raw fallback
4. **Catch block** — overloaded_error exceptions attempt recovery before rethrowing

### orchestrator-enforcer.ts

- New `resumeOrchestratedExecution(ctx)` function loads live tasks from Redis, filters to PENDING/FAILED, re-executes only remaining tasks, merges all results

## Phases Implemented

| Phase | Feature | Module |
|-------|---------|--------|
| 1 | Overload classifier | `lib/recovery/overload-recovery.ts` |
| 2 | Full recovery pipeline | `lib/recovery/overload-recovery.ts` |
| 3 | Body compaction on overload | `lib/recovery/overload-recovery.ts` |
| 4 | Key rotation with cooldown | `lib/recovery/overload-recovery.ts` |
| 5 | Model fallback priority chain | `lib/recovery/overload-recovery.ts` |
| 6 | Subagent resume | `lib/agent/orchestrator-enforcer.ts` |
| 7 | Token pressure detector | `lib/recovery/overload-recovery.ts` |
| 8 | Exponential backoff | `lib/recovery/overload-recovery.ts` |
| 9 | Stream state preservation | `lib/recovery/overload-recovery.ts` |
| 10 | Structured logging | `lib/recovery/overload-recovery.ts` |
| 11 | Tests (39 passing) | `tests/*.test.ts` |

## Test Results

- **39 new tests** across 4 test files, all passing
- **147/147 total tests** passing across the project
- **0 TypeScript errors** (`npx tsc --noEmit` clean)
