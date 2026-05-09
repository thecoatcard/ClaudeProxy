# Dashboard Audit — CoatCard AI Gateway

**Date**: 2026-05-09  
**Scope**: Full UX, observability, controls, and security audit of the admin dashboard.

---

## Current State Summary

The dashboard has 5 pages: Overview, Stats, Provider Keys, Gateway Keys, Model Routing.  
All pages are `"use client"` React components using a custom CSS design system. No charting library. No global auth state. No activity feed. No system controls.

---

## Missing Controls

| Gap | Severity | Pages Affected |
|-----|----------|----------------|
| No bulk key addition — can only add 1 key at a time | HIGH | Provider Keys |
| No key validation before adding — invalid keys silently enter pool | HIGH | Provider Keys |
| No per-key enable/disable — only hard delete | HIGH | Provider Keys |
| No key revalidation — can't test a key in pool | MEDIUM | Provider Keys |
| No key status DISABLED/INVALID/FAILED — only healthy/cooldown/revoked | MEDIUM | Provider Keys |
| No bulk actions (bulk delete, bulk enable, bulk disable) | MEDIUM | Provider Keys |
| No RPM limit on gateway keys | HIGH | Gateway Keys |
| No expiration date on gateway keys | MEDIUM | Gateway Keys |
| No notes/labels on gateway keys | LOW | Gateway Keys |
| No gateway key disable (only revoke) | MEDIUM | Gateway Keys |
| No key token copy button (masked display) | MEDIUM | Gateway Keys |
| No per-route edit-in-place for model routing | LOW | Model Routing |
| No fallback chain visualization | LOW | Model Routing |
| No adaptive routing policy controls | MEDIUM | Model Routing |
| No system controls (flush cache, reset metrics) | HIGH | Missing page |
| No Redis health check | HIGH | Missing page |
| No activity feed / request log | HIGH | Missing page |
| No compactor state inspection | MEDIUM | Missing page |
| No operational memory panel | LOW | Missing page |

---

## Weak UX

| Issue | Severity |
|-------|----------|
| Login only accessible from Provider Keys page — other pages show plain "Go to Login" link | HIGH |
| Uses `alert()` and `confirm()` dialogs — breaks UX on mobile | HIGH |
| "Loading..." plain text — no skeleton states | MEDIUM |
| Bar chart uses CSS divs, not a charting library — no interactivity or labels | HIGH |
| No time range selector on stats (only shows 14 days fixed) | MEDIUM |
| No search/filter on any table | HIGH |
| No pagination — large datasets cause scroll overflow | MEDIUM |
| No toast notifications — only native `alert()` | HIGH |
| Sidebar has no icons — hard to scan quickly | LOW |
| No breadcrumb or page hierarchy | LOW |
| Mobile sidebar collapses but is unusable | MEDIUM |
| No keyboard accessibility on custom UI | MEDIUM |
| Token values displayed fully in table (security risk) | HIGH |

---

## Missing Observability

| Missing Metric | Impact |
|----------------|--------|
| Requests/minute (RPM) live rate | HIGH |
| Errors/minute | HIGH |
| Success rate percentage | HIGH |
| Latency percentiles (p50, p95, p99) | HIGH |
| Retry count tracking | MEDIUM |
| Loop detection event count | MEDIUM |
| Compaction event count | LOW |
| Per-provider key error rates | HIGH |
| Key pool saturation (% keys in cooldown) | HIGH |
| Daily active users (unique gateway key count) | MEDIUM |
| Token burn rate (tokens/minute) | LOW |
| No 7d / 30d view — only 14 days hardcoded | MEDIUM |

---

## Missing API Key Tooling

| Feature | Status |
|---------|--------|
| Validate key before add | Missing |
| Revalidate existing key | Missing |
| Enable/disable key (soft toggle without deletion) | Missing |
| Set key priority score | Missing |
| Track key success rate | Missing |
| Track key average latency | Missing |
| Track key total_requests, total_failures | Missing |
| Bulk add (paste multiple keys) | Missing |
| Bulk delete | Missing |
| Key health history (last N failures) | Missing |

---

## Missing Gateway Key Management

| Feature | Status |
|---------|--------|
| RPM limit per gateway key | Missing |
| Max usage limit | Missing |
| Expiration date | Missing |
| Notes/description field | Missing |
| Disable without revoke | Missing |
| Usage history per key | Missing |
| Recent requests per key | Missing |
| Allowed models list | Missing |

---

## Missing Model Controls

| Feature | Status |
|---------|--------|
| Edit route mapping inline | Missing |
| Routing strategy visualization | Missing |
| Fallback chain status (are fallbacks healthy?) | Missing |
| Adaptive routing policy controls | Missing |
| Default model override | Missing |
| Per-model quota display | Missing |

---

## Security Issues

| Issue | Severity |
|-------|----------|
| Full API key displayed in table (only first 10 chars hidden with `...`) | HIGH |
| Full gateway token displayed in table without masking | HIGH |
| No CSRF protection on admin actions | MEDIUM |
| Login form has no rate limiting | MEDIUM |
| No automatic session timeout | LOW |

---

## What Will Be Built

### Phase 2 — UI Foundation
- Extended CSS design system (tabs, toasts, skeletons, modals, progress bars)
- Centralized Zustand auth store
- Recharts integration for interactive charts
- Login modal overlay (accessible from any page)
- Toast notification system

### Phase 3 — API Key Pool Management
- `POST /api/admin/keys/validate` — test a key against Gemini
- Bulk add: paste multiple keys, validate all, add only valid ones
- Per-key enable/disable (new `PATCH ?action=toggle&id=KEY_ID`)
- Status: HEALTHY | COOLDOWN | REVOKED | DISABLED | INVALID
- Revalidate any key

### Phase 4 — Gateway Key Management
- RPM limit + max_usage + notes + expiration fields on create/update
- Disable/enable gateway key without revoke
- Masked token display with copy button

### Phase 5 — Model Routing
- Inline edit in routing table
- JSON editor (kept from current)

### Phase 6 — Observability
- Recharts line charts: requests/day, tokens/day
- Recharts bar chart: per-model usage
- Time range: Today | 7d | 30d
- Error rate, success rate, latency stats

### Phase 7 — Activity Feed
- Redis-backed per-request activity log (`activity:log`)
- Searchable, filterable table
- Auto-refresh every 30s

### Phase 8 — System Controls (new page)
- Redis health check
- Flush caches
- Reset metrics
- Clear failed keys
- Activate all keys
- Key pool health dashboard

### Phase 9 — Auth UX
- Login modal accessible from layout
- Logout in sidebar
- Zustand-powered shared auth state
