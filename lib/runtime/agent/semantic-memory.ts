import type { MemoryNote } from './contracts';
import { CompositeVectorStore, LlmEmbeddingClient, InMemoryVectorStore, MongoVectorStore, type EmbeddingClient, type VectorStore } from './embedding-runtime';

export class SemanticMemoryRuntime {
  constructor(
    private readonly embeddings: EmbeddingClient = new LlmEmbeddingClient(),
    private readonly vectors: VectorStore = new CompositeVectorStore(new InMemoryVectorStore(), new MongoVectorStore()),
  ) {}

  async remember(scope: string, notes: MemoryNote[]) {
    if (notes.length === 0) return;
    const vectors = await this.embeddings.embed(notes.map((note) => note.value));
    await this.vectors.upsert(notes.map((note, index) => ({
      scope,
      key: `${note.type}:${note.source}:${note.createdAt}:${index}`,
      text: note.value,
      vector: vectors[index],
      metadata: {
        type: note.type,
        source: note.source,
        score: note.score,
        createdAt: note.createdAt,
      },
      updatedAt: Date.now(),
    })));
  }

  async retrieve(scope: string, query: string, limit = 8) {
    const [queryVector] = await this.embeddings.embed([query]);
    return this.vectors.query(scope, queryVector, limit);
  }
}
