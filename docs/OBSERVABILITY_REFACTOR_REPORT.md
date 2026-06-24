# Observability Refactor Report

## Summary

Replaced raw `console.log/warn/error` calls across the gateway with a structured event logging system. Built an interactive observability dashboard with live event viewer, request timelines, model stats, and key health monitoring.

## Architecture

```
┌─────────────────────────────────────────────────┐
│                 Gateway Code                     │
│  (route.ts, retry-engine, key-manager, etc.)    │
└──────────────┬──────────────────────────────────┘
               │ emitEvent() / logInfo/Warn/Error()
               ▼
┌─────────────────────────────────────────────────┐
│              Event Logger Pipeline               │
│  1. Noise Filter → drop static/polling/health   │
│  2. Deduplicator → collapse repeated events     │
│  3. Event Store  → Redis (5000 cap, 24h TTL)    │
│  4. Console Out  → gated by LOG_LEVEL           │
└──────────────┬──────────────────────────────────┘
               │ GET /api/admin/logs
               ▼
┌─────────────────────────────────────────────────┐
│           Dashboard /dashboard/logs              │
│  Events Tab │ Models Tab │ Keys Tab              │
│  Filters, search, timeline, auto-refresh        │
└─────────────────────────────────────────────────┘
```

## New Files (8)

| File | Purpose |
|------|---------|
| `lib/logging/event-logger.ts` | Core structured logger: `emitEvent()`, `logInfo/Warn/Error/Critical()`, `createRequestLogger()` |
| `lib/logging/timeline-builder.ts` | Request lifecycle timeline: `buildTimeline()`, `getRequestDuration()`, `getPhasesSummary()` |
| `lib/logging/log-dedup.ts` | Deduplicates identical events within 5s window; emits summary every 10th repeat |
| `lib/logging/noise-filter.ts` | Filters Next.js static, admin polling, health checks, browser warnings |
| `lib/logging/error-summarizer.ts` | Classifies errors: `summarizeError()`, `errorOneLiner()`, `inferRecoveryAction()` |
| `lib/logging/event-store.ts` | Redis-backed storage: global stream (5000 cap) + per-request lists (24h TTL) |
| `lib/logging/log-level.ts` | `LOG_LEVEL` env var control: DEBUG/INFO/WARN/ERROR/CRITICAL |
| `app/api/admin/logs/route.ts` | API endpoint: events, timeline, summary, model stats, key health |
| `app/dashboard/logs/page.tsx` | Interactive dashboard: 3 tabs, filters, search, auto-refresh |

## Modified Files (3)

| File | Changes |
|------|---------|
| `app/api/v1/messages/route.ts` | Added `requestId` generation, `createRequestLogger()`, structured logs for request lifecycle |
| `lib/retry-engine.ts` | Replaced all 15 `console.*` calls with structured events (RETRY, ROUTING, OVERLOAD, KEY_ROTATION, COMPACTION) |
| `lib/key-manager.ts` | Replaced 2 `console.*` calls with structured events (KEY_ROTATION) |
| `app/dashboard/layout.tsx` | Added Logs nav item to sidebar |

## Event Categories (14)

ORCHESTRATOR, ROUTING, RETRY, OVERLOAD, KEY_ROTATION, WEB_SEARCH, COMPACTION, SUBAGENT, RECOVERY, ACTIVITY, STREAM, AUTH, MEMORY, SYSTEM

## Test Results

- **4 test suites**, **32 tests**, all passing
- `tests/event-logger.test.ts` — 9 tests (emit, severity, scoped logger, IDs)
- `tests/timeline-builder.test.ts` — 7 tests (sort, phases, duration, summary)
- `tests/log-dedup.test.ts` — 7 tests (collapse, summary every 10th, stats, reset)
- `tests/noise-filter.test.ts` — 9 tests (static, polling, health, browser, passthrough)

## Success Criteria

- [x] Logs structured — typed EventLog with category, severity, requestId
- [x] Noise reduced — static assets, polling, health checks filtered
- [x] Request timelines work — phase inference, duration calculation
- [x] Dashboard logs usable — live viewer with filters, search, auto-refresh
- [x] Errors readable — errorOneLiner, summarizeError, inferRecoveryAction
- [x] Repeated events deduplicated — 5s window, summary every 10th
- [x] Observability production-ready — LOG_LEVEL control, Redis storage, dark theme UI
