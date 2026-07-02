import type { AgentSession, AgentSessionLogEntry } from './contracts';

export class RuntimeLoggingEngine {
  info(session: AgentSession, message: string, metadata?: Record<string, unknown>) {
    this.append(session, { at: Date.now(), level: 'info', message, metadata });
  }

  warn(session: AgentSession, message: string, metadata?: Record<string, unknown>) {
    this.append(session, { at: Date.now(), level: 'warn', message, metadata });
  }

  error(session: AgentSession, message: string, metadata?: Record<string, unknown>) {
    this.append(session, { at: Date.now(), level: 'error', message, metadata });
  }

  private append(session: AgentSession, entry: AgentSessionLogEntry) {
    session.logs = [...session.logs.slice(-199), entry];
  }
}
