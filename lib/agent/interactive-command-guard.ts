// InteractiveCommandGuard — behavior-layer detection of interactive CLI wizards.
//
// Interactive CLI tools block indefinitely waiting for keyboard input from a TTY.
// Claude Code's Bash tool cannot provide TTY input, so these commands stall the
// session permanently. The gateway detects them from tool_use inputs and injects
// guidance to use non-interactive (headless) flags instead.
//
// Pure functions, no I/O, no Node APIs. Edge-runtime safe.
//
// Examples of interactive commands detected:
//   shadcn init          → npx shadcn@latest init --yes --defaults
//   prisma init          → npx prisma init --datasource-provider postgresql
//   firebase init        → firebase init --project <id> (specific flags required)
//   create-t3-app        → npx create-t3-app@latest <name> --CI --noGit
//   supabase init        → supabase init (no --yes flag, so manual config needed)
//   npm init             → npm init --yes
//   npx create-next-app  → npx create-next-app@latest <name> --ts --yes

export interface InteractiveCommandDetection {
  command: string;
  matchedRule: string;
  recommendedFlags: string;
  reason: string;
}

interface InteractiveRule {
  rule: string;
  re: RegExp;
  recommendedFlags: string;
  reason: string;
}

const INTERACTIVE_CLI_RULES: InteractiveRule[] = [
  {
    rule: 'shadcn init',
    re: /\bnpx\s+shadcn(?:@[^\s]*)?\s+init\b/i,
    recommendedFlags: '--yes --defaults',
    reason: 'shadcn init prompts for component style, base color, and CSS variables interactively.',
  },
  {
    rule: 'shadcn add',
    re: /\bnpx\s+shadcn(?:@[^\s]*)?\s+add\b/i,
    recommendedFlags: '--yes',
    reason: 'shadcn add prompts to overwrite existing files.',
  },
  {
    rule: 'prisma init',
    re: /\bnpx\s+prisma\s+init\b|\bprisma\s+init\b/i,
    recommendedFlags: '--datasource-provider postgresql',
    reason: 'prisma init may prompt for datasource provider if not specified.',
  },
  {
    rule: 'firebase init',
    re: /\bfirebase\s+init\b/i,
    recommendedFlags: '--project <project-id> <feature>',
    reason: 'firebase init is a full interactive wizard; non-interactive requires explicit feature and project flags.',
  },
  {
    rule: 'create-t3-app',
    re: /\bcreate-t3-app\b/i,
    recommendedFlags: '--CI --noGit --appRouter',
    reason: 'create-t3-app enters an interactive multi-step wizard without --CI flag.',
  },
  {
    rule: 'supabase init',
    re: /\bsupabase\s+init\b/i,
    recommendedFlags: '(no --yes flag available; create supabase/config.toml manually)',
    reason: 'supabase init does not have a non-interactive mode; manually create the config file instead.',
  },
  {
    rule: 'create-next-app',
    re: /\bcreate-next-app\b/i,
    recommendedFlags: '--yes --typescript --tailwind --eslint --app --src-dir --import-alias "@/*"',
    reason: 'create-next-app prompts for TypeScript, Tailwind, ESLint, App Router, etc.',
  },
  {
    rule: 'create-react-app',
    re: /\bcreate-react-app\b/i,
    recommendedFlags: '(consider Vite: npm create vite@latest <name> -- --template react-ts)',
    reason: 'create-react-app is deprecated; Vite is non-interactive with --template flag.',
  },
  {
    rule: 'npm init (no --yes)',
    re: /\bnpm\s+init\b(?!\s+--yes|\s+-y)/i,
    recommendedFlags: '--yes',
    reason: 'npm init without --yes prompts for package name, version, description, etc.',
  },
  {
    rule: 'yarn init (no --yes)',
    re: /\byarn\s+init\b(?!\s+--yes|\s+-y)/i,
    recommendedFlags: '--yes',
    reason: 'yarn init without --yes prompts for package details interactively.',
  },
  {
    rule: 'pnpm init (no --yes)',
    re: /\bpnpm\s+init\b(?!\s+--yes|\s+-y)/i,
    recommendedFlags: '--yes',
    reason: 'pnpm init without --yes may prompt for package details.',
  },
  {
    rule: 'drizzle-kit init',
    re: /\bdrizzle-kit\s+init\b/i,
    recommendedFlags: '--config drizzle.config.ts (create config file manually)',
    reason: 'drizzle-kit init is interactive; create the drizzle.config.ts file manually instead.',
  },
  {
    rule: 'husky init',
    re: /\bnpx\s+husky\s+init\b|\bhusky\s+init\b/i,
    recommendedFlags: '(no interactive flags needed — runs non-interactively)',
    reason: 'husky init is generally non-interactive, but double-check before running.',
  },
  {
    rule: 'eslint init',
    re: /\bnpx\s+eslint\s+--init\b|\beslint\s+--init\b/i,
    recommendedFlags: '(create .eslintrc.json manually or use a preset config)',
    reason: 'eslint --init is a multi-step interactive wizard with no headless mode.',
  },
  {
    rule: 'playwright install (interactive prompt)',
    re: /\bnpx\s+playwright\s+install\b/i,
    recommendedFlags: '--with-deps chromium',
    reason: 'playwright install without browser spec may prompt; specify browsers explicitly.',
  },
  {
    rule: 'tauri init',
    re: /\btauri\s+init\b|\bcargo\s+tauri\s+init\b/i,
    recommendedFlags: '--app-name <name> --window-title <title> --frontend-dist ../dist --dev-url http://localhost:5173',
    reason: 'tauri init is a multi-step wizard; all values must be supplied via flags.',
  },
];

// Extract command text from a tool input.
function extractCommand(toolName: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  if (typeof input.command === 'string') return input.command;
  if (typeof input.cmd === 'string') return input.cmd;
  if (typeof input.script === 'string') return input.script;
  if (Array.isArray(input.args) && input.args.length > 0) return input.args.join(' ');
  // Fallback: scan string values in bash/shell-like tools
  const name = String(toolName || '').toLowerCase();
  if (/bash|shell|terminal|run|exec/.test(name)) {
    for (const v of Object.values(input)) {
      if (typeof v === 'string' && v.trim()) return v;
    }
  }
  return '';
}

/** Check a single command string against all interactive CLI rules. */
export function detectInteractiveCommand(command: string): InteractiveCommandDetection | null {
  if (!command || typeof command !== 'string') return null;
  for (const rule of INTERACTIVE_CLI_RULES) {
    if (rule.re.test(command)) {
      return {
        command,
        matchedRule: rule.rule,
        recommendedFlags: rule.recommendedFlags,
        reason: rule.reason,
      };
    }
  }
  return null;
}

/** Walk all tool_use blocks in the recent message history and collect detections. */
export function detectInteractiveCommandsInHistory(messages: any[]): InteractiveCommandDetection[] {
  const detections: InteractiveCommandDetection[] = [];
  for (const msg of messages || []) {
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type !== 'tool_use') continue;
      const command = extractCommand(String(block.name || ''), block.input || {});
      if (!command) continue;
      const detection = detectInteractiveCommand(command);
      if (detection) detections.push(detection);
    }
  }
  return detections;
}

/** Build a system instruction guidance fragment from interactive command detections. */
export function buildInteractiveCommandGuidance(detections: InteractiveCommandDetection[]): string {
  if (detections.length === 0) return '';

  const lines: string[] = [
    '---',
    `[INTERACTIVE] ${detections.length} wizard CLI(s) detected — these block on TTY input. Always use non-interactive flags.`,
  ];

  for (const d of detections) {
    lines.push(`  \`${d.command.slice(0, 80)}\` → ${d.recommendedFlags}`);
  }

  lines.push('If no headless flag exists, create config files manually instead of running the CLI.');
  lines.push('---');

  return lines.join('\n');
}
