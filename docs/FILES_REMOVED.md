# Files Removed

Dead code removed as part of the embedding memory system task (Part 12).

## Deleted Files

| File/Directory | Reason |
|---|---|
| `lib/reasoning/gemma-helper.ts` | Dead code — 6 unused exports, only referenced by its own test |
| `tests/gemma-helper.test.ts` | Test for dead code above |
| `src/` (entire directory) | Stale duplicate of root `app/` directory |
| `test-compaction-fixed.ts` | Dev-only manual test script (not Jest) |
| `test-gemini-history.mjs` | Dev-only manual test script (not Jest) |
| `test-gemini-tool-call.mjs` | Dev-only manual test script (not Jest) |
| `test-gemma.mjs` | Dev-only manual test script (not Jest) |
| `store/auth.ts` | Unused Zustand store — zero imports |
| `lib/scripts/` | Empty directory |
| `scratch/` | Empty directory |

## Refactored

| Change | Details |
|---|---|
| `normalizeModelName()` in `lib/model-router.ts` | Removed duplicate function; now imports from `lib/models/capability-profile.ts` |
