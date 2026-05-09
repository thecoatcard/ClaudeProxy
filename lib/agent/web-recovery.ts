// lib/agent/web-recovery.ts
//
// Web search recovery engine — automatically classifies tool/domain errors and
// generates targeted search queries to official documentation.
//
// Problem solved:
//   When the model is stuck (same error repeated, unknown API, deprecated package,
//   CLI argument mismatch), guessing is not acceptable. This module triggers a
//   web_search for authoritative docs before allowing a retry.
//
// Behavior:
//   1. Classify the error into a known category.
//   2. Generate a targeted search query (official docs first).
//   3. Return guidance instructing the model to use web_search.
//
// Edge-runtime safe. Pure functions. No I/O.

export type WebRecoveryErrorClass =
  | 'prisma_migration'
  | 'nextjs_config'
  | 'package_not_found'
  | 'package_export_missing'
  | 'cli_argument_mismatch'
  | 'framework_api_change'
  | 'dependency_deprecation'
  | 'shadcn_init'
  | 'tailwind_config'
  | 'typescript_error'
  | 'docker_error'
  | 'auth_library'
  | 'build_tool_error'
  | 'unknown';

export interface WebRecoveryResult {
  errorClass: WebRecoveryErrorClass;
  /** Whether web_search should be triggered. */
  shouldSearch: boolean;
  /** Ordered list of search queries (most specific first). */
  searchQueries: string[];
  /** Priority domains to search (official docs first). */
  priorityDomains: string[];
  /** Guidance text to inject into system instruction. */
  guidance: string;
}

// ─── Error classification rules ────────────────────────────────────────────────

interface ClassificationRule {
  errorClass: WebRecoveryErrorClass;
  patterns: RegExp[];
  searchQueries: (errorText: string, toolInput?: any) => string[];
  priorityDomains: string[];
  guidanceTemplate: string;
}

const CLASSIFICATION_RULES: ClassificationRule[] = [
  {
    errorClass: 'prisma_migration',
    patterns: [
      /prisma\s+migrate|prisma\s+db\s+push|prisma\s+generate/i,
      /PrismaClientInitializationError/i,
      /Could not find Prisma Schema/i,
      /prisma\.schema/i,
    ],
    searchQueries: (text) => [
      'Prisma migrate error ' + extractErrorCode(text) + ' 2025 official docs',
      'Prisma schema migration troubleshooting site:prisma.io',
      'Prisma 7 migration guide breaking changes',
    ],
    priorityDomains: ['prisma.io', 'github.com/prisma/prisma'],
    guidanceTemplate: 'Prisma migration error detected. Use web_search with "Prisma {error} site:prisma.io" to find the exact fix. Do NOT guess Prisma CLI syntax.',
  },
  {
    errorClass: 'nextjs_config',
    patterns: [
      /Invalid next\.config/i,
      /next\.config\.(?:js|ts|mjs)\s+error/i,
      /Unrecognized key.*next\.config/i,
      /Module not found.*next\/(?:server|headers|cookies|cache)/i,
    ],
    searchQueries: (text) => [
      'Next.js config error ' + extractQuotedToken(text) + ' site:nextjs.org/docs',
      'Next.js 15 configuration migration breaking changes',
    ],
    priorityDomains: ['nextjs.org', 'github.com/vercel/next.js'],
    guidanceTemplate: 'Next.js configuration error. Use web_search on nextjs.org/docs to find the current config schema. Config options change between major versions.',
  },
  {
    errorClass: 'package_not_found',
    patterns: [
      /Cannot find module ["']([^"']+)["']/i,
      /Module not found: Can't resolve/i,
      /package\.json.*not found/i,
    ],
    searchQueries: (text) => {
      const pkg = extractModuleName(text);
      return [
        `${pkg} npm package install 2025`,
        `${pkg} module not found fix`,
      ];
    },
    priorityDomains: ['npmjs.com', 'github.com'],
    guidanceTemplate: 'Package not found. Run npm install for the missing package. Verify the correct package name on npmjs.com.',
  },
  {
    errorClass: 'package_export_missing',
    patterns: [
      /does not provide an export named/i,
      /Named export.*not found/i,
      /The requested module.*does not export/i,
      /SyntaxError: The requested module/i,
    ],
    searchQueries: (text) => [
      extractModuleName(text) + ' export API change 2025 migration',
      extractModuleName(text) + ' named export breaking change upgrade',
    ],
    priorityDomains: ['npmjs.com', 'github.com'],
    guidanceTemplate: 'Package export error — the API has likely changed in a newer version. Use web_search to find the current export names. Do NOT guess.',
  },
  {
    errorClass: 'cli_argument_mismatch',
    patterns: [
      /unknown option|unrecognized option/i,
      /unexpected argument/i,
      /Invalid option.*--/i,
      /does not accept.*argument/i,
    ],
    searchQueries: (text, input) => {
      const cmd = typeof input?.command === 'string' ? input.command.split(' ')[0] : 'command';
      return [
        cmd + ' CLI arguments reference 2025',
        cmd + ' command options official docs',
      ];
    },
    priorityDomains: ['npmjs.com', 'github.com'],
    guidanceTemplate: 'CLI argument mismatch. Use web_search to find the current CLI reference for this tool. Arguments change between versions.',
  },
  {
    errorClass: 'shadcn_init',
    patterns: [
      /shadcn.*init/i,
      /shadcn-ui.*not found/i,
      /Cannot find package.*shadcn/i,
    ],
    searchQueries: () => [
      'shadcn ui init 2025 latest command site:ui.shadcn.com',
      'npx shadcn@latest init command 2025',
    ],
    priorityDomains: ['ui.shadcn.com'],
    guidanceTemplate: 'shadcn/ui CLI changed. Use "npx shadcn@latest init" (not "shadcn-ui"). Search ui.shadcn.com for the current init command.',
  },
  {
    errorClass: 'tailwind_config',
    patterns: [
      /tailwind.*config.*error/i,
      /Cannot find.*tailwind\.config/i,
      /Unknown.*tailwind\s+class/i,
      /@tailwind\s+(base|components|utilities)/i,
    ],
    searchQueries: () => [
      'Tailwind CSS v4 configuration 2025 site:tailwindcss.com',
      'Tailwind CSS upgrade guide v3 to v4 migration',
    ],
    priorityDomains: ['tailwindcss.com'],
    guidanceTemplate: 'Tailwind CSS config error. If using v4, the config format changed completely — no tailwind.config.js, use CSS @import. Search tailwindcss.com/docs.',
  },
  {
    errorClass: 'typescript_error',
    patterns: [
      /TS\d{4}:|TypeScript error/i,
      /Type '.*' is not assignable to type/i,
      /Property '.*' does not exist on type/i,
    ],
    searchQueries: (text) => [
      'TypeScript ' + extractTsCode(text) + ' error fix',
      'TypeScript ' + extractErrorSnippet(text, 80) + ' site:typescriptlang.org',
    ],
    priorityDomains: ['typescriptlang.org', 'stackoverflow.com'],
    guidanceTemplate: 'TypeScript type error. Fix the type mismatch directly. Only use web_search if the type is from an external library.',
  },
  {
    errorClass: 'auth_library',
    patterns: [
      /next-auth|NextAuth/i,
      /auth\.js|authjs/i,
      /clerk.*error|@clerk/i,
    ],
    searchQueries: (text) => [
      extractAuthLib(text) + ' error ' + extractErrorSnippet(text, 40) + ' 2025 docs',
    ],
    priorityDomains: ['next-auth.js.org', 'authjs.dev', 'clerk.com'],
    guidanceTemplate: 'Auth library error. Auth libraries have frequent breaking changes. Use web_search for the current auth API.',
  },
  {
    errorClass: 'build_tool_error',
    patterns: [
      /vite.*error|rollup.*error/i,
      /webpack.*error/i,
      /esbuild.*error/i,
      /Cannot read.*vite\.config/i,
    ],
    searchQueries: (text) => [
      'Vite build error ' + extractErrorSnippet(text, 40) + ' 2025',
    ],
    priorityDomains: ['vitejs.dev', 'rollupjs.org'],
    guidanceTemplate: 'Build tool error. Check vite.config.ts for syntax errors. Use web_search if the config API changed.',
  },
];

// ─── Helper extractors ────────────────────────────────────────────────────────

function extractErrorCode(text: string): string {
  const m = /P\d{4}|E\d{3,4}|error\s+([A-Z]\d{3,4})/i.exec(text);
  return m?.[0] ?? '';
}

function extractQuotedToken(text: string): string {
  const m = /["'`]([^"'`]{3,40})["'`]/.exec(text);
  return m?.[1] ?? '';
}

function extractModuleName(text: string): string {
  const m = /(?:module|package|from)\s+["']([^"'@][^"']*?)["']/.exec(text)
    ?? /Cannot find module ["']([^"']+)["']/.exec(text);
  if (!m?.[1]) return 'package';
  // Return just the base package name (no subpath)
  return m[1].split('/').slice(0, m[1].startsWith('@') ? 2 : 1).join('/');
}

function extractTsCode(text: string): string {
  const m = /TS(\d{4})/.exec(text);
  return m ? `TS${m[1]}` : '';
}

function extractErrorSnippet(text: string, maxLen: number): string {
  const firstLine = text.split('\n').find(l => l.trim().length > 10) ?? text;
  return firstLine.slice(0, maxLen).replace(/[^a-z0-9\s'-]/gi, ' ').trim();
}

function extractAuthLib(text: string): string {
  if (/clerk/i.test(text)) return 'clerk';
  if (/next-auth|NextAuth/i.test(text)) return 'next-auth';
  if (/authjs|auth\.js/i.test(text)) return 'auth.js';
  return 'auth library';
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Classify an error and decide whether to trigger web_search recovery.
 *
 * @param errorText   The error string from a tool result.
 * @param toolInput   The tool input that produced the error (for context).
 * @param repeatCount How many times this same error has occurred.
 */
export function classifyAndRecover(
  errorText: string,
  toolInput?: any,
  repeatCount = 1,
): WebRecoveryResult {
  for (const rule of CLASSIFICATION_RULES) {
    const matches = rule.patterns.some(p => p.test(errorText));
    if (!matches) continue;

    const queries = rule.searchQueries(errorText, toolInput);
    return {
      errorClass: rule.errorClass,
      shouldSearch: repeatCount >= 1,
      searchQueries: queries,
      priorityDomains: rule.priorityDomains,
      guidance: buildRecoveryGuidance(rule.errorClass, queries, rule.priorityDomains, rule.guidanceTemplate),
    };
  }

  // Unknown class — trigger search after 2 repeats
  return {
    errorClass: 'unknown',
    shouldSearch: repeatCount >= 2,
    searchQueries: [extractErrorSnippet(errorText, 60) + ' fix 2025'],
    priorityDomains: ['stackoverflow.com', 'github.com'],
    guidance: repeatCount >= 2
      ? buildRecoveryGuidance('unknown', [extractErrorSnippet(errorText, 60) + ' fix 2025'], ['stackoverflow.com', 'github.com'], 'Repeated unknown error. Use web_search to find a solution.')
      : '',
  };
}

function buildRecoveryGuidance(
  errorClass: WebRecoveryErrorClass,
  queries: string[],
  domains: string[],
  template: string,
): string {
  const lines: string[] = [
    '',
    `[WEB RECOVERY — ${errorClass.toUpperCase().replace(/_/g, ' ')}]`,
    template,
    '',
    'Recovery order:',
    '  1. Use web_search with the official docs query below.',
    '  2. Read the current API/config from the docs.',
    '  3. Apply the fix using the actual current API.',
    '  4. Do NOT guess or use cached knowledge.',
    '',
    'Recommended search queries (priority order):',
    ...queries.slice(0, 3).map(q => `  • "${q}"`),
    `Priority domains: ${domains.join(', ')}`,
  ];
  return lines.join('\n');
}

/**
 * Determine whether a given error pattern warrants triggering web_search.
 * Returns true when the error is a known "docs required" class.
 */
export function requiresWebSearch(errorText: string): boolean {
  const HIGH_PRIORITY_PATTERNS = [
    /prisma\s+migrate|PrismaClientInitializationError/i,
    /shadcn.*init|tailwind.*config/i,
    /does not provide an export named/i,
    /unknown option.*--|unrecognized option/i,
    /next-auth|nextauth|@clerk/i,
    /Cannot find module.*next\//i,
  ];
  return HIGH_PRIORITY_PATTERNS.some(p => p.test(errorText));
}
