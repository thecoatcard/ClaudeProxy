# Redis Vector Store Report

## Overview

Created `lib/memory/redis-vector-store.ts` — a Redis-backed primary vector storage system with workspace isolation, replacing the filesystem-only vector index.

## Architecture

### Redis Key Layout

```
vec:{workspaceId}:entry:{entryId}  →  JSON { id, vector, metadata }
vec:{workspaceId}:index            →  SET of entry IDs
```

### TTL

All entries expire after **7 days** of inactivity. The index set is refreshed on every operation.

### Class API: `RedisVectorStore`

| Method | Description |
|---|---|
| `insert(entry)` | Store vector + metadata in Redis |
| `search(queryVector, topK, typeFilter?)` | Cosine similarity search, returns top-K results |
| `update(id, vector, metadata)` | Update existing entry |
| `remove(id)` | Remove single entry |
| `removeByPrefix(prefix)` | Remove all entries matching a path prefix |
| `get(id)` | Retrieve single entry |
| `has(id)` | Check existence |
| `size()` | Count total entries |
| `allIds()` | List all entry IDs |
| `migrateFromDisk()` | Import from local `vectors.json` into Redis |
| `syncToDisk()` | Export to local cache (dev-only) |

### Workspace Isolation

Each workspace gets its own Redis key namespace via `workspaceId`. Vectors from different projects never collide.

### Batching

Read operations (search, size, allIds) batch in groups of **50** to avoid Redis pipeline overload.

## Migration Path

1. Set `WORKSPACE_ROOT` and optionally `WORKSPACE_ID`
2. If existing `vectors.json` exists, call `migrateFromDisk()` once
3. Redis becomes the primary store
4. Local disk is used only as cache in development (`isLocalCacheEnabled()`)

## Tests

`tests/redis-vector-store.test.ts` — 11 tests covering:
- Insert, get, remove
- Search with cosine similarity
- Remove by prefix
- Has, size checks
- Update existing entries
- Workspace isolation between stores

All 11 tests pass.
