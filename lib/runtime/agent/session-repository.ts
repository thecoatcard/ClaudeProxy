import { randomUUID } from 'node:crypto';
import type { Collection, Db, Filter } from 'mongodb';
import type { AgentSession, AgentSessionEvent, AgentSessionRepository, CreateSessionInput } from './contracts';

export class MongoAgentSessionRepository implements AgentSessionRepository {
  private readonly sessions: Collection<AgentSession>;
  private readonly sessionEvents: Collection<AgentSessionEvent>;

  constructor(db: Db) {
    this.sessions = db.collection<AgentSession>('agent_sessions');
    this.sessionEvents = db.collection<AgentSessionEvent>('agent_session_events');
  }

  async ensureIndexes() {
    await Promise.all([
      this.sessions.createIndex({ id: 1 }, { unique: true }),
      this.sessions.createIndex({ ownerId: 1, createdAt: -1 }),
      this.sessions.createIndex({ ownerId: 1, status: 1, updatedAt: -1 }),
      this.sessionEvents.createIndex({ sessionId: 1, createdAt: 1 }),
      this.sessionEvents.createIndex({ createdAt: 1 }, { expireAfterSeconds: 60 * 60 * 24 * 30 }),
    ]);
  }

  async create(input: CreateSessionInput): Promise<AgentSession> {
    const now = Date.now();
    const session: AgentSession = {
      id: randomUUID(),
      ownerId: input.ownerId,
      version: 1,
      requestedModel: input.requestedModel,
      goal: input.goal,
      workspace: input.workspace,
      status: 'CREATED',
      currentState: 'session_created',
      tasks: input.tasks,
      completedTasks: [],
      pendingTasks: input.tasks.map((task) => task.id),
      runningTasks: [],
      modifiedFiles: [],
      logs: [],
      runtimeState: 'Idle',
      runtimeHistory: [{ at: now, state: 'Idle', detail: 'Session created' }],
      browserState: {},
      gitState: {},
      memory: input.memory,
      checkpoints: [],
      artifacts: [],
      createdAt: now,
      updatedAt: now,
    };

    await this.sessions.insertOne(session);
    await this.appendEvent({
      ownerId: session.ownerId,
      sessionId: session.id,
      sequence: 1,
      type: 'SESSION_CREATED',
      data: { objective: session.goal.objective, status: session.status },
    });
    return session;
  }

  get(ownerId: string, sessionId: string) {
    return this.sessions.findOne({ id: sessionId, ownerId });
  }

  getAny(sessionId: string) {
    return this.sessions.findOne({ id: sessionId });
  }

  async list(ownerId: string, limit = 50, before?: number) {
    const filter: Filter<AgentSession> = { ownerId };
    if (before !== undefined) {
      filter.createdAt = { $lt: before };
    }

    return this.sessions
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(limit, 1), 100))
      .toArray();
  }

  async listAll(limit = 50, before?: number) {
    const filter: Filter<AgentSession> = {};
    if (before !== undefined) {
      filter.createdAt = { $lt: before };
    }

    return this.sessions
      .find(filter)
      .sort({ createdAt: -1 })
      .limit(Math.min(Math.max(limit, 1), 100))
      .toArray();
  }

  async save(session: AgentSession) {
    session.updatedAt = Date.now();
    session.version += 1;
    await this.sessions.updateOne(
      { id: session.id, ownerId: session.ownerId },
      { $set: session },
      { upsert: false },
    );
  }

  async requestCancellation(ownerId: string, sessionId: string, expectedVersion?: number) {
    const filter: Filter<AgentSession> = {
      id: sessionId,
      ownerId,
      status: { $in: ['CREATED', 'ANALYZING', 'PLANNED', 'RUNNING', 'VALIDATING'] },
    };
    if (expectedVersion !== undefined) {
      filter.version = expectedVersion;
    }

    const current = await this.sessions.findOne(filter);
    if (!current) {
      return null;
    }

    const next: AgentSession = {
      ...current,
      version: current.version + 1,
      status: 'CANCELLED',
      currentState: 'cancellation_requested',
      updatedAt: Date.now(),
      completedAt: Date.now(),
    };

    const result = await this.sessions.updateOne(
      { id: sessionId, ownerId, version: current.version },
      { $set: next },
      { upsert: false },
    );
    if (!result.modifiedCount) {
      return null;
    }

    await this.appendEvent({
      ownerId,
      sessionId,
      sequence: await this.nextSequence(sessionId),
      type: 'SESSION_CANCELLED',
      data: { status: next.status, currentState: next.currentState },
    });
    return next;
  }

  async requestCancellationAny(sessionId: string, expectedVersion?: number) {
    const current = await this.getAny(sessionId);
    if (!current) {
      return null;
    }
    return this.requestCancellation(current.ownerId, sessionId, expectedVersion);
  }

  events(ownerId: string, sessionId: string, afterSequence = 0, limit = 200) {
    return this.eventsCollection()
      .find({ ownerId, sessionId, sequence: { $gt: afterSequence } })
      .sort({ sequence: 1 })
      .limit(Math.min(Math.max(limit, 1), 500))
      .toArray();
  }

  eventsAny(sessionId: string, afterSequence = 0, limit = 200) {
    return this.eventsCollection()
      .find({ sessionId, sequence: { $gt: afterSequence } })
      .sort({ sequence: 1 })
      .limit(Math.min(Math.max(limit, 1), 500))
      .toArray();
  }

  async appendEvent(event: Omit<AgentSessionEvent, 'id' | 'createdAt'>) {
    await this.sessionEvents.insertOne({
      id: randomUUID(),
      createdAt: Date.now(),
      ...event,
    });
  }

  private async nextSequence(sessionId: string) {
    const latest = await this.sessionEvents.find({ sessionId }).sort({ sequence: -1 }).limit(1).toArray();
    return (latest[0]?.sequence ?? 0) + 1;
  }

  private eventsCollection() {
    return this.sessionEvents;
  }
}
