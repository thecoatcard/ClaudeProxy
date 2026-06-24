# HTML_PATCH_REPORT

## Objective

Improve HTML edit reliability by replacing fragile raw block matching with selector-oriented patch guidance.

## Changes

1. HTML specialization strategy
- `lib/tools/structure-aware-patch.ts`
- `.html/.htm` now map to `DOM_SELECTOR`
- Guidance emphasizes patching by element id/class/tag scope

2. Loop detector integration
- `lib/transformers/loop-detector.ts`
- On HTML edit stagnation, guidance now includes:
  - selector-based targeting
  - stale snapshot re-read/hash verification
  - escalation path to write fallback

3. Freshness and loop safety
- Snapshot hash recording in `lib/transformers/request.ts`
- Stale/missing snapshot marks edit failures for stronger loop-break behavior

## Tests

- `tests/html-edit-reliability.test.ts`
  - verifies HTML extension maps to DOM selector strategy
  - verifies guidance references id/class selectors
  - verifies stagnation guidance includes selector specialization

## Result

HTML editing now avoids repeated block-match failures and converges to stable selector-scoped patching with freshness checks and fallback escalation.
