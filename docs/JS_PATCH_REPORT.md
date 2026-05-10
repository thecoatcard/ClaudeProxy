# JS_PATCH_REPORT

## Objective

Improve JS/TS editing reliability by reducing exact-string patch brittleness and loop retries.

## Changes

1. Strategy model for JS/TS
- `lib/tools/structure-aware-patch.ts`
- JS/TS/JSX/TSX now map to `AST_NODE`
- Guidance now explicitly prefers function-level/node-level targeting over large exact block replacement

2. Loop detector integration
- `lib/transformers/loop-detector.ts`
- Edit stagnation guidance now injects JS structure-aware patch recommendations
- Repeated failure detection tightened to:
  - same file
  - same tool
  - same failure type

3. Snapshot freshness integration
- `lib/tools/tool-failure-memory.ts` snapshot APIs
- `lib/transformers/request.ts` now records fresh hash snapshots from read results
- Edit failures annotate stale state with `|STALE_SNAPSHOT`

4. Write fallback escalation
- Existing `edit-recovery` pipeline remains active
- Repeated failures continue to escalate to write fallback and mandatory strategy change

## Tests

- `tests/js-edit-reliability.test.ts`
  - verifies JS extension maps to AST strategy
  - verifies guidance contains function/node targeting instructions
  - verifies stagnation output carries JS structure-aware guidance

## Result

JS/TS edit behavior now exits brittle exact-match loops faster and pivots toward stable node-scoped patching with snapshot freshness enforcement.
