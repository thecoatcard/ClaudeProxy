import { randomUUID } from 'node:crypto';
import type { Collection, Db, Filter } from 'mongodb';
import type { AgentRun, CreateRunInput, RunRepository, RuntimeEvent } from './types';

export class MongoRunRepository implements RunRepository {
  private runs: Collection<AgentRun>;
  private runtimeEvents: Collection<RuntimeEvent>;

  constructor(db: Db) {
    this.runs = db.collection<AgentRun>('agent_runs');
    this.runtimeEvents = db.collection<RuntimeEvent>('agent_events');
  }

  async ensureIndexes() {
    await Promise.all([
      this.runs.createIndex({ id: 1 }, { unique: true }),
      this.runs.createIndex({ ownerId: 1, createdAt: -1 }),
      this.runs.createIndex({ ownerId: 1, state: 1, updatedAt: -1 }),
      this.runtimeEvents.createIndex({ id: 1 }, { unique: true }),
      this.runtimeEvents.createIndex({ ownerId: 1, runId: 1, sequence: 1 }, { unique: true }),
      this.runtimeEvents.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 90 }),
    ]);
  }

  async create(input: CreateRunInput): Promise<AgentRun> {
    const now = Date.now();
    const run: AgentRun = {
      id: randomUUID(),
      ownerId: input.ownerId,
      objective: input.objective,
      state: 'QUEUED',
      version: 1,
      createdAt: now,
      updatedAt: now,
    };

    await this.runs.insertOne(run);
    await this.appendEvent(run, 'RUN_CREATED', 1, { state: run.state, objective: run.objective });
    return run;
  }

  get(ownerId: string, runId: string) {
    return this.runs.findOne({ ownerId, id: runId });
  }

  async list(ownerId: string, limit = 50, before?: number) {
    const filter: Filter<AgentRun> = { ownerId };
    if (before !== undefined) {
      filter.createdAt = { $lt: before };
    }

    return this.runs
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(limit, 1), 100))
      .toArray();
  }

  async requestCancellation(ownerId: string, runId: string, expectedVersion?: number) {
    const filter: Filter<AgentRun> = {
      ownerId,
      id: runId,
      state: { $in: ['QUEUED', 'RUNNING', 'WAITING', 'CANCEL_REQUESTED'] },
    };
    if (expectedVersion !== undefined) {
      filter.version = expectedVersion;
    }

    const now = Date.now();
    const run = await this.runs.findOneAndUpdate(
      filter,
      {
        $set: {
          state: 'CANCEL_REQUESTED',
          cancellationRequestedAt: now,
          updatedAt: now,
        },
        $inc: { version: 1 },
      },
      { returnDocument: 'after' },
    );

    if (!run) {
      return null;
    }

    await this.appendEvent(run, 'RUN_CANCEL_REQUESTED', run.version, { state: run.state });
    return run;
  }

  events(ownerId: string, runId: string, afterSequence = 0, limit = 200) {
    return this.runtimeEvents
      .find({ ownerId, runId, sequence: { $gt: afterSequence } })
      .sort({ sequence: 1 })
      .limit(Math.min(Math.max(limit, 1), 500))
      .toArray();
  }

  private async appendEvent(run: AgentRun, type: string, sequence: number, data: Record<string, unknown>) {
    await this.runtimeEvents.insertOne({
      id: randomUUID(),
      runId: run.id,
      ownerId: run.ownerId,
      type,
      sequence,
      data,
      createdAt: Date.now(),
    });
  }
}
