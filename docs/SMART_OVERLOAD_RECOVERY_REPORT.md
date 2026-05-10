# Smart Overload Recovery Report

## Goal

Hide transient Gemini overloads from the user by reacting on the first failure, shrinking context aggressively, rotating away from the failing key and model, and preserving the original user prompt plus the active working tail.

## Current Recovery Rules

1. Fast-path races no longer wait for the full model timeout.
   Key race and model race now use a short fast-path budget so overload does not burn ~40s before serial recovery starts.

2. High token pressure is reduced before racing.
   When the request is already large, the gateway trims the middle of the conversation before running key/model races.

3. First overload failure triggers recovery immediately.
   On the first `429`, `503`, `529`, `capacity_error`, `overloaded_error`, or model-call timeout:
   - the current model is marked overloaded
   - the failing key is cooled down
   - a fresh key is selected
   - the next fallback model is selected
   - emergency compaction is attempted
   - retry backoff stays short

4. Overload compaction preserves intent.
   The synchronous overload compactor now:
   - keeps the original opening prompt intact
   - keeps the newest active tail intact
   - removes the middle 60%+ of turns when needed
   - inserts a compacted marker explaining that older context was compressed

5. Canonical emergency compaction still remains available.
   If AI emergency compaction succeeds, future requests can be rewritten against the canonical compacted state so the client can keep sending its full history without forcing the backend to reprocess it every time.

## Behavior By Duration

### 0 to 10 Minutes: transient overload

Expected pattern:
- one model or one key starts failing with `529` or timeout
- recovery should happen on the first failure
- request should move to a different key/model quickly
- user should usually not see the failure

System behavior:
- short race timeout avoids long stalls before recovery
- opening prompt is preserved
- active tail is preserved
- backoff stays very small

### 10 to 30 Minutes: rolling partial saturation

Expected pattern:
- multiple keys or one model family may flap between healthy and overloaded
- large conversations amplify risk because every retry becomes more expensive

System behavior:
- pre-race pressure detection trims the middle before racing
- overloaded keys are cooled down for 10 seconds
- fallback models are selected immediately when a model is marked overloaded
- canonical emergency compaction can replace the working context for subsequent retries

User-visible effect:
- responses may briefly shift to a different model family
- latency may rise modestly, but the request should continue instead of surfacing repeated `529`

### 30 to 60 Minutes: sustained capacity event

Expected pattern:
- a larger portion of the available pool is degraded
- retries can still succeed, but only if the gateway stops carrying oversized payloads and avoids slow dead-end races

System behavior:
- first failure still triggers model/key switch
- context is reduced aggressively to keep retry cost down
- fallback chain is exhausted faster and more deliberately
- requests fail fast only after the available model chain has been proven unhealthy

User-visible effect:
- if any healthy key/model remains, the request should degrade gracefully rather than looping for minutes
- if the whole chain is unhealthy, the gateway returns failure sooner instead of hiding the problem behind very long retry cycles

## Why This Is Smarter Now

- It no longer wastes full model-timeout windows on fast-path races during overload.
- It treats timeouts as overload signals, not as generic retry noise.
- It preserves the original request intent while dropping the least useful middle turns.
- It keeps the most relevant recent working context so the assistant can continue the current task.
- It reduces the chance that Claude Code surfaces repeated `529` failures to the user.

## Remaining Practical Limits

- If every fallback model is overloaded at the same time, the gateway can only fail faster, not invent capacity.
- If the upstream provider stays saturated for an extended period, some requests will still fail after the recovery chain is exhausted.
- AI emergency compaction depends on compaction-model availability; the synchronous middle-turn shrink is the guaranteed fallback.

## Validation

Validated after these changes with:
- `npx tsc --noEmit`
- `npx jest tests/overload-recovery.test.ts tests/fallback-overload.test.ts tests/dynamic-model-racing.test.ts --runInBand`
- full `npx jest --passWithNoTests`
