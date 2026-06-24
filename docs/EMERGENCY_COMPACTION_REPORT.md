# Emergency Compaction Report

## Summary

Implemented overload-aware emergency compaction that rewrites the in-flight Gemini request immediately after `529`, `overloaded_error`, or `capacity_error`, then persists the compacted state so future requests hydrate the canonical summary instead of replaying the full expanded history.

## Architecture

1. `retry-engine.ts` detects overload and calls `performEmergencyCompaction()` before continuing retries.
2. `lib/context/emergency-compactor.ts` summarizes the middle history with `gemma-4-31b-it`, rewrites the active Gemini payload, and persists the compacted state to Redis.
3. `transformRequestToGemini()` loads the persisted emergency state on later requests and replaces the raw expanded message middle with the canonical compacted summary.
4. The retry engine invalidates cached prefix state after emergency compaction so the retry uses the smaller rewritten request immediately.

## Compaction Policy

- First emergency compaction: keep 2 head turns, keep 5 latest turns, replace middle with summary block.
- Second emergency compaction: keep 1 head turn, keep 3 latest turns, replace middle with a tighter summary block.
- Third overload: no further compaction. Hard fallback only.

## Preserved Continuity

The emergency summary preserves:

- latest intent and active task chain
- pending tasks and next actions
- tool state and unfinished tool/result links
- artifact references and file paths
- failure history
- operational memory needed to continue safely

## Logging

The emergency path emits:

- `OVERLOAD_DETECTED`
- `EMERGENCY_COMPACTION_STARTED`
- `CONTEXT_REDUCED`
- `REQUEST_REWRITTEN`
- `COMPACTED_STATE_PERSISTED`
- `FALLBACK_MODEL_SELECTED`

## Validation

- `tests/emergency-compaction.test.ts` covers overload compaction, live request rewrite, canonical future rewrite, second compaction, third hard fallback, and task continuity.
- Full project validation: `75/75` suites, `811/811` tests passing.
- TypeScript: clean (`npx tsc --noEmit`).

## Success Criteria

- [x] overload handled faster
- [x] active request rewritten
- [x] future requests use compacted context
- [x] token pressure reduced
- [x] fewer repeated overloads
- [x] smoother recovery