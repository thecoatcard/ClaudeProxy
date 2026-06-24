/**
 * lib/session/workspace-fingerprint.ts
 *
 * Workspace Fingerprinting — Phase 2 of the gateway hardening pass.
 *
 * Problem:
 *   Workspace identity relied solely on parsing Claude's system-text blocks.
 *   If the system prompt format changes or the field is missing, workspace
 *   isolation silently degrades.
 *
 * Solution:
 *   Derive a stable workspaceFingerprint from multiple sources in priority order:
 *     1. Explicit workspacePath / cwd tag in system or early messages
 *     2. Current Working Directory header
 *     3. Normalised path from any detected path-like string
 *     4. Fallback: hash of the longest detected path segment
 *
 *   The fingerprint is a short hex string, not the raw path — suitable for
 *   Redis keys and for comparison without leaking absolute paths in logs.
 *
 *   Stored in: context:workspace:{conversationId}  (6 h TTL, refreshed each request)
 *
 * Edge-runtime safe — no Node.js APIs.
 */

import { stableHash } from '../utils/hash';

// ── Path normalisation ────────────────────────────────────────────────────────

/**
 * Normalise a filesystem path to a canonical comparison form.
 *  - Backslashes → forward slashes
 *  - Trailing slashes removed
 *  - Lowercased (Windows paths are case-insensitive)
 *  - Drive letter preserved but lowercased
 */
export function normalizePath(rawPath: string): string {
  return rawPath
    .replace(/\\/g, '/')
    .replace(/\/+$/, '')
    .toLowerCase()
    .trim();
}

/**
 * Extract the workspace root from multiple potential sources in priority order.
 * Returns null when nothing reliable can be extracted.
 */
export function extractWorkspaceRoot(systemText: string, messages: any[]): string | null {
  // Source 1: <workspacePath> tag (Claude Code primary format)
  const wpTagMatch = systemText.match(/<workspacePath\s*>([^<\n]+)<\/workspacePath>/i);
  if (wpTagMatch?.[1]?.trim()) return normalizePath(wpTagMatch[1].trim());

  // Source 2: <cwd> tag
  const cwdTagMatch = systemText.match(/<cwd\s*>([^<\n]+)<\/cwd>/i);
  if (cwdTagMatch?.[1]?.trim()) return normalizePath(cwdTagMatch[1].trim());

  // Source 3: Inline patterns in system text
  const cwdLineMatch = systemText.match(/\bCwd:\s*["'`]?([^\s"'`\n<]+)/i);
  if (cwdLineMatch?.[1]?.trim()) return normalizePath(cwdLineMatch[1].trim());

  const cwdHeaderMatch = systemText.match(/Current Working Directory \(([^)\n]+)\)/i);
  if (cwdHeaderMatch?.[1]?.trim()) return normalizePath(cwdHeaderMatch[1].trim());

  const workspaceLineMatch = systemText.match(/workspace[_\s]?(?:folder|root|path)[:\s]+["'`]?([^\s"'`\n<]+)/i);
  if (workspaceLineMatch?.[1]?.trim()) return normalizePath(workspaceLineMatch[1].trim());

  // Source 4: Scan first 4 user messages (Claude Code injects environment_details here)
  const scanCount = Math.min(4, messages.length);
  for (let i = 0; i < scanCount; i++) {
    const msg = messages[i];
    if (!msg) continue;
    const text = extractMessageText(msg.content);
    if (!text) continue;

    const wpMatch = text.match(/<workspacePath\s*>([^<\n]+)<\/workspacePath>/i);
    if (wpMatch?.[1]?.trim()) return normalizePath(wpMatch[1].trim());

    const cwdTag = text.match(/<cwd\s*>([^<\n]+)<\/cwd>/i);
    if (cwdTag?.[1]?.trim()) return normalizePath(cwdTag[1].trim());

    const cwdHdr = text.match(/Current Working Directory \(([^)\n]+)\)/i);
    if (cwdHdr?.[1]?.trim()) return normalizePath(cwdHdr[1].trim());

    const wdLine = text.match(/Working Directory:\s*([\S][^\n<]*)/i);
    if (wdLine?.[1]?.trim()) return normalizePath(wdLine[1].trim());

    const cwdLine = text.match(/\bCwd:\s*["'`]?([^\s"'`\n<]+)/i);
    if (cwdLine?.[1]?.trim()) return normalizePath(cwdLine[1].trim());
  }

  return null;
}

function extractMessageText(content: any): string {
  if (!content) return '';
  if (typeof content === 'string') return content;
  if (!Array.isArray(content)) return '';
  return content
    .map((b: any) => {
      if (typeof b === 'string') return b;
      if (b?.type === 'text' && typeof b.text === 'string') return b.text;
      return '';
    })
    .join(' ');
}

// ── Fingerprint derivation ───────────────────────────────────────────────────

export interface WorkspaceFingerprint {
  /** Stable short hex fingerprint — use this for Redis keys and comparisons. */
  fingerprint: string;

  /** The normalised path that was hashed, or null if unknown. */
  normalizedPath: string | null;

  /** How confident we are in the fingerprint. */
  confidence: 'high' | 'low' | 'none';
}

const FALLBACK_FINGERPRINT = '00000000'; // used when workspace is completely unknown
const UNKNOWN_WORKSPACE = 'UNKNOWN_WORKSPACE';

/**
 * Compute a stable workspace fingerprint from the current request context.
 *
 * Confidence levels:
 *   high — explicit cwd/workspacePath found → fingerprint is reliable
 *   low  — derived from a partial path hint → may not be unique across workspaces
 *   none — no workspace signal found → fingerprint is 00000000
 */
export function computeWorkspaceFingerprint(systemText: string, messages: any[]): WorkspaceFingerprint {
  const root = extractWorkspaceRoot(systemText, messages);

  if (root) {
    return {
      fingerprint: stableHash(root),
      normalizedPath: root,
      confidence: 'high',
    };
  }

  // Fallback: try to extract any absolute path-like string from the system text
  // (not ideal but better than nothing)
  const anyPathMatch = systemText.match(/(?:^|\s)((?:\/[^\/\s<>":*?|]+)+|[A-Za-z]:\\[^\s<>":*?|]+)/m);
  if (anyPathMatch?.[1]?.trim()) {
    const normalized = normalizePath(anyPathMatch[1].trim());
    return {
      fingerprint: stableHash(normalized),
      normalizedPath: normalized,
      confidence: 'low',
    };
  }

  return {
    fingerprint: FALLBACK_FINGERPRINT,
    normalizedPath: null,
    confidence: 'none',
  };
}

/**
 * Compare two workspace fingerprints for isolation enforcement.
 *
 * Returns:
 *   'match'    — same workspace
 *   'mismatch' — different workspaces (deny hydration)
 *   'unknown'  — at least one fingerprint is unknown (see policy in Phase 3)
 */
export function compareWorkspaceFingerprints(
  a: string | null | undefined,
  b: string | null | undefined,
): 'match' | 'mismatch' | 'unknown' {
  if (!a || !b) return 'unknown';
  if (a === FALLBACK_FINGERPRINT || b === FALLBACK_FINGERPRINT) return 'unknown';
  return a === b ? 'match' : 'mismatch';
}

export { FALLBACK_FINGERPRINT, UNKNOWN_WORKSPACE };
