# Overload Recovery Report

## Summary

The overload recovery pipeline now reacts immediately to `529`, `overloaded_error`, and `capacity_error` instead of repeatedly retrying the same large payload. Recovery now follows: **detect overload → emergency compact current request → persist canonical compacted state → rotate key → move to next fallback model → retry with the rewritten payload**.

## Current Recovery Chain

- Classify overload via `isOverloadError()` / `isRecoverableError()`
- Trigger emergency compaction in `retry-engine.ts`
- Persist canonical compacted state in Redis
- Rotate away from the overloaded key
- Move to next fallback model immediately
- Retry with the rewritten body and cache disabled for that attempt

## Fallback Chain

Immediate post-compaction fallback order:

1. `gemini-2.5-flash`
2. `gemini-3-flash-preview`
3. `gemini-3.1-flash-lite-preview`
4. `gemini-flash-latest`

The failed model is not retried immediately after emergency compaction.

## Key Updates

- `retry-engine.ts` now triggers emergency compaction on overload responses and thrown `overloaded_error` exceptions.
- `lib/context/emergency-compactor.ts` performs Gemma-based middle-history compression, rewrites the active request, and persists canonical state.
- `transformRequestToGemini()` hydrates canonical emergency state on future requests so the gateway does not replay the original expanded history.
- `lib/recovery/overload-recovery.ts` now recognizes `529` and `capacity_error`, and the fallback chain ends with `gemini-flash-latest`.

## Validation

- Focused tests: `tests/emergency-compaction.test.ts`, `tests/overload-recovery.test.ts`, `tests/fallback-overload.test.ts`
- Full suite: `75/75` passing
- Total tests: `811/811` passing
- TypeScript: clean
