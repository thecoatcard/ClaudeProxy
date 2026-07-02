import { assertRuntimeTransition, canTransitionRuntimeState, statusForRuntimeState } from '@/lib/runtime/agent/state-machine';

describe('agent runtime state machine', () => {
  it('allows only valid transitions', () => {
    expect(canTransitionRuntimeState('Idle', 'Initializing')).toBe(true);
    expect(canTransitionRuntimeState('Completed', 'Executing')).toBe(false);
  });

  it('throws on invalid transition assertions', () => {
    expect(() => assertRuntimeTransition('Completed', 'Executing')).toThrow('Invalid runtime transition: Completed -> Executing');
  });

  it('maps runtime states to persisted session statuses', () => {
    expect(statusForRuntimeState('Planning')).toBe('ANALYZING');
    expect(statusForRuntimeState('Executing')).toBe('RUNNING');
    expect(statusForRuntimeState('Reflecting')).toBe('VALIDATING');
    expect(statusForRuntimeState('Completed')).toBe('COMPLETED');
  });
});
