# ARCHIVE MISS RECOVERY REPORT

## Phase 6 — Tool Archive Miss Recovery

**Module**: `lib/tool-archive.ts`  
**Tests**: `tests/archive-recovery.test.ts` — 13 tests passing

---

## Problem

When the gateway archives tool outputs under reference tokens like:

```
[GATEWAY ARCHIVE: fileList (ref:a1b2c3d4)]
```

…and Redis TTL (24h) has expired, retrieving the reference returns `null`. The model receives a reference token it cannot resolve — leading to hallucination or error recovery attempts.

---

## Solution

### `buildArchiveMissPlaceholder(toolName, hash): string`

Returns a descriptive message that the model can interpret:

```
[GATEWAY ARCHIVE EXPIRED: fileList output (ref:a1b2c3d4) is no longer in cache. Re-run fileList to retrieve the content again.]
```

The message explicitly instructs the model to re-run the tool. This is preferable to returning an empty string (which causes hallucination) or `null` (which crashes callers).

### `recoverArchivedOutput(sessionKey, toolName, hash): Promise<string>`

Safe wrapper around `retrieveArchivedOutput()`:

1. Calls `retrieveArchivedOutput(sessionKey, hash)`
2. If content exists → returns content (original behaviour)
3. If content is `null` (cache miss or expired) → returns `buildArchiveMissPlaceholder(toolName, hash)`
4. If Redis error → returns `buildArchiveMissPlaceholder(toolName, hash)` (no throw, no null)

**Invariant**: This function **never** returns `null` or an empty string.

---

## Archive Architecture

```
archiveToolOutput(sessionKey, toolName, content):
  hash = stableHash(content)[0..7]
  if redis.exists(sessionKey:archive:hash) → skip (deduplication)
  redis.set(sessionKey:archive:hash, content, EX 86400)
  return hash

retrieveArchivedOutput(sessionKey, hash):
  content = redis.get(sessionKey:archive:hash)
  if content → redis.expire(refresh TTL) → return content
  return null
```

---

## Callers

`recoverArchivedOutput()` should be called anywhere the gateway dereferences archive tokens. The old pattern of calling `retrieveArchivedOutput()` and checking for null should be replaced with `recoverArchivedOutput()`.

---

## Test Coverage

| Scenario | Function | Result |
|---|---|---|
| Content on hit | `recoverArchivedOutput` | Returns content |
| Placeholder on miss | `recoverArchivedOutput` | Returns placeholder |
| Placeholder on Redis error | `recoverArchivedOutput` | Returns placeholder |
| Never null | `recoverArchivedOutput` | Invariant confirmed |
| Never empty | `recoverArchivedOutput` | Invariant confirmed |
| Contains toolName | `buildArchiveMissPlaceholder` | Confirmed |
| Contains hash | `buildArchiveMissPlaceholder` | Confirmed |
| Contains re-run instruction | `buildArchiveMissPlaceholder` | Confirmed |
