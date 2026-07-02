import { createHash } from 'node:crypto';
import { getMongoDb } from '@/lib/mongodb';
import { getHealthiestKeyObj } from '@/lib/key-manager';

export interface EmbeddingClient {
  embed(texts: string[]): Promise<number[][]>;
}

export interface VectorRecord {
  scope: string;
  key: string;
  text: string;
  vector: number[];
  metadata?: Record<string, unknown>;
  updatedAt: number;
}

export interface VectorStore {
  upsert(records: VectorRecord[]): Promise<void>;
  query(scope: string, vector: number[], limit: number): Promise<VectorRecord[]>;
}

function normalize(vector: number[]) {
  const magnitude = Math.sqrt(vector.reduce((sum, value) => sum + (value * value), 0)) || 1;
  return vector.map((value) => value / magnitude);
}

function cosineSimilarity(left: number[], right: number[]) {
  const length = Math.min(left.length, right.length);
  let total = 0;
  for (let index = 0; index < length; index += 1) {
    total += left[index] * right[index];
  }
  return total;
}

export class HashEmbeddingClient implements EmbeddingClient {
  constructor(private readonly dimensions = 64) {}

  async embed(texts: string[]) {
    return texts.map((text) => {
      const vector = new Array(this.dimensions).fill(0);
      for (const token of text.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean)) {
        const digest = createHash('sha1').update(token).digest();
        const slot = digest[0] % this.dimensions;
        vector[slot] += 1;
      }
      return normalize(vector);
    });
  }
}

/**
 * LlmEmbeddingClient queries real Gemini or OpenAI embedding models,
 * falling back automatically to HashEmbeddingClient if keys are not present
 * or the remote API throws an error.
 */
export class LlmEmbeddingClient implements EmbeddingClient {
  private readonly fallback = new HashEmbeddingClient(64);

  async embed(texts: string[]): Promise<number[][]> {
    if (texts.length === 0) return [];

    try {
      // 1. Try OpenAI Embedding if API key exists
      const openAiKey = process.env.OPENAI_API_KEY?.trim();
      if (openAiKey) {
        const res = await fetch('https://api.openai.com/v1/embeddings', {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': `Bearer ${openAiKey}`
          },
          body: JSON.stringify({
            input: texts,
            model: 'text-embedding-3-small'
          }),
          signal: AbortSignal.timeout(10_000)
        });

        if (res.ok) {
          const data = await res.json();
          if (Array.isArray(data?.data)) {
            return data.data.map((item: any) => normalize(item.vector));
          }
        }
      }

      // 2. Try Gemini Embedding from dynamic key pool or environment
      let geminiKey = process.env.GEMINI_API_KEY?.trim();
      if (!geminiKey) {
        const keyObj = await getHealthiestKeyObj().catch(() => null);
        if (keyObj) geminiKey = keyObj.key;
      }

      if (geminiKey) {
        const candidateModels = [
          'text-embedding-004',
          'gemini-embedding-001',
          'gemini-embedding-2',
          'gemini-embedding-2-preview'
        ];

        for (const model of candidateModels) {
          try {
            // If single text, we can use embedContent, for multiple texts use batchEmbedContents
            if (texts.length === 1) {
              const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:embedContent?key=${geminiKey}`;
              const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  content: { parts: [{ text: texts[0] }] }
                }),
                signal: AbortSignal.timeout(10_000)
              });
              if (res.ok) {
                const data = await res.json();
                if (data?.embedding?.values) {
                  return [normalize(data.embedding.values)];
                }
              }
            } else {
              const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:batchEmbedContents?key=${geminiKey}`;
              const requests = texts.map(t => ({
                model: `models/${model}`,
                content: { parts: [{ text: t }] }
              }));

              const res = await fetch(url, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ requests }),
                signal: AbortSignal.timeout(12_000)
              });
              if (res.ok) {
                const data = await res.json();
                if (Array.isArray(data?.embeddings)) {
                  return data.embeddings.map((item: any) => normalize(item.values));
                }
              }
            }
          } catch (modelErr) {
            console.warn(`[LlmEmbeddingClient] Embedding with model ${model} failed, trying next fallback:`, modelErr);
          }
        }
      }
    } catch (err) {
      console.warn('[LlmEmbeddingClient] API embed failed, falling back to local hashing:', err);
    }

    // Default Fallback
    return this.fallback.embed(texts);
  }
}

export class InMemoryVectorStore implements VectorStore {
  private readonly records = new Map<string, VectorRecord>();

  async upsert(records: VectorRecord[]) {
    for (const record of records) {
      this.records.set(`${record.scope}:${record.key}`, record);
    }
  }

  async query(scope: string, vector: number[], limit: number) {
    return Array.from(this.records.values())
      .filter((record) => record.scope === scope)
      .map((record) => ({ record, score: cosineSimilarity(record.vector, vector) }))
      .sort((left, right) => right.score - left.score)
      .slice(0, limit)
      .map(({ record }) => record);
  }
}

export class MongoVectorStore implements VectorStore {
  async upsert(records: VectorRecord[]) {
    try {
      const db = await getMongoDb();
      const collection = db.collection<VectorRecord>('runtime_vectors');
      await collection.createIndex({ scope: 1, key: 1 }, { unique: true });
      await Promise.all(records.map((record) => collection.updateOne(
        { scope: record.scope, key: record.key },
        { $set: record },
        { upsert: true },
      )));
    } catch {
      // optional durability
    }
  }

  async query(scope: string, vector: number[], limit: number) {
    try {
      const db = await getMongoDb();
      const collection = db.collection<VectorRecord>('runtime_vectors');
      const records = await collection.find({ scope }).limit(Math.max(limit * 6, limit)).toArray();
      return records
        .map((record) => ({ record, score: cosineSimilarity(record.vector, vector) }))
        .sort((left, right) => right.score - left.score)
        .slice(0, limit)
        .map(({ record }) => record);
    } catch {
      return [];
    }
  }
}

export class CompositeVectorStore implements VectorStore {
  constructor(
    private readonly primary: VectorStore,
    private readonly secondary?: VectorStore,
  ) {}

  async upsert(records: VectorRecord[]) {
    await this.primary.upsert(records);
    if (this.secondary) await this.secondary.upsert(records);
  }

  async query(scope: string, vector: number[], limit: number) {
    const primaryResults = await this.primary.query(scope, vector, limit);
    if (primaryResults.length >= limit || !this.secondary) return primaryResults;
    const secondaryResults = await this.secondary.query(scope, vector, limit);
    const merged = new Map<string, VectorRecord>();
    for (const record of [...primaryResults, ...secondaryResults]) {
      merged.set(`${record.scope}:${record.key}`, record);
    }
    return Array.from(merged.values()).slice(0, limit);
  }
}
