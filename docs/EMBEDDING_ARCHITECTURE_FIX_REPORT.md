# Embedding Architecture Fix Report

## Summary

Complete architecture overhaul of the embedding memory system to fix workspace isolation, make filesystem optional, add intelligent ranking, and restore the Gemma reasoning helper.

## Changes

### 1. Project Memory Location (NEW)
- **File**: `lib/memory/project-memory-path.ts`
- `.coatcard` placed in workspace root (via `WORKSPACE_ROOT` env var), never gateway root
- All path functions centralized in one module

### 2. Redis Vector Store (NEW)
- **File**: `lib/memory/redis-vector-store.ts`
- Redis is primary vector storage with 7-day TTL
- Workspace-isolated key namespaces
- Cosine similarity search with batched reads

### 3. Filesystem-Optional File Ingestion
- **File**: `lib/memory/file-ingestion.ts`
- Dynamic `require('fs')` — never crashes if filesystem unavailable
- `supportsFileIngestion()` export for runtime capability check
- `scanProjectFiles()` returns empty result gracefully

### 4. Rename Detection
- **File**: `lib/memory/incremental-embedding.ts`
- `computeDiff()` detects file renames via hash→path reverse map
- `applyRename(oldPath, newPath)` updates hash records without re-embedding
- `IncrementalDiff` now includes `renamed: RenameDetection[]` field

### 5. Freshness Ranking
- **File**: `lib/memory/retrieval-pipeline.ts`
- `applyFreshnessRanking()` — exponential decay boost based on `embeddedAt` timestamp
- Half-life: 24 hours, max boost: 1.15x
- Task/error summaries get extra 1.05x freshness bonus

### 6. Adaptive Confidence Threshold
- **File**: `lib/memory/retrieval-pipeline.ts`
- `computeAdaptiveThreshold(query)` — returns 0.2–0.4 based on query specificity
- Short/vague queries → low threshold (0.2) — cast wider net
- Code-specific queries (camelCase, file paths, snake_case) → high threshold (0.4)
- Error-related queries → moderate threshold (0.35)

### 7. Retrieval Caching
- **File**: `lib/memory/retrieval-pipeline.ts`
- Results cached in Redis with 10-minute TTL
- Cache key based on query hash + topK + filter

### 8. Gemma Reasoning Helper (RESTORED)
- **File**: `lib/reasoning/gemma-helper.ts`
- `reason(task, context)` — core reasoning via `gemma-4-31b-it`
- Task-specific helpers: `reasonCompactionError`, `reasonDependencies`, `reasonContradictions`, `planOverloadCompaction`
- Redis caching with 5-minute TTL

### 9. Summary Memory Canonical Paths
- **File**: `lib/memory/summary-memory.ts`
- Uses `getSummariesFilePath()` from project-memory-path
- Disk I/O only when `isLocalCacheEnabled()` is true

### 10. Vector Index Refactor
- **File**: `lib/memory/vector-index.ts`
- Uses `getVectorsFilePath()` from project-memory-path
- Disk I/O only when `isLocalCacheEnabled()` is true
- Dynamic `require('fs')` instead of top-level import

## Test Coverage

| Test File | Tests | Status |
|---|---|---|
| `tests/redis-vector-store.test.ts` | 11 | ✅ Pass |
| `tests/freshness-ranking.test.ts` | 11 | ✅ Pass |
| `tests/adaptive-confidence.test.ts` | 11 | ✅ Pass |
| `tests/rename-detection.test.ts` | 8 | ✅ Pass |
| `tests/filesystem-optional.test.ts` | 7 | ✅ Pass |
| `tests/gemma-helper.test.ts` | 9 | ✅ Pass |
| `tests/project-memory-location.test.ts` | 19 | ✅ Pass |
| **Total** | **76** | **✅ All Pass** |

Full suite: 272 tests pass across 29 suites.

## Success Criteria

- [x] Redis is primary vector store
- [x] `.coatcard` is optional cache only
- [x] `.coatcard` uses workspace root
- [x] Gateway root is no longer used for `.coatcard` storage
- [x] Project isolation works
- [x] File ingestion optional
- [x] Rename detection works
- [x] Freshness ranking added
- [x] Adaptive confidence added
- [x] Gemma helper restored
- [x] Edge-safe architecture restored
