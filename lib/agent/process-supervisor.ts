// LongRunningProcessSupervisor — behavior-layer detection and guidance only.
//
// This module is translator-safe and edge-runtime safe:
// - no process spawning
// - no filesystem access
// - no runtime control of tools
// It only detects long-running process intent and interprets tool output text.

export type ProcessIntentClass = 'LONG_RUNNING_PROCESS' | 'NON_LONG_RUNNING';
export type ProcessStartupState = 'STARTED' | 'FAILED' | 'UNKNOWN';
export type ShellEnvironment = 'git-bash' | 'powershell' | 'cmd' | 'wsl' | 'unix' | 'unknown';

export interface ProcessCommandDetection {
  intent: ProcessIntentClass;
  command: string;
  ecosystem: string;
  matchedRule: string;
  normalizedCommand: string;
}

export interface ProcessOutputAnalysis {
  state: ProcessStartupState;
  hasPortFallback: boolean;
  matchedSuccessSignals: string[];
  matchedFailureSignals: string[];
  inferredExitCode: number | null;
  rationale: string;
}

export interface HistoryProcessAssessment {
  foundLongRunningCommand: boolean;
  lastCommand?: ProcessCommandDetection;
  lastAnalysis?: ProcessOutputAnalysis;
  environment: ShellEnvironment;
  guidance: string;
}

interface ToolPair {
  command: string;
  toolName: string;
  resultText: string;
  isError: boolean;
}

const LONG_RUNNING_RULES: Array<{ rule: string; ecosystem: string; re: RegExp }> = [
  { rule: 'npm run dev', ecosystem: 'javascript', re: /\bnpm\s+run\s+dev(\s|$)/i },
  { rule: 'pnpm dev', ecosystem: 'javascript', re: /\bpnpm\s+dev(\s|$)/i },
  { rule: 'yarn dev', ecosystem: 'javascript', re: /\byarn\s+dev(\s|$)/i },
  { rule: 'next dev', ecosystem: 'javascript', re: /\bnext\s+dev(\s|$)/i },
  { rule: 'vite', ecosystem: 'javascript', re: /(^|\s)vite(\s|$)/i },
  { rule: 'nodemon', ecosystem: 'javascript', re: /(^|\s)nodemon(\s|$)/i },
  { rule: 'webpack serve', ecosystem: 'javascript', re: /\bwebpack\s+serve(\s|$)/i },
  { rule: 'flask run', ecosystem: 'python', re: /\bflask\s+run(\s|$)/i },
  { rule: 'uvicorn', ecosystem: 'python', re: /\buvicorn\b/i },
  { rule: 'gunicorn', ecosystem: 'python', re: /\bgunicorn\b/i },
  { rule: 'django runserver', ecosystem: 'python', re: /\bpython\s+manage\.py\s+runserver(\s|$)|\bdjango-admin\s+runserver(\s|$)/i },
  { rule: 'streamlit run', ecosystem: 'python', re: /\bstreamlit\s+run(\s|$)/i },
  { rule: 'go run', ecosystem: 'go', re: /\bgo\s+run\b/i },
  { rule: 'air', ecosystem: 'go', re: /(^|\s)air(\s|$)/i },
  { rule: 'cargo run', ecosystem: 'rust', re: /\bcargo\s+run(\s|$)/i },
  { rule: 'cargo watch', ecosystem: 'rust', re: /\bcargo\s+watch(\s|$)/i },
  { rule: 'spring-boot:run', ecosystem: 'java', re: /\bspring-boot:run(\s|$)/i },
  { rule: 'bootRun', ecosystem: 'java', re: /\bbootRun(\s|$)/i },
  { rule: 'artisan serve', ecosystem: 'php', re: /\bartisan\s+serve(\s|$)/i },
  { rule: 'php -S', ecosystem: 'php', re: /\bphp\s+-S\s+/i },
  { rule: 'rails server', ecosystem: 'ruby', re: /\brails\s+server(\s|$)|\brails\s+s(\s|$)/i },
  { rule: 'dotnet run', ecosystem: 'csharp', re: /\bdotnet\s+run(\s|$)/i },
  { rule: 'docker compose up', ecosystem: 'docker', re: /\bdocker\s+compose\s+up(\s|$)/i },
  { rule: 'docker run', ecosystem: 'docker', re: /\bdocker\s+run(\s|$)/i },
  { rule: 'serve', ecosystem: 'generic', re: /(^|\s)serve(\s|$)/i },
  { rule: 'live-server', ecosystem: 'generic', re: /\blive-server(\s|$)/i },
  { rule: 'http-server', ecosystem: 'generic', re: /\bhttp-server(\s|$)/i },
];

const SCRIPT_ALIAS_RULES: Array<{ ecosystem: string; re: RegExp; rule: string }> = [
  { ecosystem: 'javascript', rule: 'npm/pnpm/yarn script alias', re: /\b(?:npm|pnpm|yarn|bun)\s+(?:run\s+)?(?:dev|start|serve|watch|preview)\b/i },
  { ecosystem: 'python', rule: 'python task alias', re: /\b(?:poetry|pipenv)\s+run\s+(?:uvicorn|gunicorn|flask\s+run|streamlit\s+run)\b/i },
  { ecosystem: 'rust', rule: 'cargo alias', re: /\bcargo\s+(?:watch\s+-x\s+run|run)\b/i },
];

const NON_LONG_RUNNING_GUARD = /\b(?:build|lint|test|typecheck|check|fmt|format|compile)\b/i;

const SUCCESS_SIGNALS: Array<{ name: string; re: RegExp }> = [
  { name: 'listening on', re: /\blistening on\b/i },
  { name: 'server started', re: /\bserver started\b/i },
  { name: 'ready on', re: /\bready on\b/i },
  { name: 'compiled successfully', re: /\bcompiled successfully\b/i },
  { name: 'running at', re: /\brunning at\b/i },
  { name: 'local', re: /\blocal\s*:\s*https?:\/\//i },
  { name: 'network', re: /\bnetwork\s*:\s*https?:\/\//i },
  { name: 'ready in', re: /\bready in\b/i },
  { name: 'started successfully', re: /\bstarted successfully\b/i },
  { name: 'application startup complete', re: /\bapplication startup complete\b/i },
];

const FAILURE_SIGNALS: Array<{ name: string; re: RegExp }> = [
  { name: 'syntax error', re: /\bsyntax error\b/i },
  { name: 'failed to compile', re: /\bfailed to compile\b/i },
  { name: 'module not found', re: /\bmodule not found\b/i },
  { name: 'import error', re: /\bimport error\b/i },
  { name: 'panic', re: /\bpanic\b/i },
  { name: 'traceback', re: /\btraceback\b/i },
  { name: 'unhandled exception', re: /\bunhandled exception\b/i },
  { name: 'failed to start', re: /\bfailed to start\b/i },
];

const PORT_FALLBACK_SIGNALS: RegExp[] = [
  /\bport\s+\d+\s+already in use\b/i,
  /\busing available port\b/i,
  /\bfallback port selected\b/i,
  /\bport\s+\d+\s+is in use\b/i,
];

function normalizeCommand(command: string): string {
  return command.trim().replace(/\s+/g, ' ');
}

function extractCommandFromToolUse(toolName: string, input: any): string {
  if (!input || typeof input !== 'object') return '';
  const name = String(toolName || '').toLowerCase();

  if (typeof input.command === 'string') return input.command;
  if (typeof input.cmd === 'string') return input.cmd;
  if (typeof input.script === 'string') return input.script;
  if (Array.isArray(input.args) && input.args.length > 0 && typeof input.args[0] === 'string') {
    return input.args.join(' ');
  }

  if (/bash|shell|terminal|run|exec/.test(name)) {
    for (const v of Object.values(input)) {
      if (typeof v === 'string' && v.trim()) return v;
    }
  }
  return '';
}

function extractToolPairs(messages: any[]): ToolPair[] {
  const toolUseById = new Map<string, { name: string; input: any }>();
  const pairs: ToolPair[] = [];

  for (const msg of messages || []) {
    if (msg?.role === 'assistant' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type === 'tool_use' && typeof block.id === 'string') {
          toolUseById.set(block.id, { name: String(block.name || ''), input: block.input || {} });
        }
      }
    }

    if (msg?.role === 'user' && Array.isArray(msg.content)) {
      for (const block of msg.content) {
        if (block?.type !== 'tool_result' || typeof block.tool_use_id !== 'string') continue;
        const tool = toolUseById.get(block.tool_use_id);
        if (!tool) continue;

        const resultText =
          typeof block.content === 'string'
            ? block.content
            : Array.isArray(block.content)
              ? block.content.map((c: any) => (typeof c === 'string' ? c : c?.text || '')).join('\n')
              : JSON.stringify(block.content || {});

        pairs.push({
          command: extractCommandFromToolUse(tool.name, tool.input),
          toolName: tool.name,
          resultText,
          isError: block.is_error === true,
        });
      }
    }
  }

  return pairs;
}

export function detectShellEnvironment(command: string): ShellEnvironment {
  const c = String(command || '').toLowerCase();
  if (!c.trim()) return 'unknown';
  if (/\bcmd\s*\/c\b/.test(c)) return 'cmd';
  if (/\bpowershell\b|\bpwsh\b/.test(c)) return 'powershell';
  if (/\/bin\/(?:sh|bash|zsh)\b|\bkill\s+-9\b|\bnohup\b/.test(c)) return 'unix';
  if (/\bwsl\b|\bubuntu\b|\/mnt\//.test(c)) return 'wsl';
  if (/\bgit\s+bash\b|\bbash\s+-lc\b|\bmsys\b/.test(c)) return 'git-bash';
  return 'unknown';
}

export function getTerminationGuidance(env: ShellEnvironment): string {
  if (env === 'powershell' || env === 'cmd') {
    return 'If termination is needed, use `taskkill /F /PID <pid>` from CMD/PowerShell.';
  }
  if (env === 'git-bash') {
    return 'If termination is needed from Git Bash on Windows, prefer `cmd /c taskkill /F /PID <pid>`.';
  }
  if (env === 'wsl' || env === 'unix') {
    return 'If termination is needed in Unix/WSL, use `kill -9 <pid>` in the same process namespace.';
  }
  return 'If termination is needed, choose an environment-correct kill strategy for the shell in use.';
}

export function detectLongRunningProcessCommand(command: string): ProcessCommandDetection {
  const normalized = normalizeCommand(command);
  const lowered = normalized.toLowerCase();

  for (const rule of LONG_RUNNING_RULES) {
    if (rule.re.test(lowered)) {
      return {
        intent: 'LONG_RUNNING_PROCESS',
        command,
        ecosystem: rule.ecosystem,
        matchedRule: rule.rule,
        normalizedCommand: normalized,
      };
    }
  }

  for (const alias of SCRIPT_ALIAS_RULES) {
    if (alias.re.test(lowered)) {
      return {
        intent: 'LONG_RUNNING_PROCESS',
        command,
        ecosystem: alias.ecosystem,
        matchedRule: alias.rule,
        normalizedCommand: normalized,
      };
    }
  }

  if (NON_LONG_RUNNING_GUARD.test(lowered)) {
    return {
      intent: 'NON_LONG_RUNNING',
      command,
      ecosystem: 'generic',
      matchedRule: 'non-long-running guard',
      normalizedCommand: normalized,
    };
  }

  return {
    intent: 'NON_LONG_RUNNING',
    command,
    ecosystem: 'generic',
    matchedRule: 'no long-running match',
    normalizedCommand: normalized,
  };
}

export function analyzeLongRunningProcessOutput(resultText: string, isError = false): ProcessOutputAnalysis {
  const text = String(resultText || '');

  const matchedSuccessSignals = SUCCESS_SIGNALS.filter(s => s.re.test(text)).map(s => s.name);
  const matchedFailureSignals = FAILURE_SIGNALS.filter(s => s.re.test(text)).map(s => s.name);
  const hasPortFallback = PORT_FALLBACK_SIGNALS.some(re => re.test(text));

  const exitMatch = text.match(/\b(?:exit(?:ed)?\s+with\s+(?:code|status)|code)\s*[:=]?\s*(-?\d+)\b/i);
  const inferredExitCode = exitMatch ? Number(exitMatch[1]) : null;

  // Priority: success > failure > exit code
  if (matchedSuccessSignals.length > 0) {
    return {
      state: 'STARTED',
      hasPortFallback,
      matchedSuccessSignals,
      matchedFailureSignals,
      inferredExitCode,
      rationale: hasPortFallback
        ? 'Startup success signals detected with port fallback; fallback is treated as recovery.'
        : 'Startup success signals detected.',
    };
  }

  if (matchedFailureSignals.length > 0 || isError) {
    return {
      state: 'FAILED',
      hasPortFallback,
      matchedSuccessSignals,
      matchedFailureSignals,
      inferredExitCode,
      rationale: matchedFailureSignals.length > 0
        ? 'Startup failure signals detected in output.'
        : 'Tool result flagged error without startup success evidence.',
    };
  }

  if (inferredExitCode !== null && inferredExitCode !== 0) {
    return {
      state: 'FAILED',
      hasPortFallback,
      matchedSuccessSignals,
      matchedFailureSignals,
      inferredExitCode,
      rationale: `No startup signals found and non-zero exit code (${inferredExitCode}) inferred.`,
    };
  }

  return {
    state: 'UNKNOWN',
    hasPortFallback,
    matchedSuccessSignals,
    matchedFailureSignals,
    inferredExitCode,
    rationale: 'No conclusive startup success or failure signals detected.',
  };
}

export function assessLongRunningProcessHistory(messages: any[]): HistoryProcessAssessment {
  const pairs = extractToolPairs(messages);
  const lastLongRunningPair = [...pairs].reverse().find(p => detectLongRunningProcessCommand(p.command).intent === 'LONG_RUNNING_PROCESS');

  // Also inspect pending tool_use without tool_result yet.
  let pendingCommand = '';
  for (let i = (messages || []).length - 1; i >= 0; i--) {
    const msg = messages[i];
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block?.type === 'tool_use') {
        const cmd = extractCommandFromToolUse(String(block.name || ''), block.input || {});
        if (detectLongRunningProcessCommand(cmd).intent === 'LONG_RUNNING_PROCESS') {
          pendingCommand = cmd;
          break;
        }
      }
    }
    if (pendingCommand) break;
  }

  const commandForEnv = lastLongRunningPair?.command || pendingCommand;
  const environment = detectShellEnvironment(commandForEnv);

  if (!lastLongRunningPair && !pendingCommand) {
    return {
      foundLongRunningCommand: false,
      environment,
      guidance: '',
    };
  }

  const detection = detectLongRunningProcessCommand(lastLongRunningPair?.command || pendingCommand);
  const analysis = lastLongRunningPair
    ? analyzeLongRunningProcessOutput(lastLongRunningPair.resultText, lastLongRunningPair.isError)
    : undefined;

  const baseGuidance =
    'This appears to be a long-running process. Run in background and verify startup logs.';

  const monitoringGuidance =
    'Use interval monitoring: check logs every 30 seconds, continue once startup success is detected, and do not block indefinitely.';

  const terminationGuidance = getTerminationGuidance(environment);

  let stateGuidance = '';
  if (analysis?.state === 'STARTED') {
    stateGuidance =
      'Startup success detected. Continue workflow and do not perform cleanup/termination unless explicitly required.';
  } else if (analysis?.state === 'FAILED') {
    stateGuidance =
      'Startup failure detected. Diagnose startup error and retry with corrected command or parameters.';
  } else {
    stateGuidance =
      'Startup state is unknown. Continue monitoring logs instead of treating the process as blocking completion.';
  }

  return {
    foundLongRunningCommand: true,
    lastCommand: detection,
    lastAnalysis: analysis,
    environment,
    guidance: ['', '---', '[LONG-RUNNING PROCESS SUPERVISOR]', baseGuidance, monitoringGuidance, stateGuidance, terminationGuidance, '---', ''].join('\n'),
  };
}
