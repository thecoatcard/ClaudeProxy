# FILES_CHANGED.md

## Added

- lib/models/capability-profile.ts
  - Defines normalized capability scores per Gemini/Gemma model for adaptive translator behavior.
- lib/transformers/adaptive-loop-policy.ts
  - Model-aware loop thresholds and guidance strength.
- lib/transformers/adaptive-action-policy.ts
  - Model-aware action-text recovery aggressiveness.
- lib/transformers/adaptive-compaction-policy.ts
  - Model-aware compaction timing, keepRecent policy, summary budget, and failure anchoring depth.
- lib/transformers/adaptive-guidance.ts
  - Model-aware corrective guidance strength for behavior interventions.
- tests/model-adaptive.test.ts
  - Verifies profile selection, loop thresholds, compaction policy, guidance strength, and recovery behavior.
- MODEL_ADAPTIVE_REPORT.md
  - Documents the adaptive policy implementation and validation results.
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
  - Applies adaptive compaction policy by target model.
  - Passes target model into adaptive behavior auditing.
  - Standardizes tool results to `{ ok: true, result }` or `{ ok: false, error }` envelopes.
- lib/transformers/response.ts
  - Uses shared action recovery parser.
  - Recovers parseable action-text to tool_use and strips it from visible text.
  - Improves schema lookup for repair (original tool name fallback).
  - Uses best-effort metadata persistence helper.
  - Adds action-recovery logging.
  - Applies model-adaptive recovery policy in non-stream responses.
- lib/transformers/stream.ts
  - Uses shared action recovery parser for streaming text deltas.
  - Recovers parseable action-text to tool_use during stream and avoids leakage.
  - Improves schema lookup for repair (original tool name fallback).
  - Uses best-effort metadata persistence helper.
  - Adds action-recovery logging.
  - Applies model-adaptive recovery policy during SSE streaming.
- lib/transformers/compaction.ts
  - Added failure detection helpers for tool_result blocks.
  - Added boundary anchors to preserve recent failed chains and pending tool dependency chains.
  - Replaced heuristic fallback summary with operational summary preserving:
    - current goal
    - latest working state
    - failed attempts
    - active file paths
    - pending subtasks
  - Accepts adaptive failure-anchor depth from compaction policy.
- lib/retry-engine.ts
  - Exported stripThoughtSignatures for direct retry/fallback integrity tests.
- lib/transformers/loop-detector.ts
  - Uses adaptive per-model repeat thresholds and stronger guidance for weaker tool models.
- lib/agent/behavior-auditor.ts
  - Accepts target model and appends adaptive reminder strength based on model profile.
- app/api/v1/messages/route.ts
  - Passes internal target model into non-stream response transformation.

## Not Changed (Audit-only)

- lib/transformers/repair.ts
  - Kept as-is; still used for schema coercion on recovered/structured tool args.
