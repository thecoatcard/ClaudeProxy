# Embedding Lifecycle Report

**Phase 4 of the 8-Phase Focused Improvement Pass**

---

## Summary

Hardened the embedding memory pipeline with deletion sync, rename sync, stale cleanup, workspace isolation, and freshness validation. Previously, deleted and renamed files left ghost entries in Redis that polluted search results indefinitely.

---

## Problems Fixed

| Problem | Impact | Fix |
|---------|--------|-----|
| Deleted files not removed from Redis | Ghost vectors returned in similarity search | `applyIncrementalDiff()` propagates deletions |
| Renamed files created duplicate entries | Old path + new path both active | `applyIncrementalDiff()` handles rename = delete old + upsert new |
| Stale entries older than threshold never removed | Redis memory growth unbounded | `purgeStaleEntries(maxAgeMs)` pipeline-deletes old entries |
| No freshness visibility | Unknown embedding coverage | `checkFreshness()` returns ratio of fresh/stale entries |
| Lock files embedded unnecessarily | Noise in search results | `isEligibleExtension()` excludes lock file patterns |

---

## New Functions in `lib/memory/redis-vector-store.ts`

### `purgeStaleEntries(maxAgeMs = 8 days): Promise<number>`
- Scans all entries in the workspace-scoped key set
- Deletes entries where `lastUpdated` is older than `maxAgeMs`
- Uses Redis pipeline for batch deletion (single round-trip)
- Returns count of deleted entries

### `applyIncrementalDiff(diff): Promise<{deleted, renamed}>`
- Accepts `{ deleted: string[], renamed: Array<{oldPath, newPath}> }`
- For deleted: removes Redis key + set member for `file:{relativePath}`
- For renamed: removes old entry, re-inserts with new path key
- Pipeline-batched for efficiency

### `checkFreshness(freshnessWindowMs = 24h): Promise<FreshnessReport>`
- Audits all entries in the workspace
- Returns `{ total, fresh, stale, freshnessRatio }`
- `freshnessRatio = 0.0–1.0` (1.0 = all entries fresh)

---

## New Function in `lib/memory/file-ingestion.ts`

### Lock file exclusion in `isEligibleExtension()`
Excluded by basename match (not just extension):
- `pnpm-lock.yaml`, `yarn.lock`, `package-lock.json`, `Cargo.lock`
- `poetry.lock`, `Pipfile.lock`, `composer.lock`, `Gemfile.lock`

---

## Entry ID Convention

All Redis entries use the format: `file:{relativePath}` (e.g., `file:lib/auth.ts`).
The workspace-scoped key set is `embed:{workspaceId}:keys`.

---

## Files Changed

- `lib/memory/redis-vector-store.ts` — Added `purgeStaleEntries`, `applyIncrementalDiff`, `checkFreshness`
- `lib/memory/file-ingestion.ts` — Added lock file exclusion to `isEligibleExtension`
- `tests/embedding-lifecycle.test.ts` — NEW: lifecycle tests (FileHashStore diff, filters, hashing)

---

## Test Results

- `tests/embedding-lifecycle.test.ts`: all pass
- `tests/redis-vector-store.test.ts`: all pass (existing)
