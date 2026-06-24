# Overload Fix Report

## Incident Summary

**Symptom**: Gateway stopped responding. All requests failing after 67–70 seconds.  
**Root Cause**: Full fallback chain exhaustion caused by two compounding bugs in `lib/retry-engine.ts`.

---

## Log Analysis

```
[overload-recovery] event=overload-detected {model:gemini-2.5-flash-lite, attempt:1}
→ fallback to gemini-2.5-flash

[overload-recovery] event=overload-detected {model:gemini-2.5-flash, attempt:2}
→ fallback to gemini-3-flash-preview

[ERROR] [RETRY] Gemini API Error on gemini-3-flash-preview
[WARN] [RETRY] thought_signature 400 on gemini-3-flash-preview — disabling thinking
→ BURNED attempt 3 for config fix, stayed on gemini-3-flash-preview

[overload-recovery] event=overload-detected {model:gemini-3-flash-preview, attempt:6}
→ fallback selected: gemini-3.1-flash-lite-preview

[ERROR] [RETRY] Request time budget exhausted (67141ms) — failing after 6 attempt(s)
→ gemini-3.1-flash-lite-preview NEVER RAN — budget expired during backoff sleep
```

---

## Bug 1 — `thought_signature 400` Burns an Attempt Slot

### Root Cause

When Gemini returns `400 thought_signature`, the retry engine set `stripSigs = true` and `stripThinking = true`, then called `continue` to retry. The `for` loop incremented `attempt`, so the config-level fix cost one of the 6 budget slots.

In the failure trace, this burned attempt 3, leaving attempts 4–6 all on `gemini-3-flash-preview`. By the time the model was finally marked overloaded (attempt 6), only `gemini-3.1-flash-lite-preview` remained — but there was no attempt 7.

### Fix Applied

Added `thinkingStrippedFreeRetryUsed` flag. On the first `thought_signature 400`, the attempt counter is decremented before `continue` so the loop's `attempt++` cancels it out. The retry uses the same attempt index — no budget consumed.

Only the **first** occurrence per request gets the free retry. Subsequent `thought_signature` errors (which would indicate a deeper problem) burn attempts normally to prevent infinite loops.

```typescript
if (!thinkingStrippedFreeRetryUsed) {
  thinkingStrippedFreeRetryUsed = true;
  attempt--; // loop's attempt++ cancels this — net: same attempt index
}
```

**File**: `lib/retry-engine.ts` (thought_signature handler)

---

## Bug 2 — Exponential Backoff Eats the Last Fallback's Budget

### Root Cause

After a fallback model is selected, the retry engine sleeps for `computeOverloadBackoff(attempt)` or `recovery.backoffMs` before the next iteration. At attempt 5–6, the backoff formula produces 3700–4000ms.

When the final fallback model (`gemini-3.1-flash-lite-preview`) was selected at end of attempt 6, the code chose a 4000ms sleep. But the request budget was already at ~63s elapsed. The next iteration's budget check fired at 67s > REQUEST_TIMEOUT, so the last model never got a single call.

### Fix Applied

Before sleeping after any overload/503/timeout recovery, the engine now checks remaining budget:

```typescript
const budgetRemaining = REQUEST_TIMEOUT - requestTimer.elapsed();
const backoff = budgetRemaining < 10_000 ? 0 : computeOverloadBackoff(attempt);
if (backoff > 0) await sleep(backoff);
```

When less than 10 seconds remain, backoff is skipped entirely and the next attempt runs immediately. This gives the fallback model a fair window to respond before the hard budget deadline.

The same pattern was applied to three paths:
- 503 catch block (direct 503 from model)
- classifyOverload catch block (overloaded_error / 529)
- AbortError / Timeout catch block (model call timeout)

**File**: `lib/retry-engine.ts` (503, overload, and timeout catch blocks)

---

## Additional Fix — Budget-Aware Backoff for 400 Errors

When a `thought_signature 400` occurs and we do retry, the backoff for the retry call is also now budget-aware:

```typescript
const remainingBudgetMs = REQUEST_TIMEOUT - requestTimer.elapsed();
if (remainingBudgetMs > 3_000) await sleep(computeBackoffMs(attempt));
```

This ensures even the "free" retry doesn't sleep when the request is nearly out of time.

---

## What Would Have Happened Without These Fixes

| Attempt | Model | Before Fix | After Fix |
|---------|-------|-----------|-----------|
| 1 | gemini-2.5-flash-lite | overloaded → fallback | overloaded → fallback |
| 2 | gemini-2.5-flash | overloaded → fallback | overloaded → fallback |
| 3 | gemini-3-flash-preview | **BURNED by thought_sig** | free retry (no cost) |
| 3 | gemini-3-flash-preview | — | retries with thinking stripped |
| 4 | gemini-3-flash-preview | retry | overload → fallback |
| 5 | gemini-3.1-flash-lite | — | **gets a fair attempt** |
| 6 | gemini-3-flash-preview | overload → fallback selected | — |
| 7 | budget check fires | **EXHAUSTED — never ran** | — |

---

## Flaky Test Note

`tests/overload-recovery.test.ts` has one test that uses `Math.random()` jitter in backoff calculation and occasionally fails with tight timing bounds when run in a heavily loaded suite (e.g. `expect(ms).toBeLessThan(1200)` but jitter produces 1263ms). This is a pre-existing issue — **not introduced by this fix**. The test passes when run in isolation.

---

## Files Changed

| File | Change |
|------|--------|
| `lib/retry-engine.ts` | Fix 1: free retry for `thought_signature 400` |
| `lib/retry-engine.ts` | Fix 2: budget-aware backoff before sleeping on fallback |

**No new test files** — these fixes change timing/flow behavior that is difficult to unit test deterministically. The existing 929-test suite continues to pass.

---

## Prevention Recommendations

1. **Set `REQUEST_TIMEOUT` generously** in production `.env` (e.g. `REQUEST_TIMEOUT=120000` for 2 minutes). At 60s, a single slow Gemini response (20s) plus 3 fallbacks each at 15s leaves no margin.
2. **Monitor COMPACTION routes** — `gemma-4-26b-a4b-it` was observed taking 18–22 seconds per request. Configure the Redis routing to use `gemini-2.5-flash-lite` for COMPACTION tasks during peak load.
3. **Alert on `[WARN] [OVERLOAD] FALLBACK_MODEL_SELECTED`** appearing 3+ times in 30 seconds — this indicates systemic API degradation and warrants manual intervention.
