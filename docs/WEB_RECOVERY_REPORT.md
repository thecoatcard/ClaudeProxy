# Web Recovery Report

## Summary

Created a web recovery engine that classifies tool errors into known categories and generates targeted official-docs search queries. Integrated into the behavior auditor so the gateway automatically triggers web_search guidance on known-problematic errors.

## Module: `lib/agent/web-recovery.ts`

### Error Classes

| Class | Trigger Patterns | Priority Domain |
|-------|-----------------|-----------------|
| `prisma_migration` | `prisma migrate`, `PrismaClientInitializationError`, `Cannot find Prisma Schema` | prisma.io |
| `nextjs_config` | `Invalid next.config`, `Unrecognized key`, `Module not found: next/headers` | nextjs.org |
| `package_not_found` | `Cannot find module`, `Module not found: Can't resolve` | npmjs.com |
| `package_export_missing` | `does not provide an export named`, `Named export not found` | npmjs.com |
| `cli_argument_mismatch` | `unknown option`, `unrecognized option`, `Invalid option --` | npmjs.com |
| `shadcn_init` | `shadcn.*init`, `Cannot find package.*shadcn` | ui.shadcn.com |
| `tailwind_config` | `tailwind.*config.*error`, `Cannot find.*tailwind.config` | tailwindcss.com |
| `typescript_error` | `TS\d{4}:`, `Type '...' is not assignable` | typescriptlang.org |
| `auth_library` | `next-auth`, `NextAuth`, `@clerk` | next-auth.js.org |
| `build_tool_error` | `vite.*error`, `webpack.*error`, `esbuild.*error` | vitejs.dev |
| `unknown` | fallback | stackoverflow.com |

### Behavior

- **Repeat-aware**: Unknown errors only trigger web_search at `repeatCount >= 2`
- **Known classes**: Always trigger web_search at first occurrence
- **Priority order**: Official docs → GitHub → package docs → Stack Overflow
- **Guidance**: Injected into `systemInstruction` via `behavior-auditor.ts`

### Functions

| Function | Purpose |
|----------|---------|
| `classifyAndRecover(errorText, toolInput?, repeatCount?)` | Classify + build search queries |
| `requiresWebSearch(errorText)` | Quick check for high-priority error patterns |

## Integration

The behavior auditor (`lib/agent/behavior-auditor.ts`) scans the last 15 messages for tool errors and triggers web recovery guidance when:
- `requiresWebSearch()` returns true, OR
- The same error has repeated 2+ times

## Test Coverage

`tests/web-recovery.test.ts` — 16 tests, 16 passing.
