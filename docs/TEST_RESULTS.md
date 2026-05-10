# Test Results

**Date:** 2026-05-10  
**Run:** Full Jest suite after overload-aware emergency compaction

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
