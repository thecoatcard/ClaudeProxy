# Test Results

**Date:** 2026-05-10  
**Run:** Full Jest suite after 8-Phase Focused Improvement Pass

## Latest Results

| Metric | Value |
|--------|-------|
| Test Suites | **74 passed / 74 total** |
| Tests | **802 passed / 802 total** |
| TypeScript Errors | **0** |
| Failures | **0** |
| Duration | ~13s |

## New Test Suites Added This Session (5)

| Suite | Tests | Phase |
|-------|-------|-------|
| `tests/behavior-routing.test.ts` | 44 | Phase 1 |
| `tests/dynamic-key-racing.test.ts` | ~12 | Phase 2 |
| `tests/dynamic-model-racing.test.ts` | ~18 | Phase 3 |
| `tests/embedding-lifecycle.test.ts` | ~30 | Phase 4 |
| `tests/web-search-timeout.test.ts` | ~12 | Phase 5 |

## Tests Fixed This Session

| Test | Root Cause | Fix |
|------|-----------|-----|
| `behavior-routing.test.ts` (×2) | Trailing `\b` in REASONING regex prevented `probabilistic reasoning` / `bayesian reasoning` matches | Removed trailing `\b` |
| `interactive-command-guard.test.ts` | Checked for `'GATEWAY INTERACTIVE COMMAND GUARD'` prefix (changed to `'INTERACTIVE'`) | Updated assertion |
| `model-adaptive.test.ts` | Checked for old 4-sentence strong reminder text | Updated regex |
| `orchestrator-enforcer.test.ts` (×2) | Checked for `'coordinator'` lowercase (injection now uses `'COORDINATOR'`) | Updated assertion |
| `embedding-lifecycle.test.ts` | `isEligibleExtension('pnpm-lock.yaml')` returned `true` (`.yaml` was in `INCLUDE_EXTENSIONS`) | Added `LOCK_FILE_PATTERNS` exclusion |

## Historical Results

| Session | Suites | Tests | Notes |
|---------|--------|-------|-------|
| Pre-optimization | 46/69 | 429/429 | 23 suites failing |
| Post-stabilization | 69/69 | 681/681 | All suites fixed |
| 8-Phase Pass | **74/74** | **802/802** | 5 new suites added |
| dashboard-metrics.test.ts | node:test import | Removed import |
| dashboard-routing.test.ts | node:test import | Removed import |
| ai-compactor.test.ts | node:test import | Removed import |
| auth-redis.test.ts | node:test import | Removed import |
| context-compaction.test.ts | node:test import | Removed import |
| operational-context.test.ts | node:test import + v2 key | Fixed v2 -> v3 |
| task-router.test.ts | node:test + REASONING missing | REASONING restored |
| tool-structure.test.ts | node:test + nanoid ESM | nanoid CJS mock added |
| redis-client.test.ts | node:test + .js extension | moduleNameMapper added |
| redis-vector-store.test.ts | Wrong mock path | Fixed to @/lib/memory/embedding-engine |
| (all 22 others) | node:test import | Removed import |

## Final State

- TypeScript: 0 errors
- Jest: 69/69 suites, 681/681 tests (up from 46/69 suites, 429 tests)
- ESLint: 469 pre-existing warnings (no-explicit-any) � not blocking
