# TEST_RESULTS.md

## Dashboard Refactor — Test Run (Phase 5)

**61 tests | 0 failures | 16 suites**

```
npx tsx --test tests/dashboard-api-keys.test.ts tests/dashboard-auth-keys.test.ts tests/dashboard-routing.test.ts tests/dashboard-metrics.test.ts
```

```
ℹ tests 61  |  ℹ pass 61  |  ℹ fail 0  |  ℹ duration_ms 2252
```

TypeScript: `npx tsc --noEmit` → zero errors.

---

## Session: Web Search + Operational Context

### Commands Run

```
npx tsc --noEmit
npx tsx --test tests/web-search.test.ts tests/operational-context.test.ts
npx tsx --test tests/web-search.test.ts tests/operational-context.test.ts tests/interactive-command-guard.test.ts
```

### Outcome

| Check | Result |
|-------|--------|
| TypeScript (`npx tsc --noEmit`) | **PASS** (0 errors) |
| `tests/web-search.test.ts` | **24/24 pass** |
| `tests/operational-context.test.ts` | **20/20 pass** |
| Combined with `interactive-command-guard.test.ts` | **60/60 pass** |

### Bug Fixed During Testing

`operational-state.ts` background task failure detection: `"EADDRINUSE: address already in use"`
contains `"already"` which contains the substring `"ready"` — matching the npm startup signal.
Fixed by checking `isError` **before** startup signals in the task status update.

### web-search.test.ts Coverage

| Suite | Tests | Notes |
|-------|-------|-------|
| `isWebSearchTool` | 4 | Detection, edge cases, type safety |
| `partitionWebSearchTools` | 6 | Split, defaults, domain config, multi-entry merge |
| `WEB_SEARCH_FUNCTION_DECLARATION` | 1 | Gemini schema shape |
| `transformToolsToGemini with web_search` | 2 | Filter integration |
| `normalizeSearchResults` | 6 | Success, failure, empty, URL/title/rank preservation |
| `buildSearchFunctionResponse` | 2 | Success and error shapes |
| **Total** | **24** | |

### operational-context.test.ts Coverage

| Suite | Tests | Notes |
|-------|-------|-------|
| `shell type detection` | 4 | PowerShell, bash, git-bash, no-signal |
| `artifact tracking` | 4 | exists, failed_create, missing, source |
| `failure memory` | 3 | Interactive CLI, blocked escalation, permission denied |
| `background task tracking` | 4 | Detect, running signal, failed on error, no duplicate |
| `blocked patterns` | 3 | Guidance content, Windows warning, empty-state guard |
| `persistence (load/save)` | 5 | Round-trip, Redis miss, key format, corrupt JSON, ID mismatch |
| **Total** | **20** | |

---

## Session: Prior (abbreviated)

- TypeScript check: PASS
- Test suites: 14
- Total tests: 89
- Passed: 89
- Failed: 0

## Process Supervisor Coverage

- multi-language long-running command detection works
- startup log semantics analyzed correctly
- startup success signals override non-zero exit semantics for dev servers
- port fallback + ready signals classified as startup success
- guidance encourages non-blocking interval monitoring
- environment-aware termination guidance produced for Git Bash, PowerShell/CMD, Unix/WSL
- generic ecosystem support validated

## Notable Runtime Notes

- Existing offline Redis metadata logs (`fetch failed`) may still appear in unrelated translator tests and are non-fatal in local/offline test contexts.

## Final Status

Process supervisor implementation compiles and all requested tests/regressions pass.
