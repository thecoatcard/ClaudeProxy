# HEALTH-AWARE MODEL ROUTING REPORT

## Phase 8 — Provider Health-Aware Fallback Ordering

**Module**: `lib/recovery/overload-recovery.ts`  
**Tests**: `tests/provider-health-routing.test.ts` — 15 tests passing

---

## Problem

`OVERLOAD_FALLBACK_CHAIN` was a static list. When a model experienced sustained outages or high overload, the gateway kept routing to it first because it had high static priority. Healthier models lower in the chain were underutilised.

---

## Solution

### `ModelHealthRecord`

```typescript
interface ModelHealthRecord {
  failures: number;
  successes: number;
  totalLatencyMs: number;
  overloadCount: number;
  updatedAt: number;
}
```

Stored in Redis under `provider:health:{sanitizedModel}` with 1h TTL.

### `recordModelHealth(model, outcome, latencyMs?)`

| Outcome | Effect |
|---|---|
| `'success'` | `failures → 0`, `successes++`, `totalLatencyMs += latencyMs` |
| `'overload'` | `failures++`, `overloadCount++` |
| `'error'` | `failures++` |

On Redis error: silently swallows (health tracking must not affect request path).

### `getHealthAwareFallbackChain(currentModel, triedModels): Promise<string[]>`

Builds an ordered candidate list from `OVERLOAD_FALLBACK_CHAIN`:
1. Excludes `currentModel` and any `triedModels`
2. Loads health record for each remaining candidate from Redis
3. Computes score: `failures × 10 + overloadCount × 5 − successes`
4. Gemma candidates receive **+50 penalty** to preserve last-resort ordering
5. Sorts ascending (lowest score = healthiest = tried first)
6. Returns re-ordered list

**Gemma penalty rationale**: Gemma models are local fallbacks — they should only be used when Gemini is fully degraded. The +50 penalty means Gemma only rises above a Gemini model when that model has accumulated 5+ failures and 0 successes.

### `getNextFallbackModelHealthAware(currentModel, triedModels): Promise<string | null>`

- Calls `getHealthAwareFallbackChain()`
- Returns first element or `null` if chain is empty
- On Redis error: degrades to static `getNextFallbackModel()` (never throws)

---

## Integration Point

```typescript
// lib/recovery/overload-recovery.ts — recoverFromOverload()
// Step 4: choose next model
const newModel = await getNextFallbackModelHealthAware(currentModel, triedModels);
//  was: const newModel = getNextFallbackModel(currentModel, triedModels);
```

---

## Scoring Examples

| Model | Failures | Overloads | Successes | Score (no Gemma) |
|---|---|---|---|---|
| gemini-flash-lite | 0 | 0 | 5 | −5 (healthiest) |
| gemini-flash | 2 | 1 | 10 | 15 |
| gemini-flash-preview | 5 | 3 | 1 | 64 (degraded) |
| gemma-3 | 0 | 0 | 2 | 48 (50 − 2 = 48) |

In this scenario, `gemini-flash-lite` is tried first, `gemma-3` is tried before the heavily degraded `gemini-flash-preview`.

---

## Test Coverage

| Scenario | Result |
|---|---|
| `recordModelHealth` — stores record | Pass |
| `recordModelHealth` — increments failures on error | Pass |
| `recordModelHealth` — increments overloadCount | Pass |
| `recordModelHealth` — resets failures on success | Pass |
| `recordModelHealth` — no-throw on Redis error | Pass |
| `getModelHealth` — zero-init for unknown model | Pass |
| `getModelHealth` — returns stored record | Pass |
| `getHealthAwareFallbackChain` — excludes current + tried | Pass |
| `getHealthAwareFallbackChain` — prefers healthier model | Pass |
| `getHealthAwareFallbackChain` — Gemma stays behind Gemini | Pass |
| `getHealthAwareFallbackChain` — empty when all tried | Pass |
| `getNextFallbackModelHealthAware` — returns string | Pass |
| `getNextFallbackModelHealthAware` — null when all tried | Pass |
| `getNextFallbackModelHealthAware` — falls back on Redis error | Pass |
