# Embedding Memory System Report

## Overview

Project-scoped embedding memory system for the CoatCard AI Gateway. Provides persistent, similarity-based context retrieval using Google `text-embedding-004` (768-dimension vectors).

## Architecture

```
User Request
    │
    ▼
extractQueryFromBody() ──► embedText() ──► VectorIndex.search()
                                                │
                                                ▼
                                          Top-K Results
                                                │
                                                ▼
                               mergeContextByPriority()
                                                │
                                                ▼
                                    Inject into Model Context
```

## Components

### 1. Embedding Engine (`lib/memory/embedding-engine.ts`)
- **Model**: Google `text-embedding-004` (768 dimensions)
- **Exports**: `embedText`, `embedBatch`, `embedFile`, `embedSummary`, `cosineSimilarity`
- **Batch API**: Up to 100 texts per request via `batchEmbedContents`
- **Text limit**: 30,000 chars per text (truncated)
- **API key**: Uses `getHealthiestKeyObj()` with failure reporting

### 2. File Ingestion (`lib/memory/file-ingestion.ts`)
- **Scans**: `src`, `app`, `components`, `lib`, `prisma`, `docs` + root configs
- **Ignores**: `node_modules`, `dist`, `.next`, `.coatcard`, lockfiles
- **Extensions**: `.ts`, `.tsx`, `.js`, `.jsx`, `.mjs`, `.json`, `.md`, `.mdx`, `.css`, `.scss`, `.prisma`, `.graphql`, `.yaml`, `.yml`, `.toml`
- **Max file**: 500KB, chunk size 8000 chars
- **Root configs**: `package.json`, `tsconfig.json`, `next.config.ts`, `jest.config.ts`, `eslint.config.mjs`

### 3. Vector Index (`lib/memory/vector-index.ts`)
- **Storage**: `.coatcard/retrieval-index/vectors.json`
- **Operations**: `insert`, `search` (top-k cosine), `update`, `remove`, `removeByPrefix`
- **Types**: `file`, `task`, `error`, `decision`, `architecture`
- **Persistence**: Manual `load()`/`save()` — no background writes

### 4. Incremental Embedding (`lib/memory/incremental-embedding.ts`)
- **Hash tracking**: SHA-256 in `.coatcard/artifacts/file-hashes.json`
- **Diff computation**: Returns `{ changed, unchanged, deleted }` against stored hashes
- **Workflow**: `computeDiff(files)` → embed changed → `recordEmbedding(file)` → `save()`

### 5. Summary Memory (`lib/memory/summary-memory.ts`)
- **Task summaries**: Completed auth flows, schema decisions, API architecture
- **Error summaries**: Prisma fixes, config fixes, dependency resolutions
- **Auto-embed**: `embedPending(vectorIndex)` embeds un-embedded summaries
- **Storage**: `.coatcard/summaries/summaries.json`

### 6. Retrieval Pipeline (`lib/memory/retrieval-pipeline.ts`)
- **Flow**: query → embed → search → filter → format
- **Limits**: Top 5 results, min 0.3 similarity, max 4000 chars
- **Formats**: Anthropic (`messages`) and Gemini (`contents`) request bodies
- **Output**: `RetrievalContext` with scored snippets

### 7. Context Priority (`lib/memory/context-priority.ts`)
- **Priority order** (highest first):
  1. Recent raw turns (never filtered)
  2. Operational memory (2000 token budget)
  3. Active task memory (2000 token budget)
  4. Embedding retrieval (2000 token budget)
  5. Compactor summaries (2000 token budget)
- **Total budget**: 8000 tokens max injected context
- **Truncation**: Blocks exceeding layer budget are proportionally truncated

### 8. Subagent Retrieval (`lib/memory/subagent-retrieval.ts`)
- **Scoped context**: Each subagent role gets domain-specific retrieval
- **Role detection**: Automatic from role description (`database`, `ui`, `api`, `coder`, etc.)
- **Query augmentation**: Role-specific keywords added to improve retrieval relevance
- **Limit**: 3 results per subagent (vs 5 for main context)

## .coatcard/ Directory Structure

```
.coatcard/
├── README.md
├── embeddings/          (raw embedding vectors)
├── summaries/           (task + error summaries)
├── task-graph/          (task dependency graphs)
├── artifacts/           (file hashes, incremental state)
├── operational-state/   (operational context snapshots)
└── retrieval-index/     (vector index for similarity search)
```

Directories `embeddings/`, `retrieval-index/`, `artifacts/`, `operational-state/` are in `.gitignore`.

## Test Results

| Test Suite | Tests | Status |
|---|---|---|
| `embedding-engine.test.ts` | 11 | ✅ PASS |
| `vector-index.test.ts` | 11 | ✅ PASS |
| `incremental-embedding.test.ts` | 10 | ✅ PASS |
| `retrieval-pipeline.test.ts` | 11 | ✅ PASS |
| `context-priority.test.ts` | 9 | ✅ PASS |
| `memory-integration.test.ts` | 8 | ✅ PASS |
| **Total** | **61** | ✅ **ALL PASS** |

## Dead Code Removed (Part 12)

| Item | Status |
|---|---|
| `lib/reasoning/gemma-helper.ts` + `tests/gemma-helper.test.ts` | Removed |
| `src/` directory (stale duplicate) | Removed |
| Root test scripts (`test-compaction-fixed.ts`, `test-gemini-*.mjs`, `test-gemma.mjs`) | Removed |
| `store/auth.ts` (unused Zustand store) | Removed |
| `lib/scripts/` (empty directory) | Removed |
| `scratch/` (empty directory) | Removed |
| `normalizeModelName()` duplication | Consolidated (model-router imports from capability-profile) |

## Success Criteria

- [x] `.coatcard/` directory created with proper structure
- [x] Embeddings persist to disk (vectors.json, file-hashes.json, summaries.json)
- [x] Retrieval works (top-k cosine similarity with threshold filtering)
- [x] Incremental updates work (SHA-256 hash-based change detection)
- [x] Task memory embedded (addTaskSummary → embedPending)
- [x] Error memory embedded (addErrorSummary → embedPending)
- [x] Subagent retrieval works (role-based scoped context)
- [x] Dead code removed
- [x] TypeScript compiles (no errors in new files)
- [x] All 61 tests pass
