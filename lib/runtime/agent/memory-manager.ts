import { createHash } from 'node:crypto';
import type {
  AgentGoal,
  MemoryNote,
  MemoryRetrieval,
  MemoryVectorEntry,
  RepositoryInsights,
  RuntimeContextEnvelope,
  RuntimeMemory,
} from './contracts';
import { SemanticMemoryRuntime } from './semantic-memory';
import { LlmEmbeddingClient } from './embedding-runtime';

function note(type: MemoryNote['type'], value: string, source: string, score = 1): MemoryNote {
  return {
    type,
    value,
    source,
    score,
    createdAt: Date.now(),
  };
}

function tokenize(value: string) {
  return value.toLowerCase().split(/[^a-z0-9_]+/).filter(Boolean);
}

function embeddingFor(value: string, dimensions = 32) {
  const vector = new Array<number>(dimensions).fill(0);
  for (const token of tokenize(value)) {
    const digest = createHash('sha1').update(token).digest();
    for (let index = 0; index < dimensions; index += 1) {
      vector[index] += digest[index % digest.length] / 255;
    }
  }
  const magnitude = Math.sqrt(vector.reduce((sum, current) => sum + current * current, 0)) || 1;
  return vector.map((entry) => Number((entry / magnitude).toFixed(6)));
}

function cosine(left: number[], right: number[]) {
  let sum = 0;
  let leftMagnitude = 0;
  let rightMagnitude = 0;
  for (let index = 0; index < Math.max(left.length, right.length); index += 1) {
    const a = left[index] ?? 0;
    const b = right[index] ?? 0;
    sum += a * b;
    leftMagnitude += a * a;
    rightMagnitude += b * b;
  }
  return sum / ((Math.sqrt(leftMagnitude) || 1) * (Math.sqrt(rightMagnitude) || 1));
}

/**
 * Module-level project memory stores — scoped per projectKey.
 * These are intentionally module-level (not class-static) so they persist across
 * sessions for the same project without coupling to any single MemoryManager instance.
 * This is safe for project memory (cross-session learning) but NOT for session-specific
 * memory, which is always instance-bound via RuntimeMemory.
 */
const _projectMemoryStore = new Map<string, MemoryNote[]>();
const _vectorMemoryStore = new Map<string, MemoryVectorEntry[]>();

export class MemoryManager {
  constructor(
    private readonly semantic = new SemanticMemoryRuntime(),
    private readonly embeddings = new LlmEmbeddingClient()
  ) {}

  private projectKey(analysis: RepositoryInsights) {
    return `${analysis.projectType}:${analysis.framework}:${analysis.language}`;
  }

  private vectorKey(projectKey: string, scope: MemoryVectorEntry['scope']) {
    return `${projectKey}:${scope}`;
  }

  private appendVector(
    projectKey: string,
    scope: MemoryVectorEntry['scope'],
    entry: Omit<MemoryVectorEntry, 'id' | 'vector' | 'scope'>,
  ) {
    const key = this.vectorKey(projectKey, scope);
    const existing = _vectorMemoryStore.get(key) ?? [];
    _vectorMemoryStore.set(key, [
      ...existing.slice(-255),
      {
        ...entry,
        scope,
        id: `${scope}:${entry.source}:${entry.createdAt}:${existing.length}`,
        vector: embeddingFor(entry.value),
      },
    ]);
  }

  private collectMemory(memory: RuntimeMemory) {
    return [
      ...memory.sessionNotes,
      ...memory.projectFacts,
      ...memory.semanticFacts,
      ...memory.longTermFacts,
      ...memory.architectureFacts,
      ...memory.conversationFacts,
      ...memory.toolExecutionFacts,
      ...(memory.vectorFacts ?? []),
    ];
  }

  initialize(goal: AgentGoal, analysis: RepositoryInsights, context: RuntimeContextEnvelope): RuntimeMemory {
    const projectKey = this.projectKey(analysis);
    const persisted = _projectMemoryStore.get(projectKey) ?? [];

    const memory: RuntimeMemory = {
      sessionNotes: [
        note('session', `Objective captured: ${goal.objective}`, 'goal-understanding', 1),
        note('session', `Context budget selected: ${context.tokenBudget} tokens`, 'context-builder', 0.8),
      ],
      projectFacts: [
        ...analysis.architectureNotes.map((value) => note('project', value, 'repository-analysis', 0.8)),
      ],
      semanticFacts: [
        note('semantic', `Framework ${analysis.framework}`, 'repository-analysis', 0.6),
        note('semantic', `Project type ${analysis.projectType}`, 'repository-analysis', 0.6),
        ...context.rankedItems.slice(0, 5).map((item) => note('semantic', `Relevant file ${item.file}`, 'context-builder', item.score)),
      ],
      longTermFacts: persisted.slice(-12),
      architectureFacts: analysis.repositorySummary.map((value) => note('architecture', value, 'repository-analysis', 0.7)),
      conversationFacts: [
        note('conversation', goal.objective, 'user-request', 1),
        ...goal.constraints.map((value) => note('conversation', value, 'goal-constraints', 0.7)),
      ],
      toolExecutionFacts: [],
      vectorFacts: [],
      selectedFiles: context.selectedFiles,
      retrievals: [],
    };

    _projectMemoryStore.set(projectKey, [
      ...persisted,
      ...memory.projectFacts,
      ...memory.architectureFacts,
      ...memory.longTermFacts,
    ].slice(-64));

    for (const entry of [...memory.projectFacts, ...memory.architectureFacts, ...memory.longTermFacts]) {
      this.appendVector(projectKey, entry.type === 'long_term' ? 'long_term' : 'project', {
        noteType: entry.type,
        source: entry.source,
        value: entry.value,
        score: entry.score,
        createdAt: entry.createdAt,
        projectKey,
      });
    }

    void this.semantic.remember(`project:${projectKey}`, [
      ...memory.projectFacts,
      ...memory.architectureFacts,
      ...memory.longTermFacts,
      ...memory.semanticFacts,
    ]);
    void this.semantic.remember(`session:${goal.objective}`, [
      ...memory.sessionNotes,
      ...memory.conversationFacts,
    ]);

    return memory;
  }

  update(memory: RuntimeMemory, value: string, source = 'runtime', type: MemoryNote['type'] = 'session', score = 0.6) {
    const entry = note(type, value, source, score);
    if (type === 'tool_execution') {
      memory.toolExecutionFacts = [...memory.toolExecutionFacts.slice(-23), entry];
    } else if (type === 'conversation') {
      memory.conversationFacts = [...memory.conversationFacts.slice(-23), entry];
    } else if (type === 'architecture') {
      memory.architectureFacts = [...memory.architectureFacts.slice(-23), entry];
    } else if (type === 'project') {
      memory.projectFacts = [...memory.projectFacts.slice(-23), entry];
    } else if (type === 'semantic') {
      memory.semanticFacts = [...memory.semanticFacts.slice(-23), entry];
    } else if (type === 'long_term') {
      memory.longTermFacts = [...memory.longTermFacts.slice(-23), entry];
    } else if (type === 'vector') {
      memory.vectorFacts = [...(memory.vectorFacts ?? []).slice(-23), entry];
    } else {
      memory.sessionNotes = [...memory.sessionNotes.slice(-23), entry];
    }
    const scope = type === 'project' || type === 'architecture' || type === 'long_term' || type === 'semantic'
      ? 'project:runtime'
      : 'session:runtime';
    void this.semantic.remember(scope, [entry]);
    return memory;
  }

  async retrieve(memory: RuntimeMemory, query: string, limit = 8, analysis?: RepositoryInsights) {
    const queryTokens = new Set(tokenize(query));
    const queryVector = (await this.embeddings.embed([query]))[0] ?? embeddingFor(query);
    const projectKey = analysis ? this.projectKey(analysis) : null;

    const vectorMatches = projectKey
      ? [
          ...(_vectorMemoryStore.get(this.vectorKey(projectKey, 'project')) ?? []),
          ...(_vectorMemoryStore.get(this.vectorKey(projectKey, 'long_term')) ?? []),
        ]
          .map((entry) => {
            const ageHours = (Date.now() - entry.createdAt) / 3600000;
            const recencyFactor = Math.exp(-0.01 * ageHours);
            const semanticScore = cosine(queryVector, entry.vector);
            return {
              value: entry.value,
              score: semanticScore + (entry.score * 0.2) + (recencyFactor * 0.1),
            };
          })
          .sort((left, right) => right.score - left.score)
          .slice(0, limit)
      : [];

    const semanticMatches = analysis
      ? await this.semantic.retrieve(`project:${projectKey}`, query, limit).catch(() => [])
      : [];
    const sessionSemanticMatches = await this.semantic.retrieve('session:runtime', query, Math.max(2, Math.floor(limit / 2))).catch(() => []);

    const lexicalMatches = this.collectMemory(memory)
      .map((entry) => {
        const tokens = tokenize(entry.value);
        const overlap = tokens.filter((token) => queryTokens.has(token)).length;
        const lexicalScore = tokens.length > 0 ? overlap / tokens.length : 0;
        const ageHours = (Date.now() - entry.createdAt) / 3600000;
        const recencyFactor = Math.exp(-0.01 * ageHours);
        return {
          entry,
          score: entry.score + (lexicalScore * 0.5) + (recencyFactor * 0.1),
        };
      })
      .sort((left, right) => right.score - left.score || right.entry.createdAt - left.entry.createdAt)
      .slice(0, limit)
      .map((item) => item.entry);

    const hybrid = new Map<string, MemoryNote>();
    for (const entry of lexicalMatches) {
      hybrid.set(`${entry.source}:${entry.value}`, entry);
    }
    for (const match of vectorMatches) {
      hybrid.set(`vector:${match.value}`, note('semantic', match.value, 'vector-memory', match.score));
    }
    for (const match of [...semanticMatches, ...sessionSemanticMatches]) {
      const value = typeof match.text === 'string' ? match.text : String(match.text ?? '');
      hybrid.set(`semantic:${value}`, note(
        (match.metadata?.type as MemoryNote['type']) ?? 'semantic',
        value,
        typeof match.metadata?.source === 'string' ? match.metadata.source : 'semantic-memory',
        Number(match.metadata?.score ?? 0.5),
      ));
    }

    const retrieved = Array.from(hybrid.values()).slice(0, limit);
    const retrieval: MemoryRetrieval = {
      query,
      matched: retrieved.map((entry) => entry.value).slice(0, limit),
      strategy: vectorMatches.length > 0 || semanticMatches.length > 0 || sessionSemanticMatches.length > 0 ? 'hybrid' : 'lexical',
      createdAt: Date.now(),
    };
    memory.retrievals = [...(memory.retrievals ?? []).slice(-15), retrieval];
    return retrieved;
  }

  rememberProject(analysis: RepositoryInsights, value: string, source: string, type: MemoryNote['type'] = 'project', score = 0.7) {
    const projectKey = this.projectKey(analysis);
    const persisted = _projectMemoryStore.get(projectKey) ?? [];
    const entry = note(type, value, source, score);
    _projectMemoryStore.set(projectKey, [...persisted.slice(-63), entry]);
    this.appendVector(projectKey, type === 'long_term' ? 'long_term' : 'project', {
      noteType: type,
      source,
      value,
      score,
      createdAt: entry.createdAt,
      projectKey,
    });
    void this.semantic.remember(`project:${projectKey}`, [entry]);
    return entry;
  }
}
