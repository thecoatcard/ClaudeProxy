# CONTEXT_IMPROVEMENTS.md

## Verdict

Current compaction was functional but not strong enough for long tool-heavy threads.
It could lose actionable continuity for:
- recent failed tool chains
- pending tool dependency chains
- explicit pending subtasks
- current objective/latest state in heuristic fallback summaries

Improvement pass was applied.

## Audit Summary

Inspected:
- compactMessagesDetailed in lib/transformers/compaction.ts
- rolling summary ingestion/storage in lib/transformers/request.ts
- AI and heuristic summary generation in lib/transformers/ai-compactor.ts and compaction.ts
- keepRecent and archive behavior in lib/tool-archive.ts + request.ts

### Evaluation Questions

1) Preserve critical tool history: Partially. Improved.
2) Preserve unfinished tasks: Weak in heuristic fallback. Improved.
3) Preserve tool_result failure history: Weak when failures are compacted into generic summaries. Improved.
4) Preserve tool_use dependencies: Boundary logic existed but did not explicitly preserve pending chains. Improved.
5) Task continuity: Improved via structured heuristic summary fields.
6) Over-truncation risk: unchanged hard caps, but summary now preserves operational facts.
7) keepRecent selection quality: improved with failure/pending anchors.
8) Summary quality: improved with goal/state/failure/path/pending sections.

## Implemented Improvements

### 1) Preserve unresolved task chains

Added boundary anchoring to keep pending tool chains:
- findPendingToolAnchor scans near boundary for assistant tool_use without corresponding later tool_result.
- If found, compaction start shifts earlier to keep chain intact.

### 2) Preserve failed tool history

Added failure anchoring and failure extraction:
- findRecentFailureAnchor keeps recent failed tool_result chains (with preceding tool_use when available).
- isToolFailureBlock detects failures by `is_error` and error text patterns.

### 3) Preserve latest working state and current objective

Heuristic summary generator replaced with operational summary builder:
- Current goal from latest user objective text.
- Latest working state from latest assistant progress text.

### 4) Preserve tool dependency chains

Boundary logic now combines:
- existing safe-boundary logic
- failure anchor
- pending-chain anchor

### 5) Preserve active file paths

Heuristic summary now extracts and includes likely file/path references seen in compacted turns.

### 6) Preserve pending subtasks

Heuristic summary now captures:
- unchecked checklist items (`- [ ]`)
- TODO / pending / next-step lines

### 7) Preserve failed attempts in summary quality

Heuristic summary now includes a dedicated failed-attempts section with tool name + first error line.

## Scenario Outcomes

### Scenario A: Long coding task with 50+ tool calls

Improved by keeping recent failure/pending chains near tail and preserving operational fields in summary.

### Scenario B: Long debugging session with retries

Improved by preserving recent failed attempts and tool dependency context.

### Scenario C: Long refactor with partial completion

Improved by carrying pending subtasks and latest state in summary.

### Scenario D: Tool failure history gets compacted away

Mitigated by failure anchoring + explicit failed-attempt extraction in summary.

### Scenario E: Task list partially completed across many turns

Mitigated by pending-subtask extraction and inclusion in summary body.

## Result

Compaction continuity is stronger for long, tool-heavy sessions while preserving existing architecture and Edge compatibility.
