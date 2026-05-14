// lib/context/operational-state.ts
//
// Structured operational context memory — persisted in Redis per conversation.
//
// Solves the "weak operational context" problem: the model has strong semantic
// memory of what was discussed but forgets operational facts like shell type,
// which files actually exist, and which patterns have repeatedly failed.
//
// This module:
//   1. Defines the OperationalState schema.
//   2. Detects state signals from tool_use inputs and tool_result outputs.
//   3. Persists/loads state via Redis.
//   4. Builds a compact guidance block injected into systemInstruction.
//
// Edge-runtime safe — no Node APIs, no filesystem.

export interface ShellCapability {
  tty_supported: boolean;
  windows_native_commands_supported: boolean;
  unix_process_control_supported: boolean;
  interactive_stdin_supported: boolean;
}

export type ShellType = 'bash' | 'git-bash' | 'powershell' | 'cmd' | 'wsl' | 'sh' | 'zsh' | 'fish' | 'unknown';
export type EnvironmentType = 'windows' | 'unix' | 'wsl' | 'unknown';
export type ArtifactStatus = 'exists' | 'missing' | 'failed_create' | 'modified';

export interface ArtifactRecord {
  path: string;
  status: ArtifactStatus;
  /** ISO timestamp of last state change. */
  lastSeen: string;
  /** Tool that last reported this state. */
  source: string;
}

export interface FailureRecord {
  /** Short slug describing the failure class. */
  pattern: string;
  /** Human-readable description. */
  description: string;
  /** Number of times this pattern occurred. */
  count: number;
  lastSeen: string;
}

export interface BackgroundTask {
  command: string;
  /** E.g. 'npm run dev', 'uvicorn', 'cargo run'. */
  process: string;
  status: 'running' | 'stopped' | 'failed' | 'unknown';
  /** Signals that indicate successful startup, e.g. 'Ready in', 'Listening on'. */
  startupSignals: string[];
  /** Artifacts the task is expected to produce (e.g. build output dirs). */
  expectedArtifacts: string[];
  startedAt: string;
}

export interface SubagentTask {
  id: string;
  description: string;
  status: 'pending' | 'in_progress' | 'completed' | 'failed';
  owner: string;
  filesTouched: string[];
  dependencies: string[];
  startedAt: string;
  updatedAt: string;
}

export interface DependencyRecord {
  name: string;
  detectedVersion: string | null;
  requestedVersion: string | null;
  /** Source of the version information. */
  source: 'package_json' | 'install_output' | 'import_error' | 'user_mention' | 'lock_file';
  lastSeen: string;
}

export interface ToolChainEntry {
  /** Tool name that was called. */
  tool: string;
  /** Brief description of what was being done. */
  intent: string;
  /** Whether it succeeded. */
  succeeded: boolean;
}

export interface OperationalState {
  version: 3;
  conversationId: string;
  shell_type: ShellType;
  environment_type: EnvironmentType;
  shell_capability: ShellCapability;
  interactive_supported: boolean;
  /** Absolute workspace root (VS Code workspace folder or git root). */
  workspace_root: string | null;
  /** Active working directory from the last cd / cwd signal. */
  current_working_root: string | null;
  /** Legacy alias — same as workspace_root. Kept for guidance compatibility. */
  known_project_root: string | null;
  /** Map of path → ArtifactRecord. Key is the path string. */
  known_artifacts: Record<string, ArtifactRecord>;
  /** Confirmed directories (created or listed). */
  known_directories: string[];
  active_background_tasks: BackgroundTask[];
  /** Slug patterns the model should never retry (e.g. "interactive_shadcn_init"). */
  blocked_patterns: string[];
  /** Patterns that were previously blocked but are now resolved. */
  resolved_patterns: string[];
  known_failures: FailureRecord[];
  successful_patterns: string[];
  /** name → DependencyRecord. Tracks detected package versions. */
  dependency_versions: Record<string, DependencyRecord>;
  /** Subagent tasks assigned during this conversation. */
  active_subagent_tasks: SubagentTask[];
  tool_chain_state: ToolChainEntry[];
  updatedAt: string;
}

const DEFAULT_SHELL_CAPABILITY: ShellCapability = {
  tty_supported: false,
  windows_native_commands_supported: false,
  unix_process_control_supported: false,
  interactive_stdin_supported: false,
};

export function defaultOperationalState(conversationId: string): OperationalState {
  return {
    version: 3,
    conversationId,
    shell_type: 'unknown',
    environment_type: 'unknown',
    shell_capability: { ...DEFAULT_SHELL_CAPABILITY },
    interactive_supported: false,
    workspace_root: null,
    current_working_root: null,
    known_project_root: null,
    known_artifacts: {},
    known_directories: [],
    active_background_tasks: [],
    blocked_patterns: [],
    resolved_patterns: [],
    known_failures: [],
    successful_patterns: [],
    dependency_versions: {},
    active_subagent_tasks: [],
    tool_chain_state: [],
    updatedAt: new Date().toISOString(),
  };
}

// ─── Shell detection ──────────────────────────────────────────────────────────

const SHELL_PATTERNS: { re: RegExp; shell: ShellType; env: EnvironmentType; caps: Partial<ShellCapability> }[] = [
  { re: /powershell|pwsh/i, shell: 'powershell', env: 'windows', caps: { windows_native_commands_supported: true } },
  { re: /git[\s\\/-]?bash|mingw|msys/i, shell: 'git-bash', env: 'windows', caps: { unix_process_control_supported: true } },
  { re: /\bcmd\b|command\.com/i, shell: 'cmd', env: 'windows', caps: { windows_native_commands_supported: true } },
  { re: /\bwsl\b/i, shell: 'wsl', env: 'wsl', caps: { unix_process_control_supported: true, tty_supported: true } },
  { re: /\/bin\/zsh|zsh\b/i, shell: 'zsh', env: 'unix', caps: { unix_process_control_supported: true, tty_supported: true } },
  { re: /\/bin\/fish|fish\b/i, shell: 'fish', env: 'unix', caps: { unix_process_control_supported: true, tty_supported: true } },
  { re: /\/bin\/bash|bash\b/i, shell: 'bash', env: 'unix', caps: { unix_process_control_supported: true, tty_supported: true } },
  { re: /\/bin\/sh\b/i, shell: 'sh', env: 'unix', caps: { unix_process_control_supported: true } },
];

function detectShellFromText(text: string): { shell: ShellType; env: EnvironmentType; caps: Partial<ShellCapability> } | null {
  for (const p of SHELL_PATTERNS) {
    if (p.re.test(text)) return { shell: p.shell, env: p.env, caps: p.caps };
  }
  // Heuristic: Windows path separators → probably Windows
  if (/[A-Z]:[\\]/.test(text)) return { shell: 'cmd', env: 'windows', caps: { windows_native_commands_supported: true } };
  // Unix-only commands
  if (/\bkill -9\b|\bpkill\b|\bkillall\b/.test(text)) return { shell: 'bash', env: 'unix', caps: { unix_process_control_supported: true, tty_supported: true } };
  return null;
}

// ─── Artifact detection ───────────────────────────────────────────────────────

const FILE_CREATED_PATTERNS = [
  /created?\s+(?:file\s+)?[`'"]?([^\s`'"]+\.[a-z]{1,10})[`'"]?/i,
  /wrote\s+(?:to\s+)?[`'"]?([^\s`'"]+\.[a-z]{1,10})[`'"]?/i,
  /successfully\s+(?:created?|wrote)\s+[`'"]?([^\s`'"]+)[`'"]?/i,
  /\bnew file\b.*?[`'"]([^`'"]+)[`'"]/i,
];

const DIR_CREATED_PATTERNS = [
  /(?:created?|mkdir|made)\s+(?:directory\s+)?[`'"]?([^\s`'"]+\/)[`'"]?/i,
  /directory\s+[`'"]?([^\s`'"]+\/)[`'"]?\s+(?:created?|exists)/i,
];

const FILE_MISSING_PATTERNS = [
  /no such file.*?[`'"]([^`'"]+)[`'"]/i,
  /cannot find\s+[`'"]?([^\s`'"]+)[`'"]?/i,
  /file not found.*?[`'"]([^`'"]+)[`'"]/i,
];

function extractArtifactUpdates(
  toolName: string,
  toolInput: any,
  resultText: string,
  isError: boolean,
): ArtifactRecord[] {
  const now = new Date().toISOString();
  const updates: ArtifactRecord[] = [];

  // Write/create tools with explicit path
  const inputPath = typeof toolInput?.path === 'string' ? toolInput.path
    : typeof toolInput?.file_path === 'string' ? toolInput.file_path
    : null;

  if (inputPath && /write|create|edit|str_replace/i.test(toolName)) {
    updates.push({
      path: inputPath,
      status: isError ? 'failed_create' : 'exists',
      lastSeen: now,
      source: toolName,
    });
  }

  if (!isError && resultText) {
    // Scan result text for created file hints
    for (const re of FILE_CREATED_PATTERNS) {
      const m = re.exec(resultText);
      if (m?.[1]) updates.push({ path: m[1], status: 'exists', lastSeen: now, source: toolName });
    }
    for (const re of DIR_CREATED_PATTERNS) {
      const m = re.exec(resultText);
      if (m?.[1]) updates.push({ path: m[1], status: 'exists', lastSeen: now, source: toolName });
    }
  }

  if (isError && resultText) {
    for (const re of FILE_MISSING_PATTERNS) {
      const m = re.exec(resultText);
      if (m?.[1]) updates.push({ path: m[1], status: 'missing', lastSeen: now, source: toolName });
    }
  }

  return updates;
}

// ─── Failure pattern detection ────────────────────────────────────────────────

interface FailurePattern {
  slug: string;
  description: string;
  toolRe: RegExp;
  textRe: RegExp;
}

const KNOWN_FAILURE_PATTERNS: FailurePattern[] = [
  {
    slug: 'interactive_cli_wizard',
    description: 'Interactive CLI wizard blocked (requires TTY input)',
    toolRe: /bash|shell|terminal|run/i,
    textRe: /(?:shadcn|prisma|firebase|create-t3|supabase)\s+init|npm\s+init(?!\s+--yes|-y)/i,
  },
  {
    slug: 'tty_not_available',
    description: 'TTY not available (/dev/tty or similar failed)',
    toolRe: /.*/,
    textRe: /\/dev\/tty|tty\s+not\s+available|inappropriate\s+ioctl/i,
  },
  {
    slug: 'permission_denied',
    description: 'Permission denied on file or directory operation',
    toolRe: /.*/,
    textRe: /permission denied|EACCES/i,
  },
  {
    slug: 'command_not_found',
    description: 'Required command not found in PATH',
    toolRe: /bash|shell|terminal|run/i,
    textRe: /command not found|not recognized as an? (?:internal|external) command/i,
  },
  {
    slug: 'network_unreachable',
    description: 'Network or fetch operation failed',
    toolRe: /.*/,
    textRe: /ENOTFOUND|fetch failed|network\s+(?:error|unreachable)|ECONNREFUSED/i,
  },
  {
    slug: 'windows_unix_mismatch',
    description: 'Unix command run on Windows or vice versa',
    toolRe: /bash|shell|terminal|run/i,
    textRe: /(?:taskkill|net start|sc\.exe)\b.*(?:bash|sh)|(?:kill -9|pkill).*(?:\.exe|powershell)/i,
  },
];

function detectFailurePatterns(toolName: string, input: any, resultText: string): string[] {
  const inputStr = JSON.stringify(input ?? '') + (typeof input?.command === 'string' ? input.command : '');
  const patterns: string[] = [];
  for (const p of KNOWN_FAILURE_PATTERNS) {
    if (p.toolRe.test(toolName) && (p.textRe.test(resultText) || p.textRe.test(inputStr))) {
      patterns.push(p.slug);
    }
  }
  return patterns;
}

// ─── Project root detection ───────────────────────────────────────────────────

const PROJECT_ROOT_MARKERS = ['package.json', 'pyproject.toml', 'Cargo.toml', 'go.mod', 'pom.xml', '.git'];
const PROJECT_ROOT_RE = new RegExp(`(?:created?|found|at|in)\\s+["\`']?([^\s"'\`]+)(?:/(?:${PROJECT_ROOT_MARKERS.join('|')}))`, 'i');

function detectProjectRoot(text: string): string | null {
  const m = PROJECT_ROOT_RE.exec(text);
  if (m?.[1]) return m[1];
  // CWD hints
  const cwdMatch = /(?:cwd|working dir(?:ectory)?)\s*[:=]\s*["\`']?([^\s"'\`\n]+)/.exec(text);
  if (cwdMatch?.[1]) return cwdMatch[1];
  return null;
}

// ─── CWD detection ────────────────────────────────────────────────────────────

const CWD_PATTERNS: RegExp[] = [
  /(?:^|\n)\s*(?:PS|C:|D:)\s+([A-Za-z]:[\\/][^\n>]+?)\s*[>$#]/m,
  /cwd[:=]\s*["'`]?([^\s"'`\n,]+)/i,
  /current directory(?:\s+is)?:\s*["'`]?([^\s"'`\n]+)/i,
  /changed to directory[:\s]+["'`]?([^\s"'`\n]+)/i,
  /Cwd:\s*["'`]?([^\s"'`\n]+)/,
];

export function detectCwdFromText(text: string): string | null {
  for (const re of CWD_PATTERNS) {
    const m = re.exec(text);
    if (m?.[1]) return m[1].trim().replace(/['"`;,]+$/, '');
  }
  return null;
}

// ─── Dependency version detection ─────────────────────────────────────────────

const INSTALL_SUCCESS_RE = /added\s+\d+\s+packages?|successfully\s+installed/i;
const DEP_LINE_RE = /^[\s+\-~]+([a-z@][a-z0-9/_-]*)@([0-9]+\.[0-9]+(?:\.[0-9]+)?(?:-[a-z0-9.-]+)?)/gim;
const PKG_AT_VERSION_RE = /["']?([a-z@][a-z0-9/_.-]*)["']?\s*:\s*["'][~^]?([0-9]+\.[0-9]+[^"']*?)["']/g;
const IMPORT_ERROR_PKG_RE = /cannot find module ["']([^"']+)["']|module ["']([^"']+)["'] not found/i;

function extractDependencyVersions(
  toolName: string,
  toolInput: any,
  resultText: string,
  isError: boolean,
): Array<{ name: string; version: string | null; source: DependencyRecord['source'] }> {
  const found: Array<{ name: string; version: string | null; source: DependencyRecord['source'] }> = [];
  const inputStr = typeof toolInput?.command === 'string' ? toolInput.command : '';
  const isInstallCmd = /npm\s+i(?:nstall)?\b|yarn\s+add\b|pnpm\s+add\b|pip\s+install\b/i.test(inputStr);

  // npm/yarn install output: "+ prisma@7.0.0" or "- prisma@7.0.0" lines
  if (isInstallCmd && !isError && INSTALL_SUCCESS_RE.test(resultText)) {
    let m: RegExpExecArray | null;
    DEP_LINE_RE.lastIndex = 0;
    while ((m = DEP_LINE_RE.exec(resultText)) !== null) {
      if (m[1] && m[2]) found.push({ name: m[1], version: m[2], source: 'install_output' });
    }
  }

  // package.json reads: "prisma": "7.0.0"
  const inputJSON = JSON.stringify(toolInput ?? '');
  const isPackageJson = /package\.json/i.test(inputJSON);
  if (!isError && isPackageJson && resultText.includes('"dependencies"')) {
    let m: RegExpExecArray | null;
    PKG_AT_VERSION_RE.lastIndex = 0;
    while ((m = PKG_AT_VERSION_RE.exec(resultText)) !== null) {
      if (m[1] && m[2] && !m[1].startsWith('//')) {
        found.push({ name: m[1], version: m[2].replace(/[^0-9a-z.\-]/gi, ''), source: 'package_json' });
      }
    }
  }

  // Import / module-not-found errors
  if (isError && resultText) {
    const errMatch = IMPORT_ERROR_PKG_RE.exec(resultText);
    if (errMatch) {
      const pkg = (errMatch[1] ?? errMatch[2]).split('/')[0];
      found.push({ name: pkg, version: null, source: 'import_error' });
    }
  }

  return found.slice(0, 30);
}

// ─── Background task detection ────────────────────────────────────────────────

const BACKGROUND_TASK_PATTERNS = [
  { re: /\bnpm\s+run\s+(?:dev|start|serve|watch)\b/, process: 'npm', signals: ['ready', 'listening', 'started', 'compiled'] },
  { re: /\byarn\s+(?:dev|start)\b/, process: 'yarn', signals: ['ready', 'listening', 'started'] },
  { re: /\buvicorn\b/, process: 'uvicorn', signals: ['Application startup complete', 'Uvicorn running on'] },
  { re: /\bcargo\s+run\b/, process: 'cargo', signals: ['Finished', 'Running'] },
  { re: /\bdotnet\s+run\b/, process: 'dotnet', signals: ['Now listening on', 'Application started'] },
  { re: /\bdocker[- ]compose\s+up\b/, process: 'docker-compose', signals: ['healthy', 'done', 'started'] },
  { re: /\bnext\s+(?:dev|start)\b/, process: 'next', signals: ['Ready', 'started server'] },
];

function detectBackgroundTask(command: string): BackgroundTask | null {
  for (const p of BACKGROUND_TASK_PATTERNS) {
    if (p.re.test(command)) {
      return {
        command,
        process: p.process,
        status: 'unknown',
        startupSignals: p.signals,
        expectedArtifacts: [],
        startedAt: new Date().toISOString(),
      };
    }
  }
  return null;
}

// ─── State derivation from messages ──────────────────────────────────────────

export function updateStateFromMessages(state: OperationalState, messages: any[]): OperationalState {
  const now = new Date().toISOString();
  let updated = { ...state };

  // Optimization: only scan the last 6 messages. Since opState is persisted,
  // we only need to catch the most recent signals.
  const scanLimit = 10;
  const messagesToScan = (messages ?? []).slice(-scanLimit);

  for (const msg of messagesToScan) {
    if (!msg?.content) continue;
    const blocks = Array.isArray(msg.content) ? msg.content : [];

    if (msg.role === 'assistant') {
      for (const block of blocks) {
        if (block?.type !== 'tool_use') continue;
        const toolName = String(block.name ?? '');
        const input = block.input ?? {};
        const command = typeof input.command === 'string' ? input.command
          : typeof input.cmd === 'string' ? input.cmd
          : '';

        // Shell detection from bash/shell commands
        if (command && /bash|shell|terminal|run|exec/i.test(toolName)) {
          const det = detectShellFromText(command);
          if (det && updated.shell_type === 'unknown') {
            updated.shell_type = det.shell;
            updated.environment_type = det.env;
            updated.shell_capability = { ...DEFAULT_SHELL_CAPABILITY, ...det.caps };
            updated.interactive_supported = !!det.caps.interactive_stdin_supported;
          }
          // Background task detection
          const bgTask = detectBackgroundTask(command);
          if (bgTask) {
            const alreadyTracked = updated.active_background_tasks.some(t => t.command === command);
            if (!alreadyTracked) {
              updated.active_background_tasks = [...updated.active_background_tasks.slice(-4), bgTask];
            }
          }
        }
      }
    }

    if (msg.role === 'user') {
      for (const block of blocks) {
        if (block?.type !== 'tool_result') continue;
        const isError = block.is_error === true;
        const rawContent = block.content;
        const resultText = typeof rawContent === 'string' ? rawContent
          : Array.isArray(rawContent) ? rawContent.map((c: any) => c?.text ?? '').join('\n')
          : '';

        // Find the matching tool_use to get name and input
        // (We scan the preceding assistant turn for this tool_use_id)
        const toolUseId = block.tool_use_id;
        let toolName = 'unknown';
        let toolInput: any = {};
        for (const prevMsg of messages) {
          if (prevMsg?.role !== 'assistant' || !Array.isArray(prevMsg.content)) continue;
          for (const b of prevMsg.content) {
            if (b?.type === 'tool_use' && b.id === toolUseId) {
              toolName = String(b.name ?? '');
              toolInput = b.input ?? {};
            }
          }
        }

        // Artifact tracking
        const artUpdates = extractArtifactUpdates(toolName, toolInput, resultText, isError);
        for (const art of artUpdates) {
          updated.known_artifacts = { ...updated.known_artifacts, [art.path]: art };
        }

        // Shell detection from result text (e.g. error messages revealing shell type)
        if (updated.shell_type === 'unknown' && resultText) {
          const det = detectShellFromText(resultText);
          if (det) {
            updated.shell_type = det.shell;
            updated.environment_type = det.env;
            updated.shell_capability = { ...DEFAULT_SHELL_CAPABILITY, ...det.caps };
          }
        }

        // Project root + workspace root + CWD detection
        if (resultText) {
          const root = detectProjectRoot(resultText);
          if (root) {
            if (!updated.known_project_root) updated.known_project_root = root;
            if (!updated.workspace_root) updated.workspace_root = root;
          }
          const cwd = detectCwdFromText(resultText);
          if (cwd) updated.current_working_root = cwd;
        }

        // Directory tracking from ls/list tool results
        if (!isError && /list|ls|dir|readdir/i.test(toolName)) {
          const dirPath = typeof toolInput?.path === 'string' ? toolInput.path : null;
          if (dirPath && !updated.known_directories.includes(dirPath)) {
            updated.known_directories = [...updated.known_directories.slice(-49), dirPath];
          }
        }

        // Dependency version detection
        const depUpdates = extractDependencyVersions(toolName, toolInput, resultText, isError);
        for (const dep of depUpdates) {
          const existing = updated.dependency_versions[dep.name];
          updated.dependency_versions = {
            ...updated.dependency_versions,
            [dep.name]: {
              name: dep.name,
              detectedVersion: dep.version ?? existing?.detectedVersion ?? null,
              requestedVersion: existing?.requestedVersion ?? dep.version,
              source: dep.source,
              lastSeen: now,
            },
          };
        }

        // Failure pattern recording
        if (isError) {
          const slugs = detectFailurePatterns(toolName, toolInput, resultText);
          for (const slug of slugs) {
            const existing = updated.known_failures.find(f => f.pattern === slug);
            if (existing) {
              updated.known_failures = updated.known_failures.map(f =>
                f.pattern === slug ? { ...f, count: f.count + 1, lastSeen: now } : f
              );
            } else {
              const desc = KNOWN_FAILURE_PATTERNS.find(p => p.slug === slug)?.description ?? slug;
              updated.known_failures = [...updated.known_failures, { pattern: slug, description: desc, count: 1, lastSeen: now }];
            }
            // Add to blocked_patterns if repeated 2+ times
            if ((updated.known_failures.find(f => f.pattern === slug)?.count ?? 0) >= 2) {
              if (!updated.blocked_patterns.includes(slug)) {
                updated.blocked_patterns = [...updated.blocked_patterns, slug];
              }
            }
          }
        }

        // Background task startup signal detection
        // Check isError first — an error result always means the task failed,
        // even if the error text accidentally contains a signal substring
        // (e.g. "address already in use" contains the substring "ready").
        updated.active_background_tasks = updated.active_background_tasks.map(task => {
          if (task.status !== 'unknown' && task.status !== 'running') return task;
          if (isError) return { ...task, status: 'failed' };
          if (task.startupSignals.some(sig => resultText.toLowerCase().includes(sig.toLowerCase()))) {
            return { ...task, status: 'running' };
          }
          return task;
        });
      }
    }
  }

  updated.updatedAt = now;
  return updated;
}

// ─── Redis persistence ────────────────────────────────────────────────────────

const OP_STATE_TTL = 21600; // 6 hours
const OP_STATE_MAX_ARTIFACTS = 100;
const OP_STATE_MAX_FAILURES = 20;
const OP_STATE_MAX_TASKS = 10;

export function operationalStateKey(conversationId: string): string {
  return `opstate:v3:${conversationId}`;
}

export interface OperationalStateStore {
  get(key: string): Promise<string | null>;
  set(key: string, value: string, ttl: number): Promise<void>;
}

export async function loadOperationalState(
  conversationId: string,
  store: OperationalStateStore,
): Promise<OperationalState> {
  try {
    const raw = await store.get(operationalStateKey(conversationId));
    if (!raw) return defaultOperationalState(conversationId);
    const parsed = JSON.parse(raw);
    if (parsed?.version !== 3 || parsed?.conversationId !== conversationId) {
      return defaultOperationalState(conversationId);
    }
    return parsed as OperationalState;
  } catch {
    return defaultOperationalState(conversationId);
  }
}

/** Trim state to stay within storage bounds before saving. */
function trimState(state: OperationalState): OperationalState {
  const artifacts = Object.entries(state.known_artifacts);
  let trimmedArtifacts = state.known_artifacts;
  if (artifacts.length > OP_STATE_MAX_ARTIFACTS) {
    // Optimization: avoid full sort if we only need to drop oldest.
    // However, for 100 items, sort is fine. Just ensuring we don't do it unnecessarily.
    const sorted = artifacts.sort((a, b) => b[1].lastSeen.localeCompare(a[1].lastSeen));
    trimmedArtifacts = Object.fromEntries(sorted.slice(0, OP_STATE_MAX_ARTIFACTS));
  }
  // Trim dependency versions — keep the 50 most-recently-seen.
  const depEntries = Object.entries(state.dependency_versions);
  const trimmedDeps = depEntries.length > 50
    ? Object.fromEntries(depEntries.sort((a, b) => b[1].lastSeen.localeCompare(a[1].lastSeen)).slice(0, 50))
    : state.dependency_versions;

  return {
    ...state,
    known_artifacts: trimmedArtifacts,
    known_directories: (state.known_directories ?? []).slice(-50),
    known_failures: state.known_failures.slice(-OP_STATE_MAX_FAILURES),
    active_background_tasks: state.active_background_tasks.slice(-OP_STATE_MAX_TASKS),
    active_subagent_tasks: (state.active_subagent_tasks ?? []).slice(-20),
    tool_chain_state: state.tool_chain_state.slice(-20),
    successful_patterns: state.successful_patterns.slice(-20),
    resolved_patterns: (state.resolved_patterns ?? []).slice(-20),
    dependency_versions: trimmedDeps,
  };
}

export async function saveOperationalState(
  state: OperationalState,
  store: OperationalStateStore,
): Promise<void> {
  try {
    const trimmed = trimState(state);
    await store.set(operationalStateKey(state.conversationId), JSON.stringify(trimmed), OP_STATE_TTL);
  } catch {
    // Best-effort — never crash the request flow.
  }
}

// ─── Guidance generation ──────────────────────────────────────────────────────

/** Build a compact system instruction fragment from the current operational state. */
export function buildOperationalGuidance(state: OperationalState): string {
  const hasNewFields = !!state.workspace_root || Object.keys(state.dependency_versions ?? {}).length > 0;
  if (state.shell_type === 'unknown' && state.environment_type === 'unknown'
    && Object.keys(state.known_artifacts).length === 0
    && state.blocked_patterns.length === 0
    && state.active_background_tasks.length === 0
    && !hasNewFields) {
    return '';
  }

  const lines: string[] = ['---', '[CTX]'];

  // Shell & environment
  if (state.shell_type !== 'unknown') {
    lines.push(`Shell: ${state.shell_type} | Environment: ${state.environment_type}`);
    const caps: string[] = [];
    if (!state.shell_capability.tty_supported) caps.push('no TTY');
    if (!state.shell_capability.interactive_stdin_supported) caps.push('no interactive stdin');
    if (state.shell_capability.windows_native_commands_supported) caps.push('Windows commands available');
    if (state.shell_capability.unix_process_control_supported) caps.push('Unix process control available');
    if (caps.length) lines.push(`  Capabilities: ${caps.join(', ')}`);
  }

  // Workspace root / CWD
  if (state.workspace_root) {
    lines.push(`Workspace root: ${state.workspace_root}`);
  } else if (state.known_project_root) {
    lines.push(`Project root: ${state.known_project_root}`);
  }
  if (state.current_working_root && state.current_working_root !== (state.workspace_root ?? state.known_project_root)) {
    lines.push(`Current working directory: ${state.current_working_root}`);
  }

  // Known artifacts (only exists/missing, skip failed_create details)
  const existingFiles = Object.entries(state.known_artifacts)
    .filter(([, v]) => v.status === 'exists')
    .map(([k]) => k)
    .slice(0, 15);
  const missingFiles = Object.entries(state.known_artifacts)
    .filter(([, v]) => v.status === 'missing')
    .map(([k]) => k)
    .slice(0, 10);
  if (existingFiles.length) lines.push(`Known existing files/dirs: ${existingFiles.join(', ')}`);
  if (missingFiles.length) lines.push(`Known missing files/dirs: ${missingFiles.join(', ')}`);

  // Known directories
  if ((state.known_directories ?? []).length > 0) {
    lines.push(`Confirmed directories: ${state.known_directories.slice(0, 10).join(', ')}`);
  }

  // Dependency versions
  const depKeys = Object.keys(state.dependency_versions ?? {});
  if (depKeys.length > 0) {
    const withVersion = depKeys
      .filter(k => state.dependency_versions[k].detectedVersion)
      .slice(0, 10)
      .map(k => `${k}@${state.dependency_versions[k].detectedVersion}`);
    if (withVersion.length) lines.push(`Detected dependency versions: ${withVersion.join(', ')}`);
    const missingPkgs = depKeys
      .filter(k => state.dependency_versions[k].source === 'import_error')
      .slice(0, 5);
    if (missingPkgs.length) lines.push(`Missing/uninstalled packages: ${missingPkgs.join(', ')}`);
  }

  // Active subagent tasks
  const pendingTasks = (state.active_subagent_tasks ?? []).filter(t => t.status !== 'completed' && t.status !== 'failed');
  if (pendingTasks.length > 0) {
    lines.push('Active subagent tasks:');
    for (const t of pendingTasks.slice(0, 5)) {
      lines.push(`  - [${t.status.toUpperCase()}] ${t.description} (owner: ${t.owner})`);
      if (t.filesTouched.length) lines.push(`    Files: ${t.filesTouched.slice(0, 3).join(', ')}`);
    }
  }

  // Active background tasks
  const running = state.active_background_tasks.filter(t => t.status === 'running');
  const unknown = state.active_background_tasks.filter(t => t.status === 'unknown');
  if (running.length) {
    lines.push(`Background processes running: ${running.map(t => t.process).join(', ')}`);
    lines.push('  Do NOT attempt to restart or terminate these unless explicitly requested.');
  }
  if (unknown.length) {
    lines.push(`Background processes (startup state unknown): ${unknown.map(t => t.process).join(', ')}`);
    lines.push('  Check logs before assuming they started or failed.');
  }

  // Blocked patterns
  if (state.blocked_patterns.length > 0) {
    lines.push(`BLOCKED patterns (do NOT retry): ${state.blocked_patterns.join(', ')}`);
  }

  // Recent failures
  const recentFailures = state.known_failures.filter(f => f.count >= 2);
  if (recentFailures.length > 0) {
    lines.push('Repeated failures (find a different approach):');
    for (const f of recentFailures.slice(0, 5)) {
      lines.push(`  - ${f.description} (${f.count}× failed)`);
    }
  }

  // Resolved patterns
  if ((state.resolved_patterns ?? []).length > 0) {
    lines.push(`Previously resolved: ${state.resolved_patterns.slice(0, 5).join(', ')}`);
  }

  // Shell-specific warnings
  if (state.environment_type === 'windows' && state.shell_type !== 'wsl') {
    lines.push('WARNING: Windows environment — do NOT use /dev/null, kill -9, pkill, or Unix-only paths.');
  }
  if (state.shell_type === 'git-bash') {
    lines.push('WARNING: Git Bash — mixed Windows/Unix commands. Use kill {pid} or taskkill /F /PID {pid} to stop processes.');
  }
  if (!state.shell_capability.interactive_stdin_supported) {
    lines.push('WARNING: Interactive stdin not supported. Always use non-interactive flags for CLI tools.');
  }

  // Efficiency & Discovery Tips
  if (state.tool_chain_state.length > 5) {
    lines.push('Efficiency Tip: Emit multiple tool calls (e.g. 3+ write_file calls) in a single turn if tasks are independent.');
  }
  if (state.workspace_root && existingFiles.length < 5) {
    lines.push('Discovery Tip: Use list_dir recursively (ls -R) or search to locate project files like index.html or package.json.');
  }

  lines.push('---');
  return lines.join('\n');
}
