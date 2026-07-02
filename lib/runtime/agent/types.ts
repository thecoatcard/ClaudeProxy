export const RUN_STATES = ['QUEUED', 'RUNNING', 'WAITING', 'CANCEL_REQUESTED', 'COMPLETED', 'FAILED', 'CANCELLED'] as const;
export type RunState = (typeof RUN_STATES)[number];

export interface AgentRun {
  id: string; ownerId: string; objective: string; state: RunState; version: number;
  cancellationRequestedAt?: number; createdAt: number; updatedAt: number;
}
export interface RuntimeEvent {
  id: string; runId: string; ownerId: string; type: string; sequence: number;
  data: Record<string, unknown>; createdAt: number;
}
export interface CreateRunInput { ownerId: string; objective: string }
export interface RunRepository {
  ensureIndexes(): Promise<void>;
  create(input: CreateRunInput): Promise<AgentRun>;
  get(ownerId: string, runId: string): Promise<AgentRun | null>;
  list(ownerId: string, limit?: number, before?: number): Promise<AgentRun[]>;
  requestCancellation(ownerId: string, runId: string, expectedVersion?: number): Promise<AgentRun | null>;
  events(ownerId: string, runId: string, afterSequence?: number, limit?: number): Promise<RuntimeEvent[]>;
}
