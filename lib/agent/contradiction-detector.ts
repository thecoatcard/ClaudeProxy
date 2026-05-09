// lib/agent/contradiction-detector.ts
//
// Contradiction loop detector — detects conceptual oscillation where the model
// cycles between opposing actions (add → remove → add → remove) or config states.
//
// Problems solved:
//   - Model adds a config key, then removes it, then adds it again.
//   - Model installs a package, then uninstalls it, then installs again.
//   - Model enables a feature, disables it, enables it.
//
// Detection strategy:
//   1. Walk message history building a timeline of (operation, target) events.
//   2. Group by target — look for ABABAB patterns of opposing operations.
//   3. Detect semantic equivalents: add/insert ↔ remove/delete, enable ↔ disable.
//   4. Emit guidance when 2+ oscillations are detected on the same target.
//
// Edge-runtime safe. Pure functions. No I/O.

export type OperationType = 'add' | 'remove' | 'enable' | 'disable' | 'install' | 'uninstall' | 'set' | 'unset' | 'write' | 'delete';

export interface ContraEvent {
  operation: OperationType;
  target: string;
  /** Normalized canonical target key (lowercased, de-pathed). */
  canonicalKey: string;
  toolName: string;
  /** Position in the message array (0-indexed). */
  messageIndex: number;
}

export interface ContraLoop {
  target: string;
  operations: OperationType[];
  oscillations: number;
  toolNames: string[];
}

export interface ContradictionDetectionResult {
  detected: boolean;
  loops: ContraLoop[];
  /** Guidance text to inject into system instruction. */
  guidance: string;
}

// ─── Operation classification ─────────────────────────────────────────────────

// Pairs of opposing operations (first is "add-like", second is "remove-like").
const OPPOSING_PAIRS: Array<[OperationType, OperationType]> = [
  ['add', 'remove'],
  ['enable', 'disable'],
  ['install', 'uninstall'],
  ['set', 'unset'],
  ['write', 'delete'],
];

function isOpposing(a: OperationType, b: OperationType): boolean {
  return OPPOSING_PAIRS.some(([x, y]) => (a === x && b === y) || (a === y && b === x));
}

// Tool → operation mappings
const TOOL_OPERATION_MAP: Array<{ toolPattern: RegExp; operation: OperationType }> = [
  { toolPattern: /\bcreate_file\b|\bwrite_file\b|\bstr_replace_editor\b/i, operation: 'write' },
  { toolPattern: /\bdelete_file\b|\bremove_file\b/i, operation: 'delete' },
  { toolPattern: /\binstall\b/i, operation: 'install' },
  { toolPattern: /\buninstall\b|\bremove_package\b/i, operation: 'uninstall' },
];

const COMMAND_OPERATION_MAP: Array<{ pattern: RegExp; operation: OperationType }> = [
  { pattern: /npm\s+install\b|yarn\s+add\b|pnpm\s+add\b|pip\s+install\b/i, operation: 'install' },
  { pattern: /npm\s+uninstall\b|yarn\s+remove\b|pnpm\s+remove\b|pip\s+uninstall\b/i, operation: 'uninstall' },
  { pattern: /\benable\b/i, operation: 'enable' },
  { pattern: /\bdisable\b/i, operation: 'disable' },
  { pattern: /\badd\b.*(?:config|option|key|line|import)/i, operation: 'add' },
  { pattern: /\bremove\b.*(?:config|option|key|line|import)|delete.*(?:config|key|line)/i, operation: 'remove' },
];

// Text content in tool inputs/outputs that signals add vs remove
const TEXT_ADD_PATTERNS = [
  /\badded?\b.*(?:import|dependency|config|option|key|line|rule)/i,
  /\binserted?\b/i,
  /\benabled?\b/i,
];
const TEXT_REMOVE_PATTERNS = [
  /\bremoved?\b.*(?:import|dependency|config|option|key|line|rule)/i,
  /\bdeleted?\b/i,
  /\bdisabled?\b/i,
];

function classifyOperation(toolName: string, input: any, intent?: string): OperationType | null {
  // Check tool name
  for (const m of TOOL_OPERATION_MAP) {
    if (m.toolPattern.test(toolName)) return m.operation;
  }

  // Check command string
  const command = typeof input?.command === 'string' ? input.command
    : typeof input?.cmd === 'string' ? input.cmd
    : '';
  if (command) {
    for (const m of COMMAND_OPERATION_MAP) {
      if (m.pattern.test(command)) return m.operation;
    }
  }

  // Check intent text
  if (intent) {
    if (TEXT_ADD_PATTERNS.some(p => p.test(intent))) return 'add';
    if (TEXT_REMOVE_PATTERNS.some(p => p.test(intent))) return 'remove';
  }

  return null;
}

function extractTarget(toolName: string, input: any): string | null {
  // File path targets
  const pathFields = ['path', 'file_path', 'filePath', 'target', 'destination'];
  for (const f of pathFields) {
    if (typeof input?.[f] === 'string' && input[f].trim()) {
      return input[f].trim();
    }
  }

  // Package names from commands
  const command = typeof input?.command === 'string' ? input.command : '';
  const pkgMatch = /(?:install|add|remove|uninstall)\s+(@?[a-z][a-z0-9/_-]*(?:@[^\s]+)?)/i.exec(command);
  if (pkgMatch?.[1]) return pkgMatch[1].split('@')[0]; // strip version

  return null;
}

function canonicalize(target: string): string {
  // Normalize: lowercase, strip leading ./, strip path separators for config keys
  return target
    .toLowerCase()
    .replace(/^\.\//, '')
    .replace(/\\/g, '/')
    .split('/')
    .pop() ?? target.toLowerCase();
}

// ─── History scanning ─────────────────────────────────────────────────────────

export function scanHistoryForContraEvents(messages: any[]): ContraEvent[] {
  const events: ContraEvent[] = [];

  for (let i = 0; i < (messages ?? []).length; i++) {
    const msg = messages[i];
    if (msg?.role !== 'assistant' || !Array.isArray(msg.content)) continue;

    for (const block of msg.content) {
      if (block?.type !== 'tool_use') continue;
      const toolName = String(block.name ?? '');
      const input = block.input ?? {};

      const op = classifyOperation(toolName, input);
      if (!op) continue;

      const target = extractTarget(toolName, input);
      if (!target) continue;

      events.push({
        operation: op,
        target,
        canonicalKey: canonicalize(target),
        toolName,
        messageIndex: i,
      });
    }
  }

  return events;
}

// ─── Loop detection ───────────────────────────────────────────────────────────

export function detectContradictionLoops(events: ContraEvent[]): ContraLoop[] {
  // Group by canonical key
  const byKey = new Map<string, ContraEvent[]>();
  for (const e of events) {
    const list = byKey.get(e.canonicalKey) ?? [];
    list.push(e);
    byKey.set(e.canonicalKey, list);
  }

  const loops: ContraLoop[] = [];

  for (const [, evts] of byKey) {
    if (evts.length < 3) continue; // Need at least 3 events to detect a cycle

    let oscillations = 0;
    for (let i = 1; i < evts.length; i++) {
      if (isOpposing(evts[i - 1].operation, evts[i].operation)) {
        oscillations++;
      }
    }

    // Only flag when oscillating 2+ times (A→B→A)
    if (oscillations >= 2) {
      loops.push({
        target: evts[0].target,
        operations: evts.map(e => e.operation),
        oscillations,
        toolNames: [...new Set(evts.map(e => e.toolName))],
      });
    }
  }

  return loops;
}

// ─── Public API ───────────────────────────────────────────────────────────────

/**
 * Scan the conversation history for contradiction loops.
 *
 * @param messages  Anthropic message array from the request.
 */
export function detectContradiction(messages: any[]): ContradictionDetectionResult {
  const events = scanHistoryForContraEvents(messages);
  const loops = detectContradictionLoops(events);

  if (loops.length === 0) {
    return { detected: false, loops: [], guidance: '' };
  }

  return {
    detected: true,
    loops,
    guidance: buildContradictionGuidance(loops),
  };
}

function buildContradictionGuidance(loops: ContraLoop[]): string {
  const lines: string[] = [
    '',
    '[CONTRADICTION LOOP DETECTED]',
    `${loops.length} oscillating action cycle(s) found — retrying the same opposing operations will not work.`,
    '',
  ];

  for (const loop of loops.slice(0, 3)) {
    const opChain = loop.operations.join(' → ');
    lines.push(`  Target: ${loop.target}`);
    lines.push(`  Cycle:  ${opChain} (${loop.oscillations} oscillations)`);
  }

  lines.push('');
  lines.push('STOP: Do not continue the retry cycle. Required actions:');
  lines.push('  1. Use web_search to fetch the authoritative docs on the correct approach.');
  lines.push('  2. Adopt a fundamentally different strategy (not a variation of the same approach).');
  lines.push('  3. If the task requires a specific config/package/API that keeps breaking, pinpoint the root cause first.');
  lines.push('  4. Report what you have tried and what failed. Ask for clarification if needed.');
  lines.push('  Do NOT oscillate again — each retry must move toward a different solution.');

  return lines.join('\n');
}
