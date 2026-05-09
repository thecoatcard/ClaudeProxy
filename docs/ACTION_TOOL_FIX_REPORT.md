# ACTION_TOOL_FIX_REPORT.md

## Scope

This audit and fix pass covered only translator behavior (Anthropic <-> Gemini) in Edge-safe code paths.

Reviewed files:
- lib/transformers/request.ts
- lib/transformers/response.ts
- lib/transformers/stream.ts
- lib/transformers/repair.ts
- lib/retry-engine.ts

## Findings

### A) When does Gemini emit action-text instead of functionCall?

Observed in two real paths:
1. Model-side fallback behavior where a tool intent is emitted in plain text in the pattern:
   `[Action: I am calling tool ... with arguments: {...}]`
2. Gateway-induced demotion in request transform (previous behavior) when a historical tool_use had no stored thought signature; this created `[Action: ...]` text proactively.

### B) When does gateway demote tool calls into text?

Confirmed demotion point in previous request mapping:
- request.ts converted tool_use to text when `sigMap.get(toolId)` was missing.

This was the primary translator-side leakage source.

### C) When does thoughtSignature loss trigger fallback?

In retry-engine:
- 400 with thought-signature mismatch triggers `stripSigs + stripThinking` strategy.
- For fallback models, body preparation may strip thought signatures from thought-text parts while preserving functionCall structure.

This path is expected and now explicitly tested.

### D) When does model fallback degrade tool structure?

Fallback itself does not require tool-structure loss.
The degradation came from request-side demotion to text, not from fallback logic.

## Fixes Implemented

### 1) Prefer structured tool_use over text recovery

Implemented:
- Removed request-time demotion of tool_use into `[Action: ...]` text.
- request.ts now always emits structured `functionCall` for tool_use.
- thoughtSignature is attached when available, but absence no longer forces text mode.

Result:
- Function-call intent remains structured across normal translation flow.

### 2) Prevent `[Action: ...]` text leakage when recoverable

Implemented:
- Added robust shared parser in lib/transformers/action-recovery.ts.
- response.ts and stream.ts now recover parseable action-text into proper Anthropic `tool_use` blocks.
- Recovered action segment is removed from visible text output.

Result:
- Recoverable action-text does not leak to client text blocks.

### 3) Improve action-text parser robustness

Implemented parser improvements:
- Case-insensitive action-head detection.
- Handles quoted/backticked/unquoted tool names.
- Balanced JSON object extraction for nested braces.
- Rejects incomplete/invalid JSON safely.

Result:
- Robust conversion for recoverable action patterns with nested args.

### 4) Preserve functionCall integrity across retries/fallbacks

Implemented/validated:
- retry-engine `stripThoughtSignatures` is exported and tested.
- It preserves thoughtSignature on `functionCall` parts while stripping thought-text signatures.
- Request mapping no longer collapses tool calls to text before retry/fallback.

Result:
- Structured tool calls survive retry-preparation paths.

### 5) Improve thoughtSignature persistence reliability

Implemented:
- Added lib/transformers/metadata-persist.ts with `setexBestEffort` retry helper.
- response.ts and stream.ts switched tool metadata persistence to retrying best-effort writes.

Result:
- Better resilience to transient Redis/write failures without blocking stream.

### 6) Add logging for action-text recovery events

Implemented:
- response.ts logs `[action-recovery]` events with source/tool/recoveredChars.
- stream.ts logs `[action-recovery]` events with source/tool/recoveredChars.

Result:
- Recovery behavior is now observable in logs.

## Success Criteria Check

- [x] Claude Code sees tool UI, not `[Action: ...]` text (when recoverable)
- [x] functionCall preserved whenever possible
- [x] action-text fallback used only as emergency recovery path

## Edge Runtime Compliance

No filesystem APIs, shell execution, or Node-only runtime APIs were introduced in gateway runtime paths.
All changes remain translator-layer behavior.
