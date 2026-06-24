/**
 * lib/agent/intent-detector.ts
 *
 * Detects user intent from the latest user message ONLY (ignoring system prompt).
 * Used as a fast pre-check before complexity classification.
 *
 * Intent types:
 *   TRIVIAL_CHAT — greetings, acknowledgments, single-word responses
 *   QUESTION     — information-seeking, no code changes expected
 *   TASK         — actual work request (code, build, fix, etc.)
 */

export type UserIntent = 'TRIVIAL_CHAT' | 'QUESTION' | 'TASK';

export interface IntentResult {
  intent: UserIntent;
  reason: string;
}

// ---------------------------------------------------------------------------
// Patterns
// ---------------------------------------------------------------------------

/** Greetings, acknowledgments, and single-word responses. */
const TRIVIAL_CHAT_PATTERNS = [
  /^(hi|hello|hey|yo|sup|hola|howdy)[\s!.?]*$/i,
  /^(thanks|thank\s+you|thx|ty|cheers)[\s!.?]*$/i,
  /^(ok|okay|k|cool|nice|great|good|awesome|perfect|sure|yep|yup|yeah|yes|no|nope|nah)[\s!.?]*$/i,
  /^(bye|goodbye|see\s+ya|later|cya)[\s!.?]*$/i,
  /^(lol|haha|lmao|hmm|hm|ah|oh|wow)[\s!.?]*$/i,
  /^(what'?s?\s+up|how\s+are\s+you|how'?s?\s+it\s+going)[\s!.?]*$/i,
  /^[\s!.?]*$/,  // empty or whitespace-only
];

/** Questions that don't require code changes. */
const QUESTION_PATTERNS = [
  /^(what|who|where|when|why|how|which|can\s+you|could\s+you|do\s+you|is\s+it|are\s+there)\s/i,
  /^(explain|describe|tell\s+me|what\s+is|what\s+are|what\s+does)\s/i,
  /\?$/,
];

/** Continuation commands are trivial only in isolation. In an established
 * coding/tool session they mean "resume the task". */
const CONTINUATION_PATTERNS = [
  /^(continue|resume|proceed|carry\s+on|keep\s+going|go\s+on|next)[\s!.?]*$/i,
  /^(continue|resume|pick\s+up|carry\s+on)\s+(from\s+)?(where\s+we\s+left\s+off|the\s+task|working)[\s!.?]*$/i,
];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Extract ONLY the latest user message text (no system prompt).
 */
export function extractUserMessage(requestBody: unknown): string {
  if (!requestBody || typeof requestBody !== 'object') return '';
  const body = requestBody as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? body.messages : [];

  for (let i = messages.length - 1; i >= 0; i--) {
    const m = messages[i] as Record<string, unknown>;
    if (m?.role !== 'user') continue;
    const content = m?.content;
    if (typeof content === 'string') return content.trim();
    if (Array.isArray(content)) {
      return (content as Array<Record<string, unknown>>)
        .map((b) => (typeof b?.text === 'string' ? b.text : ''))
        .join(' ')
        .trim();
    }
  }

  return '';
}

function hasActiveAgentContext(requestBody: unknown): boolean {
  if (!requestBody || typeof requestBody !== 'object') return false;
  const body = requestBody as Record<string, unknown>;
  const messages = Array.isArray(body.messages) ? body.messages : [];
  const tools = Array.isArray(body.tools) ? body.tools : [];

  if (tools.length > 0 && messages.length > 1) return true;

  return messages.some((m) => {
    if (!m || typeof m !== 'object') return false;
    const content = (m as Record<string, unknown>).content;
    if (!Array.isArray(content)) return false;
    return (content as Array<Record<string, unknown>>).some((block) =>
      block?.type === 'tool_use' || block?.type === 'tool_result'
    );
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Detect user intent from the latest user message.
 * This runs BEFORE complexity classification to catch trivial chat early.
 */
export function detectIntent(requestBody: unknown): IntentResult {
  const text = extractUserMessage(requestBody);

  // Empty message → trivial
  if (!text) {
    return { intent: 'TRIVIAL_CHAT', reason: 'empty-message' };
  }

  if (
    hasActiveAgentContext(requestBody) &&
    CONTINUATION_PATTERNS.some((pattern) => pattern.test(text))
  ) {
    return { intent: 'TASK', reason: 'active-session-continuation' };
  }

  // Check trivial chat patterns (exact match on user message only)
  for (const pattern of TRIVIAL_CHAT_PATTERNS) {
    if (pattern.test(text)) {
      return { intent: 'TRIVIAL_CHAT', reason: `trivial-chat: ${text.slice(0, 20)}` };
    }
  }

  // Very short messages (1 word, no code-like content) → trivial chat
  const wordCount = text.split(/\s+/).length;
  if (wordCount === 1 && !/[{}()[\]<>=;:\/\\|`~@#$%^&*]/.test(text)) {
    return { intent: 'TRIVIAL_CHAT', reason: `short-message: ${wordCount} words` };
  }

  // Question patterns
  for (const pattern of QUESTION_PATTERNS) {
    if (pattern.test(text)) {
      return { intent: 'QUESTION', reason: 'question-pattern' };
    }
  }

  // Default: actual task
  return { intent: 'TASK', reason: 'default-task' };
}

/**
 * Returns true if this request should bypass the orchestrator entirely.
 */
export function shouldSkipOrchestrator(requestBody: unknown): boolean {
  const { intent } = detectIntent(requestBody);
  return intent === 'TRIVIAL_CHAT' || intent === 'QUESTION';
}
