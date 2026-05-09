/**
 * lib/agent/task-complexity.ts
 *
 * Classify the complexity of an incoming task so the orchestrator layer
 * can decide whether to run in direct (linear) mode or coordinator mode.
 *
 * Levels:
 *   TRIVIAL    — single-step, no tools, no system changes
 *   NORMAL     — small coding task, single file, few tools
 *   COMPLEX    — multiple files / tools / systems
 *   MULTI_STAGE— full app build, refactor, architecture work
 *
 * Rule: NORMAL and above → orchestrator mode is MANDATORY.
 */

export type ComplexityLevel = 'TRIVIAL' | 'NORMAL' | 'COMPLEX' | 'MULTI_STAGE';

export interface ComplexityResult {
  level: ComplexityLevel;
  reason: string;
  orchestratorRequired: boolean;
  /** True when an explicit user override command was detected. */
  explicitOverride: boolean;
}

// ---------------------------------------------------------------------------
// Keyword patterns
// ---------------------------------------------------------------------------

/** Keywords that force orchestrator mode via explicit user command. */
const ORCHESTRATOR_OVERRIDE_PATTERNS = [
  /switch\s+to\s+orchestrator/i,
  /use\s+sub\s*agents?/i,
  /paralleli[zs]e/i,
  /delegate/i,
];

/** Keywords that indicate a MULTI_STAGE task. */
const MULTI_STAGE_PATTERNS = [
  /\bfrom\s+scratch\b/i,
  /\bfull[\s-]stack\b/i,
  /\bcreate\s+(an?\s+)?(full|complete|new)\s+(app|application|project|system|platform|service)\b/i,
  /\bbuild\s+(an?\s+)?(app|application|project|system|platform|service)\b/i,
  /\barchitecture\b/i,
  /\brefactor\b/i,
  /\bdashboard\b/i,
  /\bdatabase\b/i,
  /\bauthentication?\b/i,
  /\bauth\s+system\b/i,
  /\bmigrat(e|ion)\b/i,
];

/** Keywords that indicate a COMPLEX task. */
const COMPLEX_PATTERNS = [
  /\bapi\b/i,
  /\bmulti[\s-]?file\b/i,
  /\bmodule\b/i,
  /\bintegrat(e|ion)\b/i,
  /\brefactor\b/i,
  /\bgenerate\s+(a\s+)?(class|service|component|hook|module|interface|type|schema)\b/i,
  /\bsetup\b/i,
  /\bscaffold\b/i,
  /\bdeployment\b/i,
  /\bmicroservice\b/i,
  /\bwebhook\b/i,
  /\bqueue\b/i,
  /\bcache\b/i,
  /\btest\s+suite\b/i,
];

/** Keywords that indicate a TRIVIAL task. */
const TRIVIAL_PATTERNS = [
  /^(hi|hello|hey|ping|status|health|ok\??)$/i,
  /^what\s+is\s+/i,
  /^(explain|describe)\s+/i,
  /\bquick\s+fix\b/i,
  /\btiny\b/i,
  /\blint\b/i,
  /\bformat\s+(this|the)?\s*(file|code)?\b/i,
  /\bsingle\s+line\b/i,
  /\btypo\b/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function extractText(requestBody: unknown): string {
  if (!requestBody || typeof requestBody !== 'object') return '';
  const body = requestBody as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const parts: string[] = [];

  // Include the system prompt if present
  if (typeof body.system === 'string') parts.push(body.system);

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown>;
    if (m?.role !== 'user') continue;
    const content = m?.content;
    if (typeof content === 'string') {
      parts.push(content);
      break;
    }
    if (Array.isArray(content)) {
      const text = (content as Array<Record<string, unknown>>)
        .map((b) => (typeof b?.text === 'string' ? b.text : ''))
        .join(' ');
      parts.push(text);
      break;
    }
  }

  return parts.join(' ');
}

function countToolsInRequest(requestBody: unknown): number {
  if (!requestBody || typeof requestBody !== 'object') return 0;
  const tools = (requestBody as Record<string, unknown>).tools;
  return Array.isArray(tools) ? tools.length : 0;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export function classifyComplexity(requestBody: unknown): ComplexityResult {
  const text = extractText(requestBody);
  const toolCount = countToolsInRequest(requestBody);

  // --- Explicit orchestrator override command ---
  for (const pattern of ORCHESTRATOR_OVERRIDE_PATTERNS) {
    if (pattern.test(text)) {
      return {
        level: 'MULTI_STAGE',
        reason: 'explicit-orchestrator-override',
        orchestratorRequired: true,
        explicitOverride: true,
      };
    }
  }

  // --- MULTI_STAGE detection ---
  for (const pattern of MULTI_STAGE_PATTERNS) {
    if (pattern.test(text)) {
      return {
        level: 'MULTI_STAGE',
        reason: `multi-stage-keyword: ${pattern.source}`,
        orchestratorRequired: true,
        explicitOverride: false,
      };
    }
  }

  // --- COMPLEX detection (many tools or complexity keywords) ---
  if (toolCount >= 3) {
    return {
      level: 'COMPLEX',
      reason: `high-tool-count: ${toolCount}`,
      orchestratorRequired: true,
      explicitOverride: false,
    };
  }
  for (const pattern of COMPLEX_PATTERNS) {
    if (pattern.test(text)) {
      return {
        level: 'COMPLEX',
        reason: `complex-keyword: ${pattern.source}`,
        orchestratorRequired: true,
        explicitOverride: false,
      };
    }
  }

  // --- TRIVIAL detection ---
  for (const pattern of TRIVIAL_PATTERNS) {
    if (pattern.test(text.trim())) {
      return {
        level: 'TRIVIAL',
        reason: `trivial-keyword: ${pattern.source}`,
        orchestratorRequired: false,
        explicitOverride: false,
      };
    }
  }

  // --- NORMAL: small coding task with ≤2 tools, no complex/multi-stage keywords ---
  return {
    level: 'NORMAL',
    reason: 'default-normal',
    orchestratorRequired: true,
    explicitOverride: false,
  };
}

/** Returns true when orchestrator mode must be used for this request. */
export function requiresOrchestrator(requestBody: unknown): boolean {
  return classifyComplexity(requestBody).orchestratorRequired;
}
