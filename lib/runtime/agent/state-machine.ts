import type { AgentSessionStatus, RuntimeLifecycleState } from './contracts';

const transitions: Record<RuntimeLifecycleState, readonly RuntimeLifecycleState[]> = {
  Idle: ['Initializing', 'Cancelled'],
  Initializing: ['Planning', 'Recovering', 'Cancelled', 'Failed'],
  Planning: ['Executing', 'Waiting Approval', 'Retrying', 'Recovering', 'Cancelled', 'Failed'],
  Executing: ['Waiting Tool', 'Waiting Approval', 'Reflecting', 'Retrying', 'Recovering', 'Cancelled', 'Failed'],
  'Waiting Approval': ['Executing', 'Cancelled', 'Failed'],
  'Waiting Tool': ['Waiting Approval', 'Executing', 'Retrying', 'Recovering', 'Cancelled', 'Failed'],
  Reflecting: ['Planning', 'Retrying', 'Completed', 'Failed', 'Cancelled'],
  Retrying: ['Planning', 'Executing', 'Recovering', 'Cancelled', 'Failed'],
  Recovering: ['Planning', 'Executing', 'Failed', 'Cancelled'],
  Completed: [],
  Failed: ['Recovering'],
  Cancelled: [],
};

export const canTransitionRuntimeState = (from: RuntimeLifecycleState, to: RuntimeLifecycleState) => transitions[from].includes(to);

export function assertRuntimeTransition(from: RuntimeLifecycleState, to: RuntimeLifecycleState) {
  if (!canTransitionRuntimeState(from, to)) {
    throw new Error(`Invalid runtime transition: ${from} -> ${to}`);
  }
}

export function statusForRuntimeState(state: RuntimeLifecycleState): AgentSessionStatus {
  switch (state) {
    case 'Idle':
      return 'CREATED';
    case 'Initializing':
    case 'Planning':
      return 'ANALYZING';
    case 'Executing':
    case 'Waiting Approval':
    case 'Waiting Tool':
    case 'Retrying':
    case 'Recovering':
      return 'RUNNING';
    case 'Reflecting':
      return 'VALIDATING';
    case 'Completed':
      return 'COMPLETED';
    case 'Failed':
      return 'FAILED';
    case 'Cancelled':
      return 'CANCELLED';
  }
}
