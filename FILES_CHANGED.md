# FILES_CHANGED.md

## Added

- lib/compactor/ai-compactor.ts
  - New persistent semantic compactor module.
  - Adds compacted-range marker helpers, Redis save/load for compacted metadata, marker hydration, and chunked AI summary generation.
  - Persists compacted objects with fields: `conversation_id`, `compacted_range`, `summary`, `timestamp`.

- tests/ai-compactor.test.ts
  - New tests for compacted memory block normalization, metadata persistence, and marker hydration behavior.

- AI_COMPACTOR_REPORT.md
  - Implementation summary for Part B semantic compactor changes.

- BASH_RESTRICTION_AUDIT.md
  - Part A bash restriction classification and relaxation recommendations.

## Modified

- lib/transformers/compaction.ts
  - Switched AI compactor integration to `lib/compactor/ai-compactor.ts`.
  - Added support for `conversationId` and compacted-range TTL.
  - Stores summary per compacted range in Redis.
  - Emits `[COMPACTED MEMORY BLOCK]` formatted content with marker metadata.
  - Preserves existing heuristic fallback when AI compaction is unavailable.

- lib/transformers/request.ts
  - Adds conversation-id derivation for compaction persistence.
  - Hydrates compacted markers before compaction so future requests can restore semantic summaries.
  - Passes `conversationId` and TTL into compaction options.
