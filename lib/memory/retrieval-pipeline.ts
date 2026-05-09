/**
 * lib/memory/retrieval-pipeline.ts
 *
 * Before a model call, retrieves relevant context from the vector index.
 * Flow: user request → embed request → similarity search → top-k results → inject into context
 *
 * Features:
 *   - Freshness-weighted scoring: recently modified content gets a boost
 *   - Adaptive confidence: threshold adjusts based on query specificity
 *   - Result caching: avoids repeated embedding calls for similar queries
 */

import { embedText, cosineSimilarity } from './embedding-engine';
import { VectorIndex, type SearchResult } from './vector-index';
import { redis } from '@/lib/redis';
import * as crypto from 'crypto';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

/** Maximum number of retrieval results to inject */
const MAX_RETRIEVAL_RESULTS = 5;

/** Base similarity threshold (adaptive adjusts from here) */
const BASE_SIMILARITY_THRESHOLD = 0.3;

/** Maximum total chars to inject from retrieval */
const MAX_RETRIEVAL_CHARS = 4000;

/** Cache TTL for retrieval results (10 minutes) */
const RETRIEVAL_CACHE_TTL = 600;

/** Freshness half-life: files modified within this window get max boost (24h) */
const FRESHNESS_HALF_LIFE_MS = 24 * 60 * 60 * 1000;

/** Max freshness boost (multiplicative factor) */
const MAX_FRESHNESS_BOOST = 1.15;

export { MAX_RETRIEVAL_RESULTS, BASE_SIMILARITY_THRESHOLD as MIN_SIMILARITY_THRESHOLD };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RetrievalContext {
  /** Retrieved text snippets to inject */
  snippets: RetrievalSnippet[];
  /** Total estimated tokens for injected context */
  estimatedTokens: number;
  /** Whether retrieval was performed */
  retrieved: boolean;
}

export interface RetrievalSnippet {
  /** Source identifier */
  source: string;
  /** Source type */
  type: 'file' | 'task' | 'error' | 'decision' | 'architecture';
  /** Relevance score */
  score: number;
  /** The text snippet */
  text: string;
}

// ---------------------------------------------------------------------------
// Core retrieval
// ---------------------------------------------------------------------------

/**
 * Retrieve relevant context for a user request.
 * Uses freshness-weighted scoring and adaptive confidence gating.
 *
 * @param query - The user's request text
 * @param vectorIndex - The loaded vector index
 * @param topK - Number of results (default 5)
 */
export async function retrieveContext(
  query: string,
  vectorIndex: VectorIndex,
  topK: number = MAX_RETRIEVAL_RESULTS
): Promise<RetrievalContext> {
  if (vectorIndex.size === 0) {
    return { snippets: [], estimatedTokens: 0, retrieved: false };
  }

  try {
    // Check cache first
    const cached = await getCachedRetrieval(query);
    if (cached) return cached;

    // Embed the query
    const queryEmbedding = await embedText(query);

    // Search the vector index
    const results = vectorIndex.search(queryEmbedding.vector, topK * 2); // fetch extra for freshness re-ranking

    // Apply freshness weighting
    const freshnessRanked = applyFreshnessRanking(results);

    // Compute adaptive threshold based on query specificity
    const threshold = computeAdaptiveThreshold(query);

    // Filter by adaptive similarity threshold
    const relevant = freshnessRanked.filter((r) => r.score >= threshold);

    // If all scores below threshold, skip injection to avoid noise
    if (relevant.length === 0) {
      const result: RetrievalContext = { snippets: [], estimatedTokens: 0, retrieved: true };
      await cacheRetrieval(query, result);
      return result;
    }

    // Build snippets, respecting char limit
    const snippets: RetrievalSnippet[] = [];
    let totalChars = 0;

    for (const result of relevant.slice(0, topK)) {
      const text = result.entry.metadata.text;
      if (totalChars + text.length > MAX_RETRIEVAL_CHARS) break;

      snippets.push({
        source: result.entry.metadata.title,
        type: result.entry.metadata.type,
        score: result.score,
        text,
      });
      totalChars += text.length;
    }

    const ctx: RetrievalContext = {
      snippets,
      estimatedTokens: Math.ceil(totalChars / 4),
      retrieved: true,
    };

    await cacheRetrieval(query, ctx);
    return ctx;
  } catch (err) {
    console.warn('[RetrievalPipeline] Failed to retrieve context:', err);
    return { snippets: [], estimatedTokens: 0, retrieved: false };
  }
}

/**
 * Format retrieval results as a string for context injection.
 */
export function formatRetrievalContext(context: RetrievalContext): string {
  if (!context.retrieved || context.snippets.length === 0) {
    return '';
  }

  const lines = [
    '--- Relevant Project Context (from memory) ---',
    '',
  ];

  for (const snippet of context.snippets) {
    lines.push(`[${snippet.type}] ${snippet.source} (relevance: ${(snippet.score * 100).toFixed(0)}%)`);
    lines.push(snippet.text);
    lines.push('');
  }

  lines.push('--- End Project Context ---');
  return lines.join('\n');
}

/**
 * Extract the user's latest message text from a request body
 * for use as the retrieval query.
 */
export function extractQueryFromBody(body: any): string {
  // Anthropic format
  if (body?.messages && Array.isArray(body.messages)) {
    const lastUser = [...body.messages].reverse().find(
      (m: any) => m.role === 'user'
    );
    if (lastUser) {
      if (typeof lastUser.content === 'string') return lastUser.content;
      if (Array.isArray(lastUser.content)) {
        return lastUser.content
          .filter((p: any) => p.type === 'text')
          .map((p: any) => p.text)
          .join('\n');
      }
    }
  }

  // Gemini format
  if (body?.contents && Array.isArray(body.contents)) {
    const lastUser = [...body.contents].reverse().find(
      (c: any) => c.role === 'user'
    );
    if (lastUser?.parts) {
      return lastUser.parts
        .filter((p: any) => p.text)
        .map((p: any) => p.text)
        .join('\n');
    }
  }

  return '';
}

// ---------------------------------------------------------------------------
// Freshness ranking
// ---------------------------------------------------------------------------

/**
 * Apply freshness weighting to search results.
 * Recently embedded entries get a similarity boost.
 * Task/error summaries get slightly higher freshness weight than files.
 */
export function applyFreshnessRanking(results: SearchResult[]): SearchResult[] {
  const now = Date.now();

  return results
    .map((r) => {
      const age = now - (r.entry.metadata.embeddedAt || 0);
      // Exponential decay: boost = MAX_FRESHNESS_BOOST * exp(-age / halfLife)
      const decay = Math.exp(-age / FRESHNESS_HALF_LIFE_MS);
      let boost = 1 + (MAX_FRESHNESS_BOOST - 1) * decay;

      // Summaries (task, error, decision) get extra freshness weight
      if (r.entry.metadata.type !== 'file') {
        boost *= 1.05;
      }

      return {
        entry: r.entry,
        score: Math.min(1, r.score * boost), // Cap at 1.0
      };
    })
    .sort((a, b) => b.score - a.score);
}

// ---------------------------------------------------------------------------
// Adaptive confidence threshold
// ---------------------------------------------------------------------------

/**
 * Compute an adaptive similarity threshold based on query characteristics.
 *
 * - High-confidence queries (specific function names, file paths): higher threshold
 * - Broad queries (general questions): lower threshold
 * - Very short queries: lower threshold (less discriminative)
 */
export function computeAdaptiveThreshold(query: string): number {
  const words = query.trim().split(/\s+/).length;

  // Very short query — less discriminative embedding → lower threshold
  if (words <= 3) return 0.2;

  // Check for code-specific patterns (function names, file paths, identifiers)
  const hasCodePatterns = /[A-Z][a-z]+[A-Z]|[a-z]+\.[a-z]+\(|\/[a-z]+\/|[a-z]+_[a-z]+/i.test(query);
  if (hasCodePatterns) return 0.4; // High confidence — require strong match

  // Check for error patterns
  const hasErrorPatterns = /error|exception|fail|crash|bug|fix/i.test(query);
  if (hasErrorPatterns) return 0.35;

  // Medium-length general query
  if (words <= 10) return 0.25;

  // Long query — more context, can afford lower threshold
  return 0.3;
}

// ---------------------------------------------------------------------------
// Retrieval caching
// ---------------------------------------------------------------------------

function retrievalCacheKey(query: string): string {
  const hash = crypto.createHash('sha256').update(query.toLowerCase().trim()).digest('hex').slice(0, 16);
  return `retrieval:cache:${hash}`;
}

async function getCachedRetrieval(query: string): Promise<RetrievalContext | null> {
  try {
    const raw = await (redis as any).get(retrievalCacheKey(query));
    if (!raw) return null;
    return JSON.parse(typeof raw === 'string' ? raw : JSON.stringify(raw));
  } catch {
    return null;
  }
}

async function cacheRetrieval(query: string, result: RetrievalContext): Promise<void> {
  try {
    await (redis as any).set(retrievalCacheKey(query), JSON.stringify(result), { ex: RETRIEVAL_CACHE_TTL });
  } catch { /* best-effort */ }
}
