# FILES_CHANGED.md

## Added

- lib/transformers/action-recovery.ts
  - New robust parser to recover action-style tool text into structured tool_use blocks.
- lib/transformers/metadata-persist.ts
  - Best-effort Redis metadata persistence with retry for tool name/signature keys.
- tests/tool-structure.test.ts
  - Tool-structure fidelity tests (normal flow, retry prep, fallback prep, action recovery, leakage prevention).
- tests/context-compaction.test.ts
  - Context continuity tests (unfinished tasks, failed history, pending chains, goal/state retention).
- ACTION_TOOL_FIX_REPORT.md
  - Tool leakage audit and fixes report.
- CONTEXT_IMPROVEMENTS.md
  - Compaction audit outcome and applied improvements.

## Modified

- lib/transformers/request.ts
  - Removed request-time demotion of tool_use to `[Action: ...]` text when thoughtSignature is missing.
  - Always emits structured functionCall; attaches thoughtSignature when available.
- lib/transformers/response.ts
  - Uses shared action recovery parser.
  - Recovers parseable action-text to tool_use and strips it from visible text.
  - Improves schema lookup for repair (original tool name fallback).
  - Uses best-effort metadata persistence helper.
  - Adds action-recovery logging.
- lib/transformers/stream.ts
  - Uses shared action recovery parser for streaming text deltas.
  - Recovers parseable action-text to tool_use during stream and avoids leakage.
  - Improves schema lookup for repair (original tool name fallback).
  - Uses best-effort metadata persistence helper.
  - Adds action-recovery logging.
- lib/transformers/compaction.ts
  - Added failure detection helpers for tool_result blocks.
  - Added boundary anchors to preserve recent failed chains and pending tool dependency chains.
  - Replaced heuristic fallback summary with operational summary preserving:
    - current goal
    - latest working state
    - failed attempts
    - active file paths
    - pending subtasks
- lib/retry-engine.ts
  - Exported stripThoughtSignatures for direct retry/fallback integrity tests.

## Not Changed (Audit-only)

- lib/transformers/repair.ts
  - Kept as-is; still used for schema coercion on recovered/structured tool args.
