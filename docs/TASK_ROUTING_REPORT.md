# Task Routing Report

## Overview

Implemented task-aware adaptive model routing in `lib/routing/task-router.ts` and integrated it into `getModelMapping()`.

Task classes:
- `REASONING`
- `HEAVY_CODING`
- `LIGHT_CODING`
- `HEALTH_CHECK`
- `COMPACTION`

## Routing Strategy

### Reasoning / Compaction (Gemma-priority)

Primary chain:
1. `gemma-4-31b-it`
2. `gemma-4-26b-a4b-it`
3. `gemini-2.5-flash`
4. `gemini-3-flash-preview`
5. `gemini-3.1-flash-lite-preview`

### Heavy Coding (Gemini-priority)

Primary chain:
1. `gemini-2.5-flash`
2. `gemini-3-flash-preview`
3. `gemini-3.1-flash-lite-preview`

### Light Coding / Health Check (Lite-priority)

Primary chain:
1. `gemini-2.5-flash-lite`
2. `gemini-flash-lite-latest`
3. `gemini-flash-latest`

## Merge Rules with Registry

- For normal traffic (`HEAVY_CODING`, `LIGHT_CODING`, `HEALTH_CHECK`):
  configured registry route remains first.
- For reasoning-oriented traffic (`REASONING`, `COMPACTION`):
  task chain is allowed to lead (Gemma-first).

This preserves Redis source-of-truth while still enabling intentional reasoning-model rotation.

## Anthropic Alias Mapping

Local/default registry updated to requested mapping classes:
- Opus-class: `gemini-2.5-flash` (+ `gemini-3-flash-preview`, `gemma-4-31b-it`)
- Sonnet-class: `gemini-2.5-flash` (+ `gemini-3.1-flash-lite-preview`, `gemini-flash-latest`)
- Haiku-class: `gemini-2.5-flash-lite` (+ `gemini-flash-lite-latest`, `gemini-flash-latest`)

## Tests

Validated by:
- `tests/task-router.test.ts`
  - reasoning routes to Gemma
  - heavy coding routes to Gemini
  - lite tasks route to lite models
  - health checks route to lite chain
  - compaction routes to Gemma
