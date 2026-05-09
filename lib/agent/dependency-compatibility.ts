// lib/agent/dependency-compatibility.ts
//
// Dependency compatibility guard — prevents installing broken or incompatible
// package versions by detecting known breaking changes before npm install runs.
//
// Problems solved:
//   - Prisma 7 changed CLI contract; existing guides are wrong.
//   - Next.js 15 broke App Router config + middleware pattern.
//   - Tailwind v4 changed config format completely.
//   - shadcn/ui v3 changed component registry API.
//   - Zod v4 changed .optional() and .default() inference.
//
// This module:
//   1. Parses install commands for package names and version specifiers.
//   2. Checks against a known-breaking-changes table.
//   3. Returns risk items + suggested web_search queries.
//   4. Signals when to trigger web recovery before installing.
//
// Edge-runtime safe. Pure functions. No I/O.

export type RiskLevel = 'critical' | 'high' | 'medium' | 'low';

export interface CompatibilityRisk {
  packageName: string;
  requestedSpec: string;
  riskLevel: RiskLevel;
  breakingVersion: string;
  description: string;
  /** Official migration docs to search for. */
  docsQuery: string;
  /** Direct URL to migration guide (best-effort, may be outdated). */
  docsUrl?: string;
  /** Suggested safe version to use instead. */
  safeVersion?: string;
}

export interface CompatibilityCheckResult {
  hasRisks: boolean;
  risks: CompatibilityRisk[];
  /** Aggregated web_search queries to run before installing. */
  searchQueries: string[];
  /** System instruction guidance to inject. */
  guidance: string;
}

// ─── Known breaking change registry ───────────────────────────────────────────

interface KnownBreakingEntry {
  packageName: string;
  /** Semver range that is known to contain breaking changes (e.g. ">=7.0.0"). */
  breakingFrom: string;
  /** Major version number as a number for easy comparison. */
  breakingMajor: number;
  riskLevel: RiskLevel;
  description: string;
  docsQuery: string;
  docsUrl?: string;
  safeVersion?: string;
}

const BREAKING_CHANGE_REGISTRY: KnownBreakingEntry[] = [
  {
    packageName: 'prisma',
    breakingFrom: '>=7.0.0',
    breakingMajor: 7,
    riskLevel: 'critical',
    description: 'Prisma 7 renamed the CLI binary (prisma → @prisma/client/edge), changed migration commands, and dropped the old schema.prisma format in several areas. Existing Prisma 5/6 guides are WRONG for Prisma 7.',
    docsQuery: 'Prisma 7 migration guide breaking changes upgrade 2025',
    docsUrl: 'https://www.prisma.io/docs/guides/upgrade-guides/upgrading-versions/upgrading-to-prisma-7',
    safeVersion: '6.x',
  },
  {
    packageName: 'next',
    breakingFrom: '>=15.0.0',
    breakingMajor: 15,
    riskLevel: 'high',
    description: 'Next.js 15 changed: cookies()/headers() are now async, Request/Response types changed, cacheTag/cacheLife APIs are new, and several config options were removed.',
    docsQuery: 'Next.js 15 migration guide breaking changes upgrade',
    docsUrl: 'https://nextjs.org/docs/app/building-your-application/upgrading/version-15',
    safeVersion: '14.x',
  },
  {
    packageName: 'tailwindcss',
    breakingFrom: '>=4.0.0',
    breakingMajor: 4,
    riskLevel: 'critical',
    description: 'Tailwind CSS v4 completely rewrote the configuration system. tailwind.config.js is gone; config is now in CSS. @tailwind directives changed. Existing v3 configs will not work.',
    docsQuery: 'Tailwind CSS v4 upgrade migration guide breaking changes 2025',
    docsUrl: 'https://tailwindcss.com/docs/upgrade-guide',
    safeVersion: '3.x',
  },
  {
    packageName: '@shadcn/ui',
    breakingFrom: '>=3.0.0',
    breakingMajor: 3,
    riskLevel: 'high',
    description: 'shadcn/ui v3 changed the component registry format and init CLI. The old "npx shadcn-ui@latest init" pattern changed to "npx shadcn@latest init".',
    docsQuery: 'shadcn ui v3 upgrade migration 2025',
    docsUrl: 'https://ui.shadcn.com/docs/changelog',
    safeVersion: '2.x',
  },
  {
    packageName: 'zod',
    breakingFrom: '>=4.0.0',
    breakingMajor: 4,
    riskLevel: 'high',
    description: 'Zod v4 changed inference for .optional(), .default(), .nullable(). String/number parsing behavior changed. Custom error maps changed.',
    docsQuery: 'Zod v4 migration guide breaking changes upgrade',
    docsUrl: 'https://zod.dev/v4',
    safeVersion: '3.x',
  },
  {
    packageName: 'drizzle-orm',
    breakingFrom: '>=0.40.0',
    breakingMajor: 0,
    riskLevel: 'medium',
    description: 'Drizzle ORM 0.40+ changed the schema definition API and relation query API. Check migration notes.',
    docsQuery: 'drizzle-orm 0.40 migration breaking changes',
    docsUrl: 'https://orm.drizzle.team/docs/migrations',
  },
  {
    packageName: 'react',
    breakingFrom: '>=19.0.0',
    breakingMajor: 19,
    riskLevel: 'high',
    description: 'React 19 removed forwardRef (replaced by ref prop), changed useContext usage, and altered hydration behavior.',
    docsQuery: 'React 19 migration guide breaking changes upgrade',
    docsUrl: 'https://react.dev/blog/2024/12/05/react-19',
    safeVersion: '18.x',
  },
  {
    packageName: 'vite',
    breakingFrom: '>=6.0.0',
    breakingMajor: 6,
    riskLevel: 'medium',
    description: 'Vite 6 changed default config options and plugin API. Some older plugins are incompatible.',
    docsQuery: 'Vite 6 migration guide breaking changes',
    docsUrl: 'https://vitejs.dev/guide/migration',
  },
  {
    packageName: '@tanstack/react-query',
    breakingFrom: '>=5.0.0',
    breakingMajor: 5,
    riskLevel: 'high',
    description: 'TanStack Query v5 changed: useQuery has no callbacks (onSuccess/onError removed), useInfiniteQuery signature changed, cacheTime renamed to gcTime.',
    docsQuery: 'TanStack Query v5 migration guide breaking changes',
    docsUrl: 'https://tanstack.com/query/latest/docs/framework/react/guides/migrating-to-v5',
    safeVersion: '4.x',
  },
  {
    packageName: 'eslint',
    breakingFrom: '>=9.0.0',
    breakingMajor: 9,
    riskLevel: 'medium',
    description: 'ESLint v9 replaced .eslintrc.* with flat config (eslint.config.js). Many plugins not yet compatible.',
    docsQuery: 'ESLint v9 flat config migration guide',
    docsUrl: 'https://eslint.org/docs/latest/use/configure/migration-guide',
    safeVersion: '8.x',
  },
];

// ─── Version parsing ───────────────────────────────────────────────────────────

const INSTALL_PKG_RE = /(?:^|\s)(@?[a-z][a-z0-9/_.-]*)(?:@([~^]?\*|[~^]?[0-9]+[^\s]*))?/gi;

interface ParsedPackage {
  name: string;
  /** Raw version specifier like "^7.0.0", "latest", "7", "*". */
  versionSpec: string;
  /** Extracted major version number, or null if undetermined. */
  major: number | null;
  /** Whether the specifier could resolve to a very new version (latest, *, ^major, etc.). */
  isUnconstrained: boolean;
}

function parseInstallCommand(command: string): ParsedPackage[] {
  // Strip the command prefix, leaving only the package specs
  const cleaned = command.replace(/^(?:npm\s+install|npm\s+i|yarn\s+add|pnpm\s+add)\s+/i, '').trim();
  const pkgs: ParsedPackage[] = [];
  let m: RegExpExecArray | null;
  INSTALL_PKG_RE.lastIndex = 0;

  while ((m = INSTALL_PKG_RE.exec(cleaned)) !== null) {
    const name = m[1];
    if (!name || /^-/.test(name)) continue; // skip flags

    const spec = m[2] ?? 'latest';
    const majorMatch = /^[~^]?(\d+)/.exec(spec);
    const major = majorMatch ? parseInt(majorMatch[1], 10) : null;
    const isUnconstrained = /latest|\*|\^/.test(spec) || spec === '';

    pkgs.push({ name, versionSpec: spec, major, isUnconstrained });
  }

  return pkgs;
}

function versionMeetsBreaking(pkg: ParsedPackage, entry: KnownBreakingEntry): boolean {
  // If major is known and matches or exceeds the breaking major → risk
  if (pkg.major !== null && pkg.major >= entry.breakingMajor) return true;
  // If spec is unconstrained (latest/*) → always risk for critical packages
  if (pkg.isUnconstrained && entry.riskLevel !== 'low') return true;
  return false;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Check an install command string for known compatibility risks.
 *
 * @param installCommand  The full npm/yarn/pnpm install command.
 */
export function checkInstallCompatibility(installCommand: string): CompatibilityCheckResult {
  const pkgs = parseInstallCommand(installCommand);
  const risks: CompatibilityRisk[] = [];

  for (const pkg of pkgs) {
    const entry = BREAKING_CHANGE_REGISTRY.find(e => e.packageName === pkg.name);
    if (!entry) continue;
    if (!versionMeetsBreaking(pkg, entry)) continue;

    risks.push({
      packageName: pkg.name,
      requestedSpec: pkg.versionSpec,
      riskLevel: entry.riskLevel,
      breakingVersion: entry.breakingFrom,
      description: entry.description,
      docsQuery: entry.docsQuery,
      docsUrl: entry.docsUrl,
      safeVersion: entry.safeVersion,
    });
  }

  const searchQueries = [...new Set(risks.map(r => r.docsQuery))];
  const guidance = risks.length > 0 ? buildCompatibilityGuidance(risks) : '';

  return { hasRisks: risks.length > 0, risks, searchQueries, guidance };
}

/**
 * Check a list of package names (without version specs) against the registry.
 * Used when versions are unknown (e.g., reading from package.json without lock file).
 */
export function checkPackageNames(packageNames: string[]): CompatibilityCheckResult {
  const risks: CompatibilityRisk[] = [];

  for (const name of packageNames) {
    const entry = BREAKING_CHANGE_REGISTRY.find(e => e.packageName === name);
    if (!entry || entry.riskLevel === 'low') continue;

    // No version info — flag as uncertain if the entry is high/critical
    risks.push({
      packageName: name,
      requestedSpec: 'unknown',
      riskLevel: entry.riskLevel,
      breakingVersion: entry.breakingFrom,
      description: entry.description,
      docsQuery: entry.docsQuery,
      docsUrl: entry.docsUrl,
      safeVersion: entry.safeVersion,
    });
  }

  const searchQueries = [...new Set(risks.map(r => r.docsQuery))];
  const guidance = risks.length > 0 ? buildCompatibilityGuidance(risks) : '';
  return { hasRisks: risks.length > 0, risks, searchQueries, guidance };
}

function buildCompatibilityGuidance(risks: CompatibilityRisk[]): string {
  const critical = risks.filter(r => r.riskLevel === 'critical');
  const high = risks.filter(r => r.riskLevel === 'high');

  const lines: string[] = ['', '[DEPENDENCY COMPATIBILITY WARNING]'];

  if (critical.length > 0) {
    lines.push('CRITICAL — do NOT proceed without reading the migration guide:');
    for (const r of critical) {
      lines.push(`  • ${r.packageName}: ${r.description}`);
      if (r.safeVersion) lines.push(`    Safe version: ${r.packageName}@${r.safeVersion}`);
      lines.push(`    Search for: "${r.docsQuery}"`);
    }
  }

  if (high.length > 0) {
    lines.push('HIGH RISK — verify compatibility before installing:');
    for (const r of high) {
      lines.push(`  • ${r.packageName}: ${r.description}`);
      if (r.safeVersion) lines.push(`    Safe version: ${r.packageName}@${r.safeVersion}`);
      lines.push(`    Search for: "${r.docsQuery}"`);
    }
  }

  lines.push('');
  lines.push('ACTION: Use web_search to fetch the latest migration docs before installing.');
  lines.push('Prefer stable pinned versions over "latest" for packages with known breaking changes.');

  return lines.join('\n');
}

/**
 * Get the known-safe version for a package (returns null if unknown or no risk).
 */
export function getSafeVersion(packageName: string): string | null {
  return BREAKING_CHANGE_REGISTRY.find(e => e.packageName === packageName)?.safeVersion ?? null;
}

/**
 * List all packages in the registry with risks at or above the given level.
 */
export function listRiskyPackages(minLevel: RiskLevel = 'medium'): string[] {
  const order: RiskLevel[] = ['critical', 'high', 'medium', 'low'];
  const minIdx = order.indexOf(minLevel);
  return BREAKING_CHANGE_REGISTRY
    .filter(e => order.indexOf(e.riskLevel) <= minIdx)
    .map(e => e.packageName);
}
