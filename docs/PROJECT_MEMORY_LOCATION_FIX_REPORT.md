# Project Memory Location Fix Report

## Problem

`.coatcard` directories were being placed inside the **gateway root** (the Next.js app directory) rather than the **target workspace root** (the project being analyzed). This caused:

1. Memory data leaked across projects
2. Gateway root accumulated embedding data for unrelated projects
3. No workspace isolation — vectors from different projects mixed together

## Solution

### New Module: `lib/memory/project-memory-path.ts`

Canonical path resolution for all `.coatcard` memory directories:

| Function | Returns |
|---|---|
| `getWorkspaceRoot()` | Resolved from `WORKSPACE_ROOT` → `COATCARD_PROJECT_ROOT` → `process.cwd()` |
| `getCoatcardPath()` | `{workspaceRoot}/.coatcard` |
| `getEmbeddingsPath()` | `{workspaceRoot}/.coatcard/retrieval-index` |
| `getSummariesPath()` | `{workspaceRoot}/.coatcard/summaries` |
| `getArtifactsPath()` | `{workspaceRoot}/.coatcard/artifacts` |
| `getTaskGraphPath()` | `{workspaceRoot}/.coatcard/task-graph` |
| `getVectorsFilePath()` | `{workspaceRoot}/.coatcard/retrieval-index/vectors.json` |
| `getSummariesFilePath()` | `{workspaceRoot}/.coatcard/summaries/summaries.json` |
| `getFileHashesPath()` | `{workspaceRoot}/.coatcard/retrieval-index/file-hashes.json` |
| `isLocalCacheEnabled()` | `true` in dev/test, `false` in production |
| `getWorkspaceId()` | From `WORKSPACE_ID` env var or derived from workspace path |

### Environment Variables

| Variable | Purpose | Default |
|---|---|---|
| `WORKSPACE_ROOT` | Primary: target project root | — |
| `COATCARD_PROJECT_ROOT` | Fallback: target project root | — |
| `WORKSPACE_ID` | Redis key namespace | Derived from path |
| `ENABLE_LOCAL_MEMORY_CACHE` | Override local cache on/off | `true` in dev |

### Files Modified

- `lib/memory/vector-index.ts` — Uses `getVectorsFilePath()` instead of hardcoded path
- `lib/memory/file-ingestion.ts` — Uses `getWorkspaceRoot()` instead of `process.cwd()`
- `lib/memory/incremental-embedding.ts` — Uses `getFileHashesPath()` instead of hardcoded path
- `lib/memory/summary-memory.ts` — Uses `getSummariesFilePath()` instead of hardcoded path

### Verification

- `tests/project-memory-location.test.ts` — 19 tests covering all path functions, workspace isolation, and env var behavior
- All tests pass (272/272)

## Key Guarantee

> When `WORKSPACE_ROOT` is set, `.coatcard` is **never** placed inside the gateway root directory.
