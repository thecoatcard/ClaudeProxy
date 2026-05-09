# Timeout Safety Report

## Hard Timeout Architecture

All async operations now have hard timeouts via `withTimeout()`:

| Operation | Timeout | Configurable Via |
|-----------|---------|-----------------|
| Model API call | 20s | `MODEL_CALL_TIMEOUT` |
| Gemini adapter | 25s | hardcoded (defense-in-depth) |
| Key race | 22s | MODEL_CALL_TIMEOUT + 2s |
| Model race | 22s | MODEL_CALL_TIMEOUT + 2s |
| Stream chunk read | 30s | hardcoded |
| Compactor | 8s | `COMPACTOR_TIMEOUT` |
| Redis ops | 3s | `REDIS_TIMEOUT` |
| Web search | 8s | `WEB_SEARCH_TIMEOUT` |
| Fallback | 5s | `FALLBACK_TIMEOUT` |
| Total request | 240s | `REQUEST_TIMEOUT` |
| Stall detection | 15s | `STALL_DETECTION_MS` |

## Stall Prevention

1. **RequestWatchdog**: Periodic timer detects when no `activity()` reported for `STALL_DETECTION_MS`.
2. **Time budget**: Retry loop checks `requestTimer.elapsed() >= REQUEST_TIMEOUT` before each iteration.
3. **Layered defense**: withTimeout on individual calls + budget on loop + adapter timeout = 3 layers.

## What withTimeout Does NOT Do

- Does **not** cancel the underlying promise (AbortController would be needed)
- The rejected timeout is a race — original promise may still complete in background
- This is acceptable: we free the request handler, background work is GC'd
