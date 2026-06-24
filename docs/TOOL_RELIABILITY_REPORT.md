# TOOL_RELIABILITY_REPORT

## Scope

Deep reliability hardening for JS/HTML-heavy editing and tool-loop stability.

Implemented phases:
- Phase 1: AST/DOM-aware patch strategy guidance for JS/TS/JSX/TSX/HTML
- Phase 2: Fresh file snapshot hashing and freshness enforcement signals
- Phase 3: Same-file + same-tool + same-failure loop breaker
- Phase 4: Platform-aware shell patch guard (Windows PowerShell vs Unix sed/bash)
- Phase 5: Empty subagent result detection (0-token/empty payload)
- Phase 6: Generated Python patch script validation guardrails
- Phase 7: Write fallback escalation after repeated failures
- Phase 8: HTML patch specialization by selector targeting

## Runtime Changes

1. Structure-aware patching and HTML specialization
- Added `lib/tools/structure-aware-patch.ts`
- Added `detectPatchStrategy()` with strategy mapping:
  - `.js/.ts/.jsx/.tsx` -> `AST_NODE`
  - `.html/.htm` -> `DOM_SELECTOR`
  - everything else -> `EXACT_REPLACE`
- Integrated guidance in `lib/transformers/loop-detector.ts`

2. Fresh snapshot enforcement
- Extended `lib/tools/tool-failure-memory.ts` with snapshot APIs:
  - `recordFileSnapshot()`
  - `getFileSnapshot()`
  - `isSnapshotFresh()`
- Integrated snapshot recording and stale marker in `lib/transformers/request.ts`:
  - successful read tool_result stores hash snapshot
  - edit failure records reason with `|STALE_SNAPSHOT` if snapshot is stale/missing

3. Tool loop breaker hardening
- `detectEditStagnation()` now requires same file + same tool + same failure type in repeated mode
- Recovery guidance now includes structure-aware + snapshot freshness instructions
- Existing write fallback escalation remains active on repeated failures

4. Platform-aware shell patching
- Added `lib/agent/tool-reliability-guard.ts`
- Added platform inference and command risk detection
- Integrated in `lib/agent/behavior-auditor.ts` diagnostics and guidance

5. Empty subagent result detection
- Updated `lib/agent/subagent-executor.ts`
- Added `isEmptySubagentResult()`
- Empty result (0 tokens + empty payload) now throws `EMPTY_SUBAGENT_RESULT` and triggers model fallback

6. Generated Python patch script validation
- Added validation risk detection in `lib/agent/tool-reliability-guard.ts`
- Integrated in `lib/agent/behavior-auditor.ts`
- Flags missing syntax/compile and regex validation steps for generated Python patch commands

## Tests Added

New suites:
- `tests/js-edit-reliability.test.ts`
- `tests/html-edit-reliability.test.ts`
- `tests/windows-shell-fallback.test.ts`
- `tests/empty-agent-result.test.ts`
- `tests/snapshot-freshness.test.ts`

Coverage highlights:
- JS files select AST-node strategy
- HTML files select DOM-selector strategy
- stagnation guidance includes structure-aware instructions
- Windows sed misuse is detected and guided to PowerShell
- empty subagent output retries on fallback models
- snapshot hash recording and freshness checks work

## Validation

- TypeScript: `npx tsc --noEmit` passed
- Full Jest suite: 83/83 suites passed, 944/944 tests passed

## Outcome

Tool reliability is now hardened against stale snapshot loops, brittle JS/HTML block matching, shell-platform mismatch, empty subagent completions, and unvalidated generated Python patch scripts.
