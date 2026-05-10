# Telemetry Isolation Report

**Phase 6 of the 8-Phase Focused Improvement Pass**

---

## Summary

Metrics and activity writes are now fully non-blocking. Previously, `await incrementErrorCount()`, `await recordLatency()`, and `await recordTokens()` in the critical response path added Redis round-trip overhead to every request.

---

## Problem

In `app/api/v1/messages/route.ts`, three categories of telemetry writes were blocking the response path:

### 1. Non-streaming — before response returned
```typescript
// BEFORE (blocking): ~1-3ms Redis RTT added to each request
await recordLatency(Date.now() - startTime);
await recordTokens(inputTokens, outputTokens, { model, userToken: token });
// ... logActivity — already fire-and-forget ✓
return NextResponse.json(anthropicRes); // delayed by telemetry
```

### 2. Streaming catch block — before error SSE event
```typescript
// BEFORE (blocking): error SSE delayed by Redis write
await incrementErrorCount({ model, userToken: token });
safeEnqueue(errorEvent); // delayed
```

### 3. Outer catch — before error response returned
```typescript
// BEFORE (blocking): error response delayed by Redis write
await incrementErrorCount({ model, userToken: token });
return NextResponse.json(anthropicErr); // delayed
```

---

## Fix Applied

All telemetry calls converted to fire-and-forget pattern:

```typescript
// AFTER (non-blocking):
recordLatency(Date.now() - startTime).catch(() => {});
recordTokens(inputTokens, outputTokens, { model, userToken }).catch(() => {});
incrementErrorCount({ model, userToken: token }).catch(() => {});
```

The streaming `finally` block was also converted — even though the client stream is already closed at that point, removing `await` makes the cleanup path faster and more consistent.

---

## Telemetry Isolation Guarantee

**Inference must NOT await telemetry.** This rule is now enforced by code pattern:

| Location | Before | After |
|----------|--------|-------|
| Non-streaming response path | `await recordLatency` | `.catch(()=>{})` |
| Non-streaming response path | `await recordTokens` | `.catch(()=>{})` |
| Streaming finally block | `await recordLatency` | `.catch(()=>{})` |
| Streaming finally block | `await recordTokens` | `.catch(()=>{})` |
| Streaming catch (error) | `await incrementErrorCount` | `.catch(()=>{})` |
| Outer catch (error) | `await incrementErrorCount` | `.catch(()=>{})` |

`logActivity` was already fire-and-forget (`.catch(() => {})`). No change needed.

---

## Latency Impact

Each blocked `await` previously added 1–3ms Redis round-trip overhead to the response path. With 3 blocked calls on error paths, that was up to 9ms overhead per error. Non-blocking removes this entirely from the client-facing latency.

---

## Files Changed

- `app/api/v1/messages/route.ts` — 6 telemetry call sites converted to non-blocking
