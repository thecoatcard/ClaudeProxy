export type AgentSessionStatus =
  | 'CREATED'
  | 'ANALYZING'
  | 'PLANNED'
  | 'RUNNING'
  | 'VALIDATING'
  | 'COMPLETED'
  | 'FAILED'
  | 'CANCELLED';

export type AgentTaskStatus = 'PENDING' | 'RUNNING' | 'COMPLETED' | 'FAILED' | 'SKIPPED' | 'CANCELLED';
export type PermissionLevel = 'safe' | 'confirmation_required' | 'dangerous';
export type TaskExecutionMode = 'sequential' | 'parallel';
export type RuntimeLifecycleState =
  | 'Idle'
  | 'Initializing'
  | 'Planning'
  | 'Executing'
  | 'Waiting Approval'
  | 'Waiting Tool'
  | 'Reflecting'
  | 'Retrying'
  | 'Recovering'
  | 'Completed'
  | 'Failed'
  | 'Cancelled';

export interface AgentGoal {
  objective: string;
  missingInformation: string[];
  requiredTools: string[];
  expectedOutputs: string[];
  constraints: string[];
}

export interface WorkspaceContext {
  root: string;
  packageManager: 'npm' | 'pnpm' | 'yarn' | 'unknown';
  projectType: string;
  language: string;
  framework: string;
  buildCommand?: string;
  testCommand?: string;
  configFiles: string[];
  entryPoints: string[];
}

export interface RepositorySymbol {
  name: string;
  kind: 'function' | 'class' | 'interface' | 'type' | 'variable' | 'method' | 'file';
  file: string;
  exported: boolean;
  line: number;
  references: number;
  calls: string[];
}

export interface RepositoryFileIndex {
  path: string;
  language: string;
  size: number;
  hash: string;
  lastModifiedMs: number;
  imports: string[];
  exports: string[];
  symbols: RepositorySymbol[];
  callTargets: string[];
  documentation: string[];
}

export interface RepositoryGraph {
  dependencyGraph: Record<string, string[]>;
  importGraph: Record<string, string[]>;
  callGraph: Record<string, string[]>;
  reverseDependencies: Record<string, string[]>;
  crossReferences?: Record<string, string[]>;
}

export interface RepositoryCacheMetadata {
  cacheKey: string;
  createdAt: number;
  indexedAt: number;
  fileCount: number;
  reusedFiles: number;
}

export interface RepositoryInsights {
  packageManager: WorkspaceContext['packageManager'];
  projectType: string;
  language: string;
  framework: string;
  architectureNotes: string[];
  dependencyFiles: string[];
  buildSystem: string[];
  tests: string[];
  docker: string[];
  ci: string[];
  entryPoints: string[];
  candidateContextFiles: string[];
  indexedFiles: RepositoryFileIndex[];
  symbols: RepositorySymbol[];
  graphs: RepositoryGraph;
  projectStructure: Record<string, string[]>;
  repositorySummary: string[];
  cache: RepositoryCacheMetadata;
}

export interface MemoryNote {
  type:
    | 'session'
    | 'project'
    | 'semantic'
    | 'long_term'
    | 'architecture'
    | 'conversation'
    | 'tool_execution'
    | 'vector';
  value: string;
  source: string;
  score: number;
  createdAt: number;
}

export interface RuntimeMemory {
  sessionNotes: MemoryNote[];
  projectFacts: MemoryNote[];
  semanticFacts: MemoryNote[];
  longTermFacts: MemoryNote[];
  architectureFacts: MemoryNote[];
  conversationFacts: MemoryNote[];
  toolExecutionFacts: MemoryNote[];
  vectorFacts?: MemoryNote[];
  selectedFiles: string[];
  retrievals?: MemoryRetrieval[];
}

export interface MemoryVectorEntry {
  id: string;
  scope: 'session' | 'project' | 'long_term';
  noteType: MemoryNote['type'];
  source: string;
  value: string;
  vector: number[];
  score: number;
  createdAt: number;
  sessionId?: string;
  projectKey?: string;
}

export interface MemoryRetrieval {
  query: string;
  matched: string[];
  strategy: 'lexical' | 'vector' | 'hybrid';
  createdAt: number;
}

export interface ToolCapability {
  name: string;
  source: 'runtime' | 'request';
  permission: PermissionLevel;
  enabled: boolean;
  operations?: string[];
}

export interface ToolDefinition {
  name: string;
  description: string;
  adapter: ToolAdapterKind;
  operation: string;
  permission: PermissionLevel;
  inputSchema: Record<string, unknown>;
 }

export interface AgentTaskNode {
  id: string;
  kind:
    | 'goal_understanding'
    | 'workspace_initialization'
    | 'repository_analysis'
    | 'context_building'
    | 'tool_selection'
    | 'planning'
    | 'task_scheduling'
    | 'model_execution'
    | 'validation'
    | 'reflection'
    | 'memory_update'
    | 'completion';
  title: string;
  detail: string;
  dependencies: string[];
  status: AgentTaskStatus;
  priority?: number;
  executionMode?: TaskExecutionMode;
  maxAttempts?: number;
  attempts?: number;
  checkpointBefore?: boolean;
  output?: Record<string, unknown>;
  error?: string;
  startedAt?: number;
  completedAt?: number;
}

export interface RankedContextItem {
  file: string;
  score: number;
  reasons: string[];
  relatedSymbols: string[];
}

export interface RuntimeContextEnvelope {
  summary: string;
  selectedFiles: string[];
  rankedItems: RankedContextItem[];
  repositoryFacts: string[];
  toolSummary: string[];
  memorySummary: string[];
  tokenBudget: number;
}

export interface AgentSessionLogEntry {
  at: number;
  level: 'info' | 'warn' | 'error';
  message: string;
  metadata?: Record<string, unknown>;
}

export interface RuntimeHistoryEntry {
  at: number;
  state: RuntimeLifecycleState;
  detail: string;
  metadata?: Record<string, unknown>;
}

export interface SessionCheckpoint {
  id: string;
  at: number;
  label: string;
  lifecycleState: RuntimeLifecycleState;
  currentState: string;
  pendingTasks: string[];
  runningTasks: string[];
  completedTasks: string[];
  metadata: Record<string, unknown>;
}

export interface AgentSession {
  id: string;
  ownerId: string;
  version: number;
  requestedModel: string;
  goal: AgentGoal;
  workspace: WorkspaceContext;
  status: AgentSessionStatus;
  currentState: string;
  tasks: AgentTaskNode[];
  completedTasks: string[];
  pendingTasks: string[];
  runningTasks: string[];
  modifiedFiles: string[];
  logs: AgentSessionLogEntry[];
  runtimeState: RuntimeLifecycleState;
  runtimeHistory: RuntimeHistoryEntry[];
  browserState: Record<string, unknown>;
  gitState: Record<string, unknown>;
  memory: RuntimeMemory;
  checkpoints: SessionCheckpoint[];
  artifacts: string[];
  createdAt: number;
  updatedAt: number;
  completedAt?: number;
  lastError?: string;
  cancellationRequestedAt?: number;
  /**
   * Stores the latest ReflectionResult from the ReflectionEngine.
   * Used by the runtime loop to read shouldReplan/shouldRetry signals
   * without tight coupling to the ExecutionEngine.
   */
  lastReflection?: Record<string, unknown>;
}

export interface AgentSessionEvent {
  id: string;
  sessionId: string;
  ownerId: string;
  sequence: number;
  type: string;
  data: Record<string, unknown>;
  createdAt: number;
}

export interface CreateSessionInput {
  ownerId: string;
  requestedModel: string;
  goal: AgentGoal;
  workspace: WorkspaceContext;
  tasks: AgentTaskNode[];
  memory: RuntimeMemory;
}

export interface AgentSessionRepository {
  ensureIndexes(): Promise<void>;
  create(input: CreateSessionInput): Promise<AgentSession>;
  get(ownerId: string, sessionId: string): Promise<AgentSession | null>;
  getAny(sessionId: string): Promise<AgentSession | null>;
  list(ownerId: string, limit?: number, before?: number): Promise<AgentSession[]>;
  listAll(limit?: number, before?: number): Promise<AgentSession[]>;
  save(session: AgentSession): Promise<void>;
  requestCancellation(ownerId: string, sessionId: string, expectedVersion?: number): Promise<AgentSession | null>;
  requestCancellationAny(sessionId: string, expectedVersion?: number): Promise<AgentSession | null>;
  events(ownerId: string, sessionId: string, afterSequence?: number, limit?: number): Promise<AgentSessionEvent[]>;
  eventsAny(sessionId: string, afterSequence?: number, limit?: number): Promise<AgentSessionEvent[]>;
  appendEvent(event: Omit<AgentSessionEvent, 'id' | 'createdAt'>): Promise<void>;
}

export interface ValidationResult {
  status: 'passed' | 'failed' | 'skipped';
  checks: string[];
  details: string[];
}

/** @deprecated — import RetryDecision directly from './retry-manager'. */
export type { RetryDecision } from './retry-manager';


export interface CancellationSignal {
  readonly cancelled: boolean;
  readonly reason?: string;
  throwIfCancelled(): void;
}

export interface SchedulerBatch {
  wave: number;
  tasks: AgentTaskNode[];
}

export interface TaskSchedulerResult {
  ordered: AgentTaskNode[];
  batches: SchedulerBatch[];
}

export interface RuntimeEvent<TData extends Record<string, unknown> = Record<string, unknown>> {
  id: string;
  type: string;
  timestamp: number;
  sessionId?: string;
  data: TData;
}

export interface ArtifactRecord {
  id: string;
  type: 'file' | 'log' | 'report' | 'plan' | 'patch' | 'image';
  label: string;
  path?: string;
  createdAt: number;
  metadata?: Record<string, unknown>;
}

export interface ModelExecutionRequest {
  body: Record<string, unknown>;
  requestedModel: string;
  internalModel: string;
  token: string;
  route: unknown;
  requestId: string;
  runtimeSummary: string;
  runtimePlan: string;
  cancellation?: CancellationSignal;
}

export interface ModelExecutionResponse {
  content?: Array<{ type: string; text?: string } | Record<string, unknown>>;
  usage?: {
    input_tokens?: number;
    output_tokens?: number;
  };
  stop_reason?: string | null;
  model?: string;
  provider?: string;
}

export type ModelProvider = 'gemini' | 'openai' | 'claude' | 'ollama' | 'openrouter';

export interface ProviderHealthSnapshot {
  provider: ModelProvider;
  available: boolean;
  latencyMs?: number;
  failures: number;
  lastError?: string;
  updatedAt: number;
}

export type ToolAdapterKind =
  | 'filesystem'
  | 'shell'
  | 'git'
  | 'browser'
  | 'docker'
  | 'database'
  | 'http'
  | 'mcp';

export type ToolResultStatus =
  | 'success'
  | 'error'
  | 'cancelled'
  | 'approval_required'
  | 'denied'
  | 'timeout';

export interface ToolContext {
  sessionId: string;
  ownerId: string;
  workspaceRoot: string;
  requestId: string;
  cancellation?: CancellationSignal;
  metadata?: Record<string, unknown>;
}

export interface ToolInvocation {
  adapter: ToolAdapterKind;
  operation: string;
  input: Record<string, unknown>;
  requestId?: string;
}

export interface ToolApprovalRequest {
  adapter: ToolAdapterKind;
  operation: string;
  reason: string;
  permission: PermissionLevel;
}

export interface ToolAuditRecord {
  adapter: ToolAdapterKind;
  operation: string;
  permission: PermissionLevel;
  startedAt: number;
  completedAt: number;
  durationMs: number;
}

export interface ToolResult {
  status: ToolResultStatus;
  adapter: ToolAdapterKind;
  operation: string;
  output?: Record<string, unknown>;
  error?: string;
  logs: string[];
  audit: ToolAuditRecord;
  approval?: ToolApprovalRequest;
}

export interface ToolAdapter {
  readonly kind: ToolAdapterKind;
  readonly operations: string[];
  execute(invocation: ToolInvocation, context: ToolContext): Promise<ToolResult>;
}
