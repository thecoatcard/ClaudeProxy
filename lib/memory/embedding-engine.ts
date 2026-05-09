/**
 * lib/memory/embedding-engine.ts
 *
 * Embedding engine using Google text-embedding-004 model.
 * Generates vector embeddings for text, files, and summaries.
 * Does NOT use generation models — only the embedding API.
 */

import { getHealthiestKeyObj } from '@/lib/key-manager';

// ---------------------------------------------------------------------------
// Configuration
// ---------------------------------------------------------------------------

const EMBEDDING_MODEL = 'text-embedding-004';
const EMBEDDING_DIMENSION = 768; // text-embedding-004 default
const MAX_BATCH_SIZE = 100; // Google API batch limit
const MAX_CHARS_PER_TEXT = 30_000; // ~7500 tokens safe limit
/** Max retries on transient embedding failures (429, 500, 503) */
const MAX_EMBED_RETRIES = 2;
/** Base backoff in ms between retries */
const EMBED_RETRY_BASE_MS = 400;

export { EMBEDDING_DIMENSION };

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EmbeddingResult {
  /** The original text (truncated if too long) */
  text: string;
  /** The embedding vector */
  vector: number[];
  /** Dimension of the vector */
  dimension: number;
  /** Model used */
  model: string;
}

export interface BatchEmbeddingResult {
  embeddings: EmbeddingResult[];
  totalTokens: number;
  model: string;
}

// ---------------------------------------------------------------------------
// Core API
// ---------------------------------------------------------------------------

/**
 * Embed a single text string using text-embedding-004.
 * Retries up to MAX_EMBED_RETRIES times on transient failures.
 */
export async function embedText(text: string): Promise<EmbeddingResult> {
  const truncated = text.length > MAX_CHARS_PER_TEXT
    ? text.slice(0, MAX_CHARS_PER_TEXT)
    : text;

  const keyObj = await getHealthiestKeyObj();
  if (!keyObj) {
    throw new Error('No API key available for embedding');
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:embedContent?key=${keyObj.key}`;

  let lastError: Error | null = null;
  for (let attempt = 0; attempt <= MAX_EMBED_RETRIES; attempt++) {
    if (attempt > 0) {
      await new Promise((r) => setTimeout(r, EMBED_RETRY_BASE_MS * attempt));
    }
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text: truncated }] },
        }),
      });

      if (!response.ok) {
        const errorText = await response.text().catch(() => 'unknown');
        // Retry on rate-limit or server error
        if ((response.status === 429 || response.status >= 500) && attempt < MAX_EMBED_RETRIES) {
          lastError = new Error(`Embedding API error ${response.status}: ${errorText}`);
          continue;
        }
        throw new Error(`Embedding API error ${response.status}: ${errorText}`);
      }

      const data = await response.json();
      const vector: number[] = data?.embedding?.values ?? [];
      return {
        text: truncated,
        vector,
        dimension: vector.length,
        model: EMBEDDING_MODEL,
      };
    } catch (err) {
      if (err instanceof Error && err.message.startsWith('Embedding API error')) throw err;
      lastError = err instanceof Error ? err : new Error(String(err));
    }
  }
  throw lastError ?? new Error('Embedding failed after retries');
}

/**
 * Embed multiple texts in a single batch request.
 */
export async function embedBatch(texts: string[]): Promise<BatchEmbeddingResult> {
  if (texts.length === 0) {
    return { embeddings: [], totalTokens: 0, model: EMBEDDING_MODEL };
  }

  const keyObj = await getHealthiestKeyObj();
  if (!keyObj) {
    throw new Error('No API key available for embedding');
  }

  // Split into chunks of MAX_BATCH_SIZE
  const chunks: string[][] = [];
  for (let i = 0; i < texts.length; i += MAX_BATCH_SIZE) {
    chunks.push(texts.slice(i, i + MAX_BATCH_SIZE));
  }

  const allEmbeddings: EmbeddingResult[] = [];
  let totalTokens = 0;

  for (const chunk of chunks) {
    const truncatedChunk = chunk.map((t) =>
      t.length > MAX_CHARS_PER_TEXT ? t.slice(0, MAX_CHARS_PER_TEXT) : t
    );

    const url = `https://generativelanguage.googleapis.com/v1beta/models/${EMBEDDING_MODEL}:batchEmbedContents?key=${keyObj.key}`;
    const response = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        requests: truncatedChunk.map((text) => ({
          model: `models/${EMBEDDING_MODEL}`,
          content: { parts: [{ text }] },
        })),
      }),
    });

    if (!response.ok) {
      const errorText = await response.text().catch(() => 'unknown');
      throw new Error(`Batch embedding API error ${response.status}: ${errorText}`);
    }

    const data = await response.json();
    const embeddings = data?.embeddings ?? [];

    for (let i = 0; i < embeddings.length; i++) {
      const vector: number[] = embeddings[i]?.values ?? [];
      allEmbeddings.push({
        text: truncatedChunk[i],
        vector,
        dimension: vector.length,
        model: EMBEDDING_MODEL,
      });
    }

    // Estimate token count from char length
    totalTokens += truncatedChunk.reduce((sum, t) => sum + Math.ceil(t.length / 4), 0);
  }

  return {
    embeddings: allEmbeddings,
    totalTokens,
    model: EMBEDDING_MODEL,
  };
}

/**
 * Embed a source file with metadata prefix for better retrieval.
 */
export async function embedFile(
  filePath: string,
  content: string
): Promise<EmbeddingResult> {
  const prefix = `File: ${filePath}\n---\n`;
  return embedText(prefix + content);
}

/**
 * Embed a summary (task summary, error summary, etc.) with metadata.
 */
export async function embedSummary(
  type: 'task' | 'error' | 'decision' | 'architecture',
  title: string,
  content: string
): Promise<EmbeddingResult> {
  const prefix = `[${type.toUpperCase()}] ${title}\n---\n`;
  return embedText(prefix + content);
}

// ---------------------------------------------------------------------------
// Utility: cosine similarity
// ---------------------------------------------------------------------------

/**
 * Compute cosine similarity between two vectors.
 * Returns a value between -1 and 1 (1 = identical).
 */
export function cosineSimilarity(a: number[], b: number[]): number {
  if (a.length !== b.length || a.length === 0) return 0;

  let dotProduct = 0;
  let normA = 0;
  let normB = 0;

  for (let i = 0; i < a.length; i++) {
    dotProduct += a[i] * b[i];
    normA += a[i] * a[i];
    normB += b[i] * b[i];
  }

  const denominator = Math.sqrt(normA) * Math.sqrt(normB);
  if (denominator === 0) return 0;

  return dotProduct / denominator;
}
