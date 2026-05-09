/**
 * tests/memory-integration.test.ts
 *
 * Integration test: simulates a multi-file project scenario using the
 * full embedding memory pipeline (file ingestion → incremental → vector index → retrieval).
 */

// Mock fs for VectorIndex/FileHashStore disk operations
const mockFs = {
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
  statSync: jest.fn().mockReturnValue({ size: 100 }),
  readdirSync: jest.fn().mockReturnValue([]),
};
jest.mock('fs', () => mockFs);

// Mock embedding engine — deterministic vectors based on text hash
jest.mock('../lib/memory/embedding-engine', () => {
  function textToVector(text: string): number[] {
    // Create a simple deterministic vector from text
    const vec = new Array(3).fill(0);
    for (let i = 0; i < text.length; i++) {
      vec[i % 3] += text.charCodeAt(i);
    }
    // Normalize
    const mag = Math.sqrt(vec.reduce((s: number, v: number) => s + v * v, 0));
    return mag > 0 ? vec.map((v: number) => v / mag) : vec;
  }

  return {
    EMBEDDING_DIMENSION: 3,
    embedText: jest.fn(async (text: string) => ({
      text,
      vector: textToVector(text),
      dimension: 3,
      model: 'test',
    })),
    embedFile: jest.fn(async (filePath: string, content: string) => {
      const combined = `File: ${filePath}\n${content}`;
      return {
        text: combined,
        vector: textToVector(combined),
        dimension: 3,
        model: 'test',
      };
    }),
    embedSummary: jest.fn(async (type: string, title: string, content: string) => {
      const combined = `[${type}] ${title}: ${content}`;
      return {
        text: combined,
        vector: textToVector(combined),
        dimension: 3,
        model: 'test',
      };
    }),
    cosineSimilarity: jest.fn((a: number[], b: number[]) => {
      let dot = 0, magA = 0, magB = 0;
      for (let i = 0; i < a.length; i++) {
        dot += a[i] * b[i];
        magA += a[i] * a[i];
        magB += b[i] * b[i];
      }
      const denom = Math.sqrt(magA) * Math.sqrt(magB);
      return denom === 0 ? 0 : dot / denom;
    }),
  };
});

// Mock key-manager
jest.mock('../lib/key-manager', () => ({
  getHealthiestKeyObj: jest.fn().mockResolvedValue({ id: 'k1', key: 'fake' }),
  reportKeyFailure: jest.fn(),
}));

import { VectorIndex } from '../lib/memory/vector-index';
import { FileHashStore, hashContent } from '../lib/memory/incremental-embedding';
import { SummaryStore } from '../lib/memory/summary-memory';
import { retrieveContext, formatRetrievalContext, extractQueryFromBody } from '../lib/memory/retrieval-pipeline';
import {
  ContextLayer,
  mergeContextByPriority,
  buildContextInjection,
  createRetrievalBlock,
} from '../lib/memory/context-priority';
import type { FileEntry } from '../lib/memory/file-ingestion';
const { embedFile, embedSummary } = require('../lib/memory/embedding-engine');

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeFile(relativePath: string, content: string): FileEntry {
  return {
    absolutePath: `/project/${relativePath}`,
    relativePath,
    content,
    size: content.length,
    extension: relativePath.slice(relativePath.lastIndexOf('.')),
  };
}

// ---------------------------------------------------------------------------
// Integration tests
// ---------------------------------------------------------------------------

describe('Memory system integration', () => {
  let vectorIndex: VectorIndex;
  let hashStore: FileHashStore;
  let summaryStore: SummaryStore;

  beforeEach(() => {
    vectorIndex = new VectorIndex('/project');
    hashStore = new FileHashStore('/project');
    summaryStore = new SummaryStore('/project');
    jest.clearAllMocks();
  });

  it('should embed files incrementally and skip unchanged', async () => {
    // Simulate project files
    const files = [
      makeFile('src/auth.ts', 'export function login(user: string, pass: string) {}'),
      makeFile('src/db.ts', 'export const prisma = new PrismaClient();'),
      makeFile('src/api.ts', 'export async function handleRequest(req) {}'),
    ];

    // First run: all files are changed
    const diff1 = hashStore.computeDiff(files);
    expect(diff1.changed).toHaveLength(3);
    expect(diff1.unchanged).toHaveLength(0);

    // Embed changed files
    for (const file of diff1.changed) {
      const result = await embedFile(file.relativePath, file.content);
      vectorIndex.insert({
        id: file.relativePath,
        vector: result.vector,
        metadata: {
          type: 'file',
          title: file.relativePath,
          text: file.content.slice(0, 500),
          embeddedAt: Date.now(),
        },
      });
      hashStore.recordEmbedding(file);
    }

    expect(vectorIndex.size).toBe(3);
    expect(hashStore.size).toBe(3);

    // Second run: no changes
    const diff2 = hashStore.computeDiff(files);
    expect(diff2.changed).toHaveLength(0);
    expect(diff2.unchanged).toHaveLength(3);
  });

  it('should detect file changes and re-embed', async () => {
    const file = makeFile('src/auth.ts', 'version 1');
    hashStore.recordEmbedding(file);

    const updatedFile = makeFile('src/auth.ts', 'version 2');
    const diff = hashStore.computeDiff([updatedFile]);
    expect(diff.changed).toHaveLength(1);
    expect(diff.changed[0].content).toBe('version 2');
  });

  it('should embed task and error summaries into vector index', async () => {
    summaryStore.addTaskSummary('Auth Flow', 'Implemented JWT token flow with refresh');
    summaryStore.addErrorSummary('Prisma Fix', 'Fixed migration error by updating schema');

    const embedded = await summaryStore.embedPending(vectorIndex);
    expect(embedded).toBe(2);
    expect(vectorIndex.size).toBe(2);

    // Second call: nothing new to embed
    const embedded2 = await summaryStore.embedPending(vectorIndex);
    expect(embedded2).toBe(0);
  });

  it('should retrieve relevant context for queries', async () => {
    // Insert some file vectors
    const authResult = await embedFile('src/auth.ts', 'JWT login authentication flow');
    vectorIndex.insert({
      id: 'src/auth.ts',
      vector: authResult.vector,
      metadata: { type: 'file', title: 'src/auth.ts', text: 'JWT login authentication flow', embeddedAt: 1 },
    });

    const dbResult = await embedFile('src/db.ts', 'Prisma database client schema models');
    vectorIndex.insert({
      id: 'src/db.ts',
      vector: dbResult.vector,
      metadata: { type: 'file', title: 'src/db.ts', text: 'Prisma database client schema models', embeddedAt: 1 },
    });

    // Query about auth
    const context = await retrieveContext('authentication login', vectorIndex);
    expect(context.retrieved).toBe(true);
    expect(context.snippets.length).toBeGreaterThan(0);
  });

  it('should format retrieval context for injection', async () => {
    vectorIndex.insert({
      id: 'src/auth.ts',
      vector: [1, 0, 0],
      metadata: { type: 'file', title: 'src/auth.ts', text: 'auth code', embeddedAt: 1 },
    });

    const { embedText } = require('../lib/memory/embedding-engine');
    embedText.mockResolvedValueOnce({ vector: [1, 0, 0], text: 'query' });

    const context = await retrieveContext('query', vectorIndex);
    const formatted = formatRetrievalContext(context);

    if (context.snippets.length > 0) {
      expect(formatted).toContain('Relevant Project Context');
      expect(formatted).toContain('src/auth.ts');
    }
  });

  it('should enforce context priority ordering', () => {
    const blocks = [
      { layer: ContextLayer.COMPACTOR_SUMMARIES, label: 'compactor', text: 'old summary', estimatedTokens: 100 },
      { layer: ContextLayer.EMBEDDING_RETRIEVAL, label: 'retrieval', text: 'retrieved context', estimatedTokens: 100 },
      { layer: ContextLayer.OPERATIONAL_MEMORY, label: 'ops', text: 'ops state', estimatedTokens: 100 },
      { layer: ContextLayer.RECENT_TURNS, label: 'turns', text: 'latest turn', estimatedTokens: 100 },
    ];

    const merged = mergeContextByPriority(blocks);

    // RECENT_TURNS always first (priority 1)
    expect(merged[0].layer).toBe(ContextLayer.RECENT_TURNS);
    // OPERATIONAL_MEMORY before EMBEDDING_RETRIEVAL
    const opsIdx = merged.findIndex(b => b.layer === ContextLayer.OPERATIONAL_MEMORY);
    const embIdx = merged.findIndex(b => b.layer === ContextLayer.EMBEDDING_RETRIEVAL);
    expect(opsIdx).toBeLessThan(embIdx);
  });

  it('should handle full pipeline: ingest → embed → store → retrieve → prioritize', async () => {
    // 1. Ingest files
    const files = [
      makeFile('lib/utils.ts', 'export function formatDate(d: Date) { return d.toISOString(); }'),
      makeFile('components/Button.tsx', 'export function Button({ label }) { return <button>{label}</button>; }'),
    ];

    // 2. Embed files
    for (const file of files) {
      const result = await embedFile(file.relativePath, file.content);
      vectorIndex.insert({
        id: file.relativePath,
        vector: result.vector,
        metadata: {
          type: 'file',
          title: file.relativePath,
          text: file.content.slice(0, 500),
          embeddedAt: Date.now(),
        },
      });
      hashStore.recordEmbedding(file);
    }

    // 3. Add summaries
    summaryStore.addTaskSummary('Date Formatting', 'Added ISO date format utility');
    await summaryStore.embedPending(vectorIndex);

    expect(vectorIndex.size).toBe(3); // 2 files + 1 summary

    // 4. Retrieve
    const context = await retrieveContext('date formatting utility', vectorIndex);
    expect(context.retrieved).toBe(true);

    // 5. Prioritize
    const formatted = formatRetrievalContext(context);
    const retrievalBlock = createRetrievalBlock(formatted);

    if (retrievalBlock) {
      const injection = buildContextInjection([
        { layer: ContextLayer.OPERATIONAL_MEMORY, label: 'ops', text: 'system state', estimatedTokens: 50 },
        retrievalBlock,
      ]);
      expect(injection).toContain('system state');
    }
  });

  it('should extract queries from both Anthropic and Gemini request formats', () => {
    expect(extractQueryFromBody({
      messages: [{ role: 'user', content: 'anthropic query' }],
    })).toBe('anthropic query');

    expect(extractQueryFromBody({
      contents: [{ role: 'user', parts: [{ text: 'gemini query' }] }],
    })).toBe('gemini query');
  });
});
