# Test Results

**Date:** JS/HTML tool reliability hardening (phases 1–8)  
**Run:** Full Jest suite after reliability hardening

---

## JS/HTML Tool Reliability — Final Results

| Metric | Before Session | After Session | Delta |
|---|---|---|---|
| Test suites | 78 | 83 | +5 |
| Tests | 929 | 944 | +15 |
| Failures | 0 | 0 | 0 |
| TypeScript errors | 0 | 0 | 0 |

### New Test Files Added

| File | Tests | Phases |
|---|---|---|
| `tests/js-edit-reliability.test.ts` | 3 | Phase 1, 3 |
| `tests/html-edit-reliability.test.ts` | 3 | Phase 1, 8 |
| `tests/windows-shell-fallback.test.ts` | 3 | Phase 4 |
| `tests/empty-agent-result.test.ts` | 2 | Phase 5 |
| `tests/snapshot-freshness.test.ts` | 4 | Phase 2 |

### Validation Commands

- `npx tsc --noEmit`
- `npx jest --passWithNoTests --no-coverage`

### Full Run Result

- Test Suites: **83 passed / 83 total**
- Tests: **944 passed / 944 total**
- TypeScript: **0 errors**

---

**Date:** Tool behavior hardening — 10-phase Claude Code-like tool flow  
**Run:** Full Jest suite after tool behavior hardening

---

## Tool Behavior Hardening — Final Results

| Metric | Before Session | After Session | Delta |
|---|---|---|---|
| Test suites | 74 | 78 | +4 |
| Tests | 830 | 929 | +99 |
| Failures | 0 | 0 | 0 |
| TypeScript errors | 0 | 0 | 0 |

### New Test Files Added

| File | Tests | Phases |
|---|---|---|
| `tests/edit-failure-classifier.test.ts` | 48 | Phase 2, 8 |
| `tests/edit-recovery.test.ts` | 36 | Phase 3, 4, 5 |
| `tests/tool-loop-detector.test.ts` | 22 | Phase 1, 7, 8 |
| `tests/tool-failure-memory.test.ts` | 19 | Phase 6 |

### Bug Fixed During Phase 9

**File**: `tests/tool-failure-memory.test.ts`  
**Root cause**: `jest.clearAllMocks()` does not drain unconsumed `mockRejectedValueOnce` queues. An error test's unconsumed `set` rejection persisted into the next test, silently swallowing the Redis write.  
**Fix**: Changed `jest.clearAllMocks()` to `jest.resetAllMocks()` in `beforeEach` to also drain queued once-values, then re-attach implementations via `mockImplementation`.

---

## Phase 9 Final Results (Security Hardening)

| Metric | Before Session | After Session | Delta |
|---|---|---|---|
| Test suites | 67 | 74 | +7 |
| Tests | 728 | 830 | +102 |
| Failures | 0 | 0 | 0 |
| TypeScript errors | 0 | 0 | 0 |

### New Test Files Added

| File | Tests | Phase |
|---|---|---|
| `tests/session-identity.test.ts` | 14 | Phase 1 |
| `tests/workspace-fingerprint.test.ts` | 28 | Phase 2 |
| `tests/hydration-null-policy.test.ts` | 12 | Phase 3 & 4 |
| `tests/session-binding.test.ts` | 16 | Phase 4 |
| `tests/archive-recovery.test.ts` | 13 | Phase 6 |
| `tests/dynamic-key-timeout.test.ts` | 15 | Phase 7 |
| `tests/provider-health-routing.test.ts` | 15 | Phase 8 |

### Updated Existing Tests

- `tests/context-isolation.test.ts` — 7 tests updated to reflect Phase 3 null workspace policy
- `tests/integration-pipeline.test.ts` — 1 test updated (null workspace triggers stale key deletion)

---

## Previous Results (2026-05-10)

## Latest Results

| Metric | Value |
|--------|-------|
| Test Suites | **75 passed / 75 total** |
| Tests | **811 passed / 811 total** |
| TypeScript Errors | **0** |
| Failures | **0** |
| Duration | ~15.7s |

## Emergency Compaction Coverage

| Suite | Coverage |
|-------|----------|
| `tests/emergency-compaction.test.ts` | overload compaction, active rewrite, canonical future rewrite, second compaction, third hard fallback, continuity preservation |
| `tests/overload-recovery.test.ts` | `529` and `capacity_error` detection, recoverable overload classification, fallback exhaustion |
| `tests/fallback-overload.test.ts` | immediate fallback chain order after overload |

## Current Baseline

| Session | Suites | Tests | Notes |
|---------|--------|-------|-------|
| Post-stabilization | 69/69 | 681/681 | Stable gateway baseline |
| 8-Phase Pass | 74/74 | 802/802 | Behavioral routing + dynamic racing + lifecycle + timeout + telemetry + token reduction |
| Emergency Compaction | **75/75** | **811/811** | Immediate overload compaction and canonical future replay |

## Final State

- TypeScript: 0 errors
- Jest: 75/75 suites, 811/811 tests
- Emergency compaction validated end-to-end

---

## Context Isolation Fix — 2026-05-10

**Run:** `npx jest tests/context-isolation.test.ts --no-coverage`

### New Tests: 20/20 passed

| Test | Verdict |
|------|---------|
| New workspace with stored workspace → blocks | ✓ HYDRATION_SKIPPED_WORKSPACE_MISMATCH |
| Same workspace + "continue" → allows | ✓ HYDRATION_APPROVED |
| /clear in messages → blocks | ✓ HYDRATION_SKIPPED_CLEAR_RESET |
| Trivial "hi" → blocks | ✓ HYDRATION_SKIPPED_LOW_CONTINUITY |
| Trivial "hello" → blocks | ✓ HYDRATION_SKIPPED_LOW_CONTINUITY |
| "continue" → allows | ✓ HYDRATION_APPROVED |
| "resume the previous task" → allows | ✓ HYDRATION_APPROVED |
| "hey" (trivial) → blocks | ✓ HYDRATION_SKIPPED_LOW_CONTINUITY |
| Established session + same workspace → approved | ✓ HYDRATION_APPROVED |
| Established session + /clear → blocked | ✓ HYDRATION_SKIPPED_CLEAR_RESET |
| Established session + workspace mismatch → blocked | ✓ HYDRATION_SKIPPED_WORKSPACE_MISMATCH |
| v2 marker detection | ✓ |
| v1 marker detection | ✓ |
| No marker → false | ✓ |
| Claude Code workspacePath extraction | ✓ |
| Cwd field extraction | ✓ |
| No workspace info → null | ✓ |
| Windows path normalisation | ✓ |
| Multi-turn (> 3 messages) → approved | ✓ HYDRATION_APPROVED |
| Both workspace roots null → does not block | ✓ HYDRATION_APPROVED |

### Full Regression Suite

```
Test Suites: 66 passed, 66 total
Tests:       689 passed, 689 total
TypeScript:  0 errors
```

Zero regressions.
