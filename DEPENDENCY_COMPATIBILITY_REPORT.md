# Dependency Compatibility Report

## Summary

Created a dependency compatibility guard that detects known-breaking package versions before `npm install` runs. Prevents the gateway from silently installing Prisma 7, Tailwind v4, Next.js 15, or other packages with known incompatible API changes.

## Module: `lib/agent/dependency-compatibility.ts`

### Breaking Change Registry (10 entries)

| Package | Breaking From | Risk | Safe Version |
|---------|--------------|------|-------------|
| `prisma` | >=7.0.0 | **critical** | 6.x |
| `tailwindcss` | >=4.0.0 | **critical** | 3.x |
| `next` | >=15.0.0 | high | 14.x |
| `@shadcn/ui` | >=3.0.0 | high | 2.x |
| `zod` | >=4.0.0 | high | 3.x |
| `react` | >=19.0.0 | high | 18.x |
| `@tanstack/react-query` | >=5.0.0 | high | 4.x |
| `eslint` | >=9.0.0 | medium | 8.x |
| `drizzle-orm` | >=0.40.0 | medium | — |
| `vite` | >=6.0.0 | medium | — |

### Detection Logic

- Parses `npm install`, `yarn add`, `pnpm add` command strings
- Extracts package names and version specifiers
- Flags packages where: `major >= breakingMajor` OR spec is `latest`/`*`/`^major`
- Generates migration docs search queries per flagged package

### Functions

| Function | Purpose |
|----------|---------|
| `checkInstallCompatibility(cmd)` | Parse and check an install command |
| `checkPackageNames(names[])` | Check names without version info |
| `getSafeVersion(name)` | Get the known-safe version for a package |
| `listRiskyPackages(minLevel?)` | List all risky packages at or above a risk level |

### Integration

The behavior auditor scans the last 30 messages for install commands and injects compatibility warnings into `systemInstruction` before the model responds.

## Test Coverage

`tests/dependency-compatibility.test.ts` — 17 tests, 17 passing.
