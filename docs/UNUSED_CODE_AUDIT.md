# Unused Code Audit

## Audit Date: Current Session

## Verified Dead Code

### 1. `lib/reasoning/gemma-helper.ts` — DEAD FILE
- **Exports**: `runGemmaReasoning()`, `compressOperationalState()`, `analyzeToolError()`, `planRecovery()`, `checkDependency()`, `explainContradiction()`
- **References**: Only in `tests/gemma-helper.test.ts` — no production imports
- **Action**: Safe to remove (along with test)

### 2. `src/` directory — STALE DUPLICATE
- **Contents**: `src/app/favicon.ico`, `globals.css`, `layout.tsx`, `page.module.css`, `page.tsx`
- **Issue**: Duplicate of root `app/` directory. Active pages are served from `app/`, not `src/app/`
- **Action**: Safe to remove entire directory

### 3. `store/auth.ts` — DEFINED BUT UNUSED
- **Exports**: `useAuth` (Zustand store)
- **References**: Only in docs/reports, never imported in production code
- **Note**: Documented as "planned for future use" — keep or remove at discretion

### 4. Root-level test scripts — DEV ONLY
- `test-compaction-fixed.ts` — manual compaction test
- `test-gemini-history.mjs` — manual Gemini API test
- `test-gemini-tool-call.mjs` — manual tool call test
- `test-gemma.mjs` — manual Gemma pool test
- **Action**: Safe to remove (not part of jest test suite)

## Code Duplication

### `normalizeModelName()` duplicated
- **Source of truth**: `lib/models/capability-profile.ts:108`
- **Duplicate**: `lib/model-router.ts:87`
- **Action**: model-router.ts should import from capability-profile

## Empty Directories
- `lib/scripts/` — empty
- `scratch/` — empty

## Verified Active Code (NOT dead)
- All `lib/tools/` files — ACTIVE
- All `lib/transformers/` files — ACTIVE  
- All `lib/utils/` files — ACTIVE
- All `lib/routing/` files — ACTIVE
- All `lib/context/` files — ACTIVE
- All `lib/models/` files — ACTIVE
- `lib/tool-archive.ts` — ACTIVE
- `lib/activity.ts` — ACTIVE
- `lib/cache-manager.ts` — ACTIVE
- `activate-keys.mjs` — ACTIVE (production ops utility)
