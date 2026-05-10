/**
 * lib/context/hydration-guard.ts
 *
 * Multi-gate safety layer that governs whether compacted memory, rolling
 * summaries, or operational state are injected into the current request.
 *
 * CORE RULE: compacted memory MUST NOT be injected unless continuity is proven.
 *
 * Required gates (all must pass):
 *   1. No /clear reset detected in recent messages
 *   2. Workspace root matches stored workspace root (if both known)
 *   3. Session is not trivially fresh (single trivial greeting)
 *   4. Semantic continuity — current request continues prior task
 *
 * Fail ANY gate → do not hydrate.
 *
 * Edge-runtime safe — no Node.js APIs, no filesystem access.
 */

// ─── Public types ─────────────────────────────────────────────────────────────

export type HydrationSkipReason =
  | 'HYDRATION_SKIPPED_CLEAR_RESET'
  | 'HYDRATION_SKIPPED_WORKSPACE_MISMATCH'
  | 'HYDRATION_SKIPPED_SESSION_MISMATCH'
  | 'HYDRATION_SKIPPED_LOW_CONTINUITY'
  | 'HYDRATION_SKIPPED_FRESH_SESSION';

export type HydrationApprovedReason = 'HYDRATION_APPROVED';

export type HydrationVerdict =
  | { allow: true;  reason: HydrationApprovedReason }
  | { allow: false; reason: HydrationSkipReason };

export interface HydrationContext {
  /** All messages in the current request, in order. */
  messages: any[];

  /** Derived conversation ID for the current request. */
  conversationId: string;

  /**
   * Workspace root detected from the current system prompt / messages.
   * Null when unknown (not yet detected).
   */
  currentWorkspaceRoot?: string | null;

  /**
   * Workspace root stored in the previously persisted operational state.
   * Null when the stored state has no workspace_root.
   */
  storedWorkspaceRoot?: string | null;

  /**
   * True when the client explicitly provided a conversation_id / session_id
   * in request metadata. False when the ID was derived from a content hash.
   *
   * Hash-derived IDs can collide across sessions in the same workspace, so
   * single-message requests without an explicit ID are treated as fresh
   * sessions and denied hydration.
   */
  hasExplicitConversationId?: boolean;
}

// ─── Trivial-greeting detection ───────────────────────────────────────────────

/** Tokens that, alone, indicate a brand-new unrelated session opening. */
const TRIVIAL_GREETINGS = new Set([
  'hi', 'hello', 'hey', 'yo', 'sup', 'greetings', 'howdy', "what's up",
  'whats up', 'good morning', 'good afternoon', 'good evening',
  'ping', 'test', 'testing', '...',
]);

/** Tokens that explicitly request continuation of the prior task. */
const CONTINUATION_SIGNALS = [
  /\bcontinue\b/i,
  /\bresume\b/i,
  /\bpick\s+up\b/i,
  /\bfinish\s+(previous|prior|last|the)\b/i,
  /\bwhere\s+we\s+left\s+off\b/i,
  /\bprevious\s+task\b/i,
  /\bgo\s+on\b/i,
  /\bkeep\s+going\b/i,
  /\bnext\s+step\b/i,
];

function extractTextFromContent(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => {
      if (typeof b === 'string') return b;
      if (b?.type === 'text' && typeof b.text === 'string') return b.text;
      return '';
    })
    .join(' ')
    .trim();
}

function isTrivialGreeting(text: string): boolean {
  const normalized = text.toLowerCase().replace(/[!?.,"']/g, '').trim();
  if (!normalized) return true;
  if (TRIVIAL_GREETINGS.has(normalized)) return true;
  // Short single-word / two-word messages are treated as trivial unless
  // they contain a continuation signal.
  if (normalized.split(/\s+/).length <= 2 && !CONTINUATION_SIGNALS.some(re => re.test(normalized))) {
    return true;
  }
  return false;
}

function hasContinuationSignal(text: string): boolean {
  return CONTINUATION_SIGNALS.some(re => re.test(text));
}

// ─── /clear detection ─────────────────────────────────────────────────────────

const CLEAR_PATTERNS = [
  /^\/clear\s*$/im,
  /^\/reset\s*$/im,
  /^clear\s+context\s*$/im,
  /^reset\s+session\s*$/im,
];

const CLEAR_SCAN_WINDOW = 10; // only scan the most recent N messages

function detectClearReset(messages: any[]): boolean {
  const window = messages.slice(-CLEAR_SCAN_WINDOW);
  for (const msg of window) {
    const text = extractTextFromContent(msg?.content);
    if (CLEAR_PATTERNS.some(re => re.test(text))) return true;
  }
  return false;
}

// ─── Workspace root extraction ────────────────────────────────────────────────

/**
 * Extract workspace root from a system prompt text.
 * Claude Code injects <environment_details> with workspacePath or cwd.
 */
export function extractWorkspaceRootFromSystem(systemText: string): string | null {
  if (!systemText) return null;

  // Claude Code: <environment_details><workspacePath>/some/path</workspacePath>
  const workspacePathMatch = systemText.match(/<workspacePath\s*>([^<]+)<\/workspacePath>/i);
  if (workspacePathMatch?.[1]?.trim()) return workspacePathMatch[1].trim();

  // Explicit Cwd: field from tool results embedded in system
  const cwdMatch = systemText.match(/Cwd:\s*["'`]?([^\s"'`\n<]+)/i);
  if (cwdMatch?.[1]?.trim()) return cwdMatch[1].trim();

  // VS Code workspace folder pattern
  const vscodeMatch = systemText.match(/workspace[_\s]?(?:folder|root|path)[:\s]+["'`]?([^\s"'`\n<]+)/i);
  if (vscodeMatch?.[1]?.trim()) return vscodeMatch[1].trim();

  // # Current Working Directory (/path/to/dir) Files
  const cwdHeaderMatch = systemText.match(/Current Working Directory \(([^)\n]+)\)/i);
  if (cwdHeaderMatch?.[1]?.trim()) return cwdHeaderMatch[1].trim();

  return null;
}

/**
 * Extract workspace root from early user messages.
 *
 * Claude Code always injects an <environment_details> block into user messages
 * (not the system prompt). This is the primary workspace signal in real sessions.
 *
 * Scans only the first 4 messages to avoid false positives from mid-session
 * messages that may reference other directories.
 */
export function extractWorkspaceRootFromMessages(messages: any[]): string | null {
  const scanCount = Math.min(4, messages.length);
  for (let i = 0; i < scanCount; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const text = extractTextFromContent(msg.content);
    if (!text) continue;

    // <workspacePath>/path</workspacePath>  (Claude Code primary format)
    const wpMatch = text.match(/<workspacePath\s*>([^<\n]+)<\/workspacePath>/i);
    if (wpMatch?.[1]?.trim()) return wpMatch[1].trim();

    // <cwd>/path</cwd>
    const cwdTagMatch = text.match(/<cwd\s*>([^<\n]+)<\/cwd>/i);
    if (cwdTagMatch?.[1]?.trim()) return cwdTagMatch[1].trim();

    // # Current Working Directory (/path/to/dir) Files
    const cwdHeaderMatch = text.match(/Current Working Directory \(([^)\n]+)\)/i);
    if (cwdHeaderMatch?.[1]?.trim()) return cwdHeaderMatch[1].trim();

    // Working Directory: /path  (some Claude Code variants)
    const wdMatch = text.match(/Working Directory:\s*([\S][^\n<]*)/i);
    if (wdMatch?.[1]?.trim()) return wdMatch[1].trim();

    // Cwd: /path  (tool-result style)
    const cwdLineMatch = text.match(/\bCwd:\s*["'`]?([^\s"'`\n<]+)/i);
    if (cwdLineMatch?.[1]?.trim()) return cwdLineMatch[1].trim();
  }
  return null;
}

// ─── Workspace boundary check ─────────────────────────────────────────────────

/**
 * Normalise a workspace root path for comparison: lowercase on Windows,
 * strip trailing slashes, and normalise back-slashes to forward slashes.
 */
function normalizeRoot(root: string): string {
  return root
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase();
}

function workspacesMatch(
  current: string | null | undefined,
  stored: string | null | undefined,
): boolean {
  // Both unknown → cannot assert a mismatch → pass
  if (!current && !stored) return true;

  // One unknown → cannot assert a mismatch → pass (safe default).
  // The workspace will be stored on the next successful request via the
  // companion Redis key, enabling stricter checks from the second request on.
  if (!current || !stored) return true;

  // Both known → require EXACT match (strict path-aware isolation per spec).
  // TrainAi ≠ TrainAi/library even though one is a subdirectory of the other.
  return normalizeRoot(current) === normalizeRoot(stored);
}

// ─── Semantic continuity assessment ──────────────────────────────────────────

/**
 * Assess whether the current request semantically continues a prior session.
 *
 * Uses cheap heuristics — no LLM call needed.
 *
 * NOTE: We deliberately do NOT short-circuit on messages.length > 3.
 * Claude Code restores its full local conversation history across terminal
 * restarts, so a "new" session can arrive with 20+ old messages. The
 * workspace boundary gate is the correct place to catch cross-workspace
 * leakage; the continuity check here focuses on whether the LATEST user
 * message is a meaningful continuation.
 *
 * Returns true → likely continuation, false → likely new/unrelated session.
 */
function assessSemanticContinuity(messages: any[], hasExplicitConversationId: boolean): boolean {
  // Find the latest user message.
  const latestUserMsg = [...messages].reverse().find(m => m?.role === 'user');
  if (!latestUserMsg) return false;

  const text = extractTextFromContent(latestUserMsg.content);

  // Strip out <environment_details> injected by Claude Code — it's not user intent.
  const cleanText = text.replace(/<environment_details[\s\S]*?<\/environment_details>/gi, '').trim();

  // Explicit continuation signal → always allow regardless of session depth.
  if (hasContinuationSignal(cleanText)) return true;

  // For established sessions (>1 message), any reply is a valid continuation.
  // The workspace gate has already ensured we're in the correct workspace.
  // A short reply like "yes please" or "ok" in an active session is fine.
  if (messages.length > 1) return true;

  // ── Fresh single-message session guard ───────────────────────────────────
  // When no explicit conversation_id was provided, the gateway derives the ID
  // from a hash of the system prompt + first user message. This hash can
  // collide with a previous session in the same workspace, causing old context
  // to leak into a genuinely new conversation.
  //
  // A single-message request with no explicit ID and no continuation signal is
  // definitively a fresh start. Block hydration even if the message content
  // looks substantive (e.g. "analyse this codebase").
  if (!hasExplicitConversationId) return false;

  // Single-message session with an explicit ID: apply the trivial greeting check.
  // "hi" / "hello" / "hey" alone → deny; anything else → allow.
  return !isTrivialGreeting(cleanText);
}

// ─── Main decision function ───────────────────────────────────────────────────

/**
 * Evaluate all gates and return a hydration verdict.
 *
 * Call this BEFORE injecting any stored context (rolling summary, operational
 * state, or emergency compaction state) from Redis.
 */
export function evaluateHydration(ctx: HydrationContext): HydrationVerdict {
  const { messages, currentWorkspaceRoot, storedWorkspaceRoot } = ctx;

  // Gate 1: /clear detection
  if (detectClearReset(messages)) {
    return { allow: false, reason: 'HYDRATION_SKIPPED_CLEAR_RESET' };
  }

  // Gate 2: Workspace boundary
  if (!workspacesMatch(currentWorkspaceRoot, storedWorkspaceRoot)) {
    return { allow: false, reason: 'HYDRATION_SKIPPED_WORKSPACE_MISMATCH' };
  }

  // Gate 3: Semantic continuity (checks latest user message regardless of history length).
  // For single-message sessions with no explicit conversation ID (hash-derived),
  // this gate also blocks hydration to prevent stale-context leakage.
  const isExplicit = ctx.hasExplicitConversationId ?? false;
  if (!assessSemanticContinuity(messages, isExplicit)) {
    const reason = (!isExplicit && messages.length === 1)
      ? 'HYDRATION_SKIPPED_FRESH_SESSION'
      : 'HYDRATION_SKIPPED_LOW_CONTINUITY';
    return { allow: false, reason };
  }

  return { allow: true, reason: 'HYDRATION_APPROVED' };
}

/**
 * Returns true if the current message history contains an existing compacted
 * marker sentinel. When it does, the session is definitively established and
 * all continuity gates are implicitly passed — only the workspace and /clear
 * gates still apply.
 */
export function messagesContainCompactedMarker(messages: any[]): boolean {
  const SENTINELS = ['<!-- compacted:v2 -->', '<!-- compacted:v1 -->'];
  for (const msg of messages) {
    const text = typeof msg?.content === 'string'
      ? msg.content
      : extractTextFromContent(msg?.content);
    if (SENTINELS.some(s => text.includes(s))) return true;
  }
  return false;
}

/**
 * Evaluate hydration for a session that has established compacted markers.
 * Only workspace boundary and /clear gates apply — continuity is proven
 * by the markers themselves.
 */
export function evaluateHydrationForEstablishedSession(ctx: HydrationContext): HydrationVerdict {
  const { messages, currentWorkspaceRoot, storedWorkspaceRoot } = ctx;

  if (detectClearReset(messages)) {
    return { allow: false, reason: 'HYDRATION_SKIPPED_CLEAR_RESET' };
  }
  if (!workspacesMatch(currentWorkspaceRoot, storedWorkspaceRoot)) {
    return { allow: false, reason: 'HYDRATION_SKIPPED_WORKSPACE_MISMATCH' };
  }
  return { allow: true, reason: 'HYDRATION_APPROVED' };
}
