/**
 * Redis-Backed Tool Output Archive
 *
 * Problem: Claude Code tools like Read, Bash, Grep return huge outputs.
 * A 200KB file read fills the entire context window in 1-2 turns, making
 * long coding sessions impossible without compaction.
 *
 * Solution: For older tool results (not the most recent N), swap the full
 * content for a compact reference tag and store the bytes in Redis.
 *   - The model still knows the output existed and what tool ran.
 *   - If the model needs the file again it will simply call Read again.
 *   - The reference tag is ~80 chars vs potentially 200,000 chars.
 *   - TTL = 30 min (refreshed on every request), covering active sessions.
 *
 * Token savings estimate:
 *   - 5 large Read results @ 50KB each in history → ~65k tokens saved
 *   - Compaction threshold becomes much harder to hit for file-heavy sessions.
 */

import { redis } from './redis';

// ── Configuration ─────────────────────────────────────────────────────────────
// Minimum chars to trigger archiving. Below this, inline is cheaper than Redis.
export const ARCHIVE_THRESHOLD_CHARS = Number(process.env.TOOL_ARCHIVE_THRESHOLD || 8000);

// How many of the most recent large results to keep in full (never archive).
// Keep 3 so the model always has 3 turns of live context.
export const ARCHIVE_KEEP_RECENT = Number(process.env.TOOL_ARCHIVE_KEEP_RECENT || 3);

// Redis TTL for archived outputs (seconds).
// 90 min (5400 s) covers the full 45-min maxDuration agentic sessions with headroom.
const ARCHIVE_TTL_SECONDS = Number(process.env.TOOL_ARCHIVE_TTL || 5400);

// ── Hash ──────────────────────────────────────────────────────────────────────
/**
 * FNV-1a variant hash — fast, non-crypto, deterministic.
 * Used for deduplication: same file read twice → same hash → one Redis entry.
 * Only hashes the first 20k chars + total length to stay O(1) for huge files.
 */
function quickHash(text: string): string {
  let h = 2166136261;
  const limit = Math.min(text.length, 20000);
  for (let i = 0; i < limit; i++) {
    h ^= text.charCodeAt(i);
    h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  }
  // Fold in total length to reduce collisions between files with identical starts.
  h ^= text.length;
  h = (h + (h << 1) + (h << 4) + (h << 7) + (h << 8) + (h << 24)) >>> 0;
  return h.toString(36);
}

function redisKey(sessionKey: string, hash: string): string {
  return `tool_archive:${sessionKey}:${hash}`;
}

// ── Public API ────────────────────────────────────────────────────────────────

/**
 * Store `content` in Redis and return a compact reference string.
 *
 * The reference is what gets embedded in the conversation history instead of
 * the full content. It tells the model:
 *   1. Which tool produced the output.
 *   2. How large it was (so it can estimate effort).
 *   3. That it can re-run the tool if it needs the data again.
 *
 * Returns null on any Redis failure — caller should fall back to truncation.
 */
export async function archiveToolOutput(
  sessionKey: string,
  toolName: string,
  content: string
): Promise<string | null> {
  try {
    const hash = quickHash(content);
    const key  = redisKey(sessionKey, hash);
    const kb   = Math.round(content.length / 1024);
    const lines = content.split('\n').length;

    // Always refresh TTL — if the same file appears multiple times in history
    // we get deduplication for free (same hash → single Redis entry).
    await redis.set(key, content, { ex: ARCHIVE_TTL_SECONDS });

    // Build a human-readable reference the model can understand.
    const sizeLabel = (toolName === 'Read' || toolName === 'Write')
      ? `${lines} lines, ${kb}KB`
      : `${kb}KB`;

    return (
      `[GATEWAY ARCHIVE: ${toolName} output (${sizeLabel}) — stored in session cache ` +
      `for ${Math.round(ARCHIVE_TTL_SECONDS / 60)} min. ` +
      `Call ${toolName} again if you need the content. ref:${hash}]`
    );
  } catch {
    return null;
  }
}

/**
 * Retrieve a previously archived tool output by its hash.
 * Refreshes the TTL so actively accessed archives don't expire mid-session.
 * Returns null if expired or Redis unavailable.
 */
export async function retrieveArchivedOutput(
  sessionKey: string,
  hash: string
): Promise<string | null> {
  try {
    const key     = redisKey(sessionKey, hash);
    const content = await redis.get<string>(key);
    if (content) {
      // Refresh TTL — the session is still active.
      redis.expire(key, ARCHIVE_TTL_SECONDS).catch(() => {});
      return content;
    }
    return null;
  } catch {
    return null;
  }
}

/**
 * Phase 6 — Tool Archive Miss Recovery.
 *
 * When a GATEWAY ARCHIVE reference tag is found in conversation history but
 * the corresponding Redis entry has expired (TTL elapsed), this function
 * returns a safe placeholder string instead of propagating a broken reference.
 *
 * The placeholder informs the model that the content is no longer available
 * and prompts it to re-run the tool rather than hallucinating the missing data.
 *
 * @param toolName   Original tool name embedded in the reference tag.
 * @param hash       Archive hash from the ref: field.
 * @returns          Human-readable placeholder message.
 */
export function buildArchiveMissPlaceholder(toolName: string, hash: string): string {
  return (
    `[GATEWAY ARCHIVE EXPIRED: ${toolName} output (ref:${hash}) is no longer in cache. ` +
    `Re-run ${toolName} to retrieve the content again.]`
  );
}

/**
 * Phase 6 — Attempt to recover a reference tag from Redis or return a safe placeholder.
 *
 * Call this whenever a GATEWAY ARCHIVE reference is encountered in history
 * but the content cannot be found in Redis (cache miss). Prevents the model
 * from seeing a raw reference token with no explanation.
 *
 * @param sessionKey   Redis session key (same as used in archiveToolOutput).
 * @param toolName     Tool name from the reference tag.
 * @param hash         Archive hash from the ref: field.
 * @returns            Recovered content string, or a descriptive placeholder.
 */
export async function recoverArchivedOutput(
  sessionKey: string,
  toolName: string,
  hash: string,
): Promise<string> {
  const content = await retrieveArchivedOutput(sessionKey, hash);
  if (content) return content;
  return buildArchiveMissPlaceholder(toolName, hash);
}

/**
 * Count how many large tool results are in a message list.
 * Used by the main loop to decide which ones to archive.
 * Called AFTER compaction so we only count live messages.
 */
export function countLargeToolResults(messages: any[]): number {
  let count = 0;
  for (const msg of messages) {
    if (msg.role !== 'user' || !Array.isArray(msg.content)) continue;
    for (const block of msg.content) {
      if (block.type !== 'tool_result') continue;
      const size = rawResultSize(block.content);
      if (size > ARCHIVE_THRESHOLD_CHARS) count++;
    }
  }
  return count;
}

/**
 * Estimate the raw character count of a tool_result content field
 * without fully extracting the text (fast path for the pre-scan).
 */
function rawResultSize(content: any): number {
  if (!content) return 0;
  if (typeof content === 'string') return content.length;
  if (!Array.isArray(content)) return JSON.stringify(content).length;
  return content.reduce((sum: number, c: any) => {
    if (c.type === 'text') return sum + (c.text?.length || 0);
    if (c.type === 'image') return sum + 6; // '[image]'
    return sum + JSON.stringify(c).length;
  }, 0);
}
