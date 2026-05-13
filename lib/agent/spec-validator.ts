// SpecValidator — extract numbered/bulleted requirements from task text and
// track which ones have been addressed by observed tool calls.
//
// Use case: a system prompt (or early user message) contains an explicit task
// list like "1. Write X  2. Read Y  3. Run Z". The validator extracts those
// items and checks how many correspond to successful tool invocations in the
// message history. If significant items appear unaddressed, guidance is
// injected to remind the model to complete them.
//
// Pure functions, no I/O, edge-runtime safe.

import { verifyAllToolResults, type VerificationResult } from './verification-engine';

export interface Requirement {
  index: number;
  text: string;
  addressed: boolean;
  evidence: string | null;
}

// Numbered/lettered list items: "1. ...", "a. ...", "A. ...", "- ...", "* ...", "• ..."
const LIST_ITEM_RE = /^[ \t]*(?:\d+[.)]\s+|[a-zA-Z][.)]\s+|[-*•]\s+)(.+)/m;
const LIST_ITEM_GLOBAL_RE = /^[ \t]*(?:\d+[.)]\s+|[a-zA-Z][.)]\s+|[-*•]\s+)(.+)/gm;

/** Extract requirement text items from any block of text. */
export function extractRequirements(text: string): Requirement[] {
  if (!text || typeof text !== 'string') return [];

  const matches = Array.from(text.matchAll(LIST_ITEM_GLOBAL_RE));
  return matches.map((m, i) => ({
    index: i + 1,
    text: m[1].trim(),
    addressed: false,
    evidence: null,
  }));
}

// Keywords that hint a requirement involves a specific tool category.
const TOOL_HINT_MAP: Array<{ pattern: RegExp; toolFamily: string }> = [
  // write — broad: "write X", "create X", "implement X", "build X", "add X"
  { pattern: /\b(write|create|save|generate|output|produce|implement|build|add)\b/i, toolFamily: 'write' },
  // read — narrow: needs explicit read/view action or file content context
  { pattern: /\b(read|open|load|fetch|view|display)\b.*\b(file|content|data)\b/i, toolFamily: 'read' },
  { pattern: /\b(run|execute|bash|shell|command|script|launch|start)\b/i, toolFamily: 'bash' },
  { pattern: /\b(delete|remove|unlink|clean up)\b/i, toolFamily: 'delete' },
  { pattern: /\b(move|rename|relocate)\b/i, toolFamily: 'move' },
  { pattern: /\b(search|grep|find|list|scan)\b/i, toolFamily: 'search' },
];

function getRequirementToolHint(reqText: string): string | null {
  for (const { pattern, toolFamily } of TOOL_HINT_MAP) {
    if (pattern.test(reqText)) return toolFamily;
  }
  return null;
}

function normalizeTool(toolName: string): string {
  const t = toolName.toLowerCase();
  if (/write|str_replace|edit|create_file|apply_patch/.test(t)) return 'write';
  if (/read|cat|view/.test(t)) return 'read';
  if (/bash|shell|exec|run|terminal/.test(t)) return 'bash';
  if (/delete|remove|unlink/.test(t)) return 'delete';
  if (/move|rename/.test(t)) return 'move';
  if (/search|grep|glob|find|list/.test(t)) return 'search';
  return 'generic';
}

/**
 * Mark requirements as addressed based on successful tool invocations in the
 * message history. A requirement is considered addressed when:
 *   a. A tool of the matching family was called AND its result was not a failure, OR
 *   b. Any text in an assistant turn directly references key words from the requirement.
 */
export function trackRequirements(
  requirements: Requirement[], 
  messages: any[],
  preCalculatedResults?: VerificationResult[]
): Requirement[] {
  if (requirements.length === 0) return [];

  // Collect successful tool verdicts from history.
  const toolResults = preCalculatedResults ?? verifyAllToolResults(messages);
  const successfulFamilies = new Set<string>();
  const allFamilies = new Set<string>();
  for (const result of toolResults) {
    const family = normalizeTool(result.toolName);
    allFamilies.add(family);
    if (result.verdict === 'success') {
      successfulFamilies.add(family);
    }
  }

  // Collect all assistant text for keyword matching.
  // Collect assistant text AND tool_use input values for keyword matching.
  // Collect all assistant text blocks for keyword matching. Tool_use inputs are
  // intentionally excluded — they could cause a failed call to appear addressed.
  const assistantText = (messages || [])
    .filter((m: any) => m.role === 'assistant')
    .map((m: any) => {
      if (typeof m.content === 'string') return m.content;
      if (!Array.isArray(m.content)) return '';
      return m.content
        .map((b: any) => (b?.type === 'text' ? b.text : ''))
        .join(' ');
    })
    .join(' ')
    .toLowerCase();

  return requirements.map(req => {
    const hint = getRequirementToolHint(req.text);
    const reqWords = req.text.toLowerCase().split(/\s+/).filter(w => w.length > 4);

    // Check 1: matching tool family had a successful call.
    if (hint && successfulFamilies.has(hint)) {
      return { ...req, addressed: true, evidence: `Successful ${hint} tool call found in history.` };
    }

    // Check 2: assistant text mentions key words from this requirement.
    const keywordHits = reqWords.filter(w => assistantText.includes(w));
    if (keywordHits.length >= Math.max(1, Math.floor(reqWords.length * 0.4))) {
      return { ...req, addressed: true, evidence: `Assistant text references: [${keywordHits.join(', ')}].` };
    }

    return { ...req, addressed: false, evidence: null };
  });
}

/** Build guidance text for unaddressed requirements. Returns '' if all addressed. */
export function buildSpecGuidance(requirements: Requirement[]): string {
  const unaddressed = requirements.filter(r => !r.addressed);
  if (unaddressed.length === 0) return '';

  const lines = [
    '---',
    `[SPEC] ${unaddressed.length}/${requirements.length} requirement(s) unaddressed: ${unaddressed.map(r => `${r.index}.${r.text.slice(0, 60)}`).join(' | ')}`,
    'Complete missing items before claiming done.',
    '---',
  ];

  return lines.join('\n');
}

/** Combined entry point: extract from a text source and immediately track. */
export function validateSpec(
  sourceText: string, 
  messages: any[],
  preCalculatedResults?: VerificationResult[]
): {
  requirements: Requirement[];
  guidance: string;
} {
  const requirements = extractRequirements(sourceText);
  if (requirements.length === 0) return { requirements: [], guidance: '' };

  const tracked = trackRequirements(requirements, messages, preCalculatedResults);
  const guidance = buildSpecGuidance(tracked);
  return { requirements: tracked, guidance };
}
