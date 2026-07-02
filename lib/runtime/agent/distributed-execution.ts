export interface WorkerLease {
  workerId: string;
  sessionId: string;
  taskId: string;
  leasedAt: number;
  heartbeatAt: number;
}

export class DistributedExecutionCoordinator {
  private readonly leases = new Map<string, WorkerLease>();

  /**
   * Acquire a lease for a worker to execute a session task.
   * Returns the lease if successfully acquired, or null if already leased.
   */
  lease(workerId: string, sessionId: string, taskId: string): WorkerLease | null {
    const key = `${sessionId}:${taskId}`;
    const existing = this.leases.get(key);
    if (existing) {
      // If the existing lease belongs to the same worker, refresh it
      if (existing.workerId === workerId) {
        existing.heartbeatAt = Date.now();
        return existing;
      }
      return null;
    }

    const lease: WorkerLease = {
      workerId,
      sessionId,
      taskId,
      leasedAt: Date.now(),
      heartbeatAt: Date.now(),
    };
    this.leases.set(key, lease);
    return lease;
  }

  /**
   * Refresh the heartbeat timestamp of a leased task.
   */
  heartbeat(sessionId: string, taskId: string): WorkerLease | null {
    const key = `${sessionId}:${taskId}`;
    const lease = this.leases.get(key);
    if (!lease) return null;
    lease.heartbeatAt = Date.now();
    return lease;
  }

  /**
   * Release a task lease when completion or failure occurs.
   */
  release(sessionId: string, taskId: string): void {
    this.leases.delete(`${sessionId}:${taskId}`);
  }

  /**
   * Scan all active leases and recover (release) tasks that have timed out.
   * Calls the provided callback for each recovered task to reschedule it.
   */
  recoverTimedOutLeases(
    timeoutMs = 15_000,
    onRecover?: (sessionId: string, taskId: string) => void | Promise<void>
  ): string[] {
    const now = Date.now();
    const recovered: string[] = [];

    for (const [key, lease] of this.leases.entries()) {
      if (now - lease.heartbeatAt > timeoutMs) {
        this.leases.delete(key);
        recovered.push(key);
        if (onRecover) {
          void Promise.resolve(onRecover(lease.sessionId, lease.taskId)).catch((err) => {
            console.error('[DistributedCoordinator] Task recovery callback failed:', err);
          });
        }
      }
    }

    return recovered;
  }

  snapshot(): WorkerLease[] {
    return Array.from(this.leases.values()).sort((left, right) => left.leasedAt - right.leasedAt);
  }
}
