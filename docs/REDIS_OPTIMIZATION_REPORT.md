# Redis Optimization Report

## N+1 Problem

Admin endpoints performed serial Redis calls inside `for` loops. With 10 keys, a single GET would make 10+ round-trips.

## Fix: Pipeline Batching

All admin endpoints now use `redis.pipeline()`:

| Endpoint | Before (serial calls) | After (pipeline) | Speedup |
|----------|-----------------------|-------------------|---------|
| GET /api/admin/keys | N × hgetall | 1 pipeline | ~10x |
| PATCH /api/admin/keys?action=activate-all | 2N × hgetall+hset | 2 pipelines | ~10x |
| GET /api/admin/user-keys | N × hgetall | 1 pipeline | ~10x |
| GET /api/admin/system (health) | N × hgetall | 1 pipeline | ~10x |
| POST /api/admin/system (activate-all) | 2N × hgetall+hset | 2 pipelines | ~10x |
| POST /api/admin/system (clear-failed) | 2N × hgetall+del | 2 pipelines | ~10x |
| GET /api/admin/logs (model obs) | 30 calls (6×5) | 1 pipeline | ~30x |
| GET /api/admin/logs (key obs) | 2N calls | 1 pipeline | ~10x |

## Pipeline API

`RedisPipeline` wraps ioredis pipeline with typed chainable methods. Results are returned as `unknown[]` from `exec()` and cast at call sites.
