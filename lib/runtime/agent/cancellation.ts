import type { AgentSession, AgentSessionRepository, CancellationSignal } from './contracts';

export class SessionCancellationSignal implements CancellationSignal {
  constructor(
    private readonly repository: AgentSessionRepository,
    private readonly session: AgentSession,
  ) {}

  cancelled = false;
  reason?: string;

  async refresh() {
    const latest = await this.repository.getAny(this.session.id);
    const cancelled = latest?.status === 'CANCELLED' || Boolean(latest?.cancellationRequestedAt);
    this.cancelled = cancelled;
    this.reason = cancelled ? 'Session cancellation requested' : undefined;
    return this.cancelled;
  }

  throwIfCancelled() {
    if (this.cancelled) {
      throw new Error(this.reason ?? 'Session cancelled');
    }
  }
}
