# Redis Migration Report

**Migration**: `@upstash/redis` → `ioredis`  
**Target URL format**: `REDIS_URL=redis://default:PASSWORD@HOST:PORT`  
**TypeScript**: ✅ clean (0 errors)  
**Tests**: ✅ 38/38 pass

---

## Overview

The gateway was migrated from the Upstash HTTP REST Redis client (`@upstash/redis`)
to the standard TCP Redis client (`ioredis`). All Redis-based features are preserved
with no key renames and no API changes visible to callers.

---

## Files Changed

| File | Change |
|------|--------|
| `lib/redis/client.ts` | **Created** — ioredis singleton + Upstash-compatible wrapper |
| `lib/redis.ts` | Re-exports `redis` from `./redis/client` |
| `next.config.ts` | Added `serverExternalPackages: ['ioredis']` |
| `app/api/v1/messages/route.ts` | `runtime = 'edge'` → `runtime = 'nodejs'` |
| `app/api/v1/messages/count_tokens/route.ts` | `runtime = 'edge'` → `runtime = 'nodejs'` |
| `app/api/admin/reset-keys/route.ts` | `runtime = 'edge'` → `runtime = 'nodejs'` |
| `activate-keys.mjs` | Rewritten to use ioredis instead of Upstash HTTP REST |
| `package.json` | Removed `@upstash/redis`; `ioredis` was already present |
| `tests/redis-client.test.ts` | **Created** — pipeline and wrapper unit tests |
| `tests/auth-redis.test.ts` | **Created** — auth logic Redis tests |
| `tests/metrics-redis.test.ts` | **Created** — metrics pipeline behaviour tests |
| `tests/model-router-redis.test.ts` | **Created** — model router Redis fallback tests |

---

## API Compatibility Layer

All callers use the Upstash API surface unchanged. The wrapper in
`lib/redis/client.ts` translates internally:

| Upstash call | ioredis equivalent |
|---|---|
| `set(key, val, { ex: N })` | `SET key val EX N` |
| `zadd(key, { score: N, member: id })` | `ZADD key N id` |
| `zrange(key, 0, -1, { rev: true })` | `ZREVRANGE key 0 -1` |
| `pipeline().exec()` → `T[]` | Unwraps `[Error\|null, T][]` → `T[]` |
| `hgetall(key)` → `null` for missing | Normalises `{}` → `null` |
| `get<T>(key)` | Returns raw `string \| null` (no auto JSON-parse) |
| `mget(keys)` | `MGET key [key …]` |
| `ping()` | `PING` |

---

## Environment Variables

| Variable | Before | After |
|---|---|---|
| `REDIS_URL` | Upstash REST URL (`https://…`) | Standard Redis URL (`redis://…`) |
| `REDIS_TOKEN` | Required (Upstash auth token) | **Removed** — not needed |

Update your `.env`:

```env
# Before (Upstash)
REDIS_URL=https://xxx.upstash.io
REDIS_TOKEN=AYXXXXfoo...

# After (standard Redis)
REDIS_URL=redis://default:YOUR_PASSWORD@YOUR_HOST:YOUR_PORT
```

---

## Edge Runtime Removal

ioredis requires Node.js TCP sockets (not available in V8 Edge isolates).
Three routes that previously declared `runtime = 'edge'` now run as `runtime = 'nodejs'`:

- `app/api/v1/messages/route.ts`
- `app/api/v1/messages/count_tokens/route.ts`
- `app/api/admin/reset-keys/route.ts`

These routes always used Redis transitively (auth, key-manager, metrics). With Upstash
this was transparent because it used HTTP REST. With ioredis, Node.js runtime is required.

The `serverExternalPackages: ['ioredis']` setting in `next.config.ts` ensures ioredis
is never bundled by the Webpack/Turbopack Edge compiler.

---

## Key Space

All Redis key names are **unchanged**:

| Key pattern | Used by |
|---|---|
| `gemini:key_pool` | key-manager (sorted set of API key scores) |
| `gemini:key:${id}` | key-manager (hash of key metadata) |
| `user:key:${token}` | auth (hash of user key metadata) |
| `user:keys` | admin/user-keys (set of all user key tokens) |
| `models:registry` | model-router (JSON string of routing overrides) |
| `stats:requests` | metrics (request counter) |
| `stats:input_tokens` | metrics (cumulative input tokens) |
| `stats:output_tokens` | metrics (cumulative output tokens) |
| `stats:models` | metrics (hash of model → request count) |
| `stats:days` | metrics (set of active day strings) |
| `stats:latency` | metrics (list of recent latency values) |
| `admin:session:${sid}` | auth/login (session token → email) |
| `gemini:cache:${hash}` | cache-manager (Gemini context cache name) |
| `gemini:thought:${id}` | request transformer (thought block storage) |
| `gemini:toolname:${id}` | request transformer (tool name storage) |
| `route:last:${uid}:${model}` | model-router (last route used per user) |

---

## Test Results

```
tests/redis-client.test.ts     12 pass / 0 fail
tests/auth-redis.test.ts        8 pass / 0 fail
tests/metrics-redis.test.ts     8 pass / 0 fail
tests/model-router-redis.test.ts 10 pass / 0 fail
─────────────────────────────────────────────────
Total                          38 pass / 0 fail
```

---

## Notes

- The `activate-keys.mjs` script previously called the Upstash HTTP REST API
  directly via `fetch`. It has been rewritten to use `ioredis` directly, reading
  `REDIS_URL` from `.env`. The `REDIS_TOKEN` env var is no longer read.
- The ioredis client is a lazy singleton: the TCP connection is established on
  first use and reused across requests within the same Node.js process.
- Connection errors are logged via `console.error` but do not throw synchronously,
  matching the prior behaviour where callers handle failures with `try/catch`.
