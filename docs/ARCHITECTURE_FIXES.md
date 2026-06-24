# Architecture Fixes Report

**Date:** 2026-05-10

---

## Fixes Applied This Session

### Fix 1: Jest Test Harness (23 suites → 0 failing)

**Root cause:** 22 test files used `node:test` built-in runner imports incompatible with Jest.

**Files modified:**
- `jest.config.ts` — Added moduleNameMapper for nanoid (ESM→CJS) and `.js` extension resolution
- `__mocks__/nanoid.js` — Created CJS-compatible nanoid mock
- 22 test files — Removed `import { ... } from 'node:test'` (Jest globals take over)
- `tests/redis-client.test.ts` — Fixed `../lib/redis/client.js` → `../lib/redis/client`
- `tests/operational-context.test.ts` — Updated key version v2 → v3
- `tests/redis-vector-store.test.ts` — Fixed mock path `./embedding-engine` → `@/lib/memory/embedding-engine`

**Result:** 69/69 suites pass, 681/681 tests pass

---

### Fix 2: Model Pool Enforcement

**Root cause:** No validation that resolved models are in the allowed pool. Bad Redis config or operator error could route to invalid models.

**Files modified:**
- `lib/routing/task-router.ts` — Added `ALLOWED_MODEL_POOL` Set (exported)
- `lib/model-router.ts` — Added `enforceModelPool()` and `enforceRoutePool()`, applied on all chain resolution paths

**Enforcement logic:**
```typescript
// In model-router.ts
function enforceModelPool(models: string[]): string[] {
  return models.filter((m) => ALLOWED_MODEL_POOL.has(normalizeModelName(m)));
}
```
All chains are filtered before return. Sticky models from Redis also validated.

---

### Fix 3: Smart Model Routing

**Root cause:** LIGHT_CODING chain used chat model. COMPACTION used large Gemma. REASONING detection missing.

**Files modified:**
- `lib/routing/task-router.ts` — Updated all chains + added REASONING detection

**Chain updates:**

```typescript
// REASONING (was: missing → returns HEAVY_CODING)
const REASONING_CHAIN = ['gemma-4-31b-it', 'gemma-4-26b-a4b-it', 'gemini-2.5-flash', 'gemini-3-flash-preview'];

// LIGHT_CODING (was: gemini-2.5-flash-lite)
const LIGHT_CODING_CHAIN = ['gemini-3-flash-preview', 'gemini-2.5-flash-lite', 'gemini-flash-latest'];

// COMPACTION (was: gemma-4-31b-it)
const COMPACTION_CHAIN = ['gemma-4-26b-a4b-it', 'gemma-4-31b-it', 'gemini-2.5-flash'];
```

**REASONING keywords added (high-precision, no false positives):**
```
contradiction analysis, root cause reasoning, causal reasoning,
logical deduction, chain-of-thought, step-by-step reasoning,
mathematical proof, formal proof, bayesian reasoning, ...
```

---

### Fix 4: Compaction Model

**Root cause:** `lib/transformers/request.ts` hardcoded `gemma-4-31b-it` for AI compaction.

**Files modified:**
- `lib/transformers/request.ts` — Changed `model: 'gemma-4-31b-it'` → `model: 'gemma-4-26b-a4b-it'`

---

## Architecture Principles Enforced

| Principle | Status |
|-----------|--------|
| Gateway does NOT orchestrate | ✅ Enforced via `ENABLE_GATEWAY_ORCHESTRATOR` env gate |
| Gateway does NOT create subagents | ✅ No subagent creation in live path |
| Claude Code is the agent | ✅ Gateway only translates/routes/retries |
| Allowed model pool enforced | ✅ `enforceModelPool()` filters all chains |
| Task-appropriate routing | ✅ REASONING→Gemma, HEAVY→Flash, FAST→3-Flash, CHAT→Lite |
| Streaming fast path | ✅ Immediate events before Gemini call |
| Tool passthrough clean | ✅ No interception, only format translation |
| Redis N+1 eliminated | ✅ Pipelines on all multi-key reads |
