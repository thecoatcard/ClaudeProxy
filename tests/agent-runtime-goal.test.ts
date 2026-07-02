import { GoalUnderstandingService } from '@/lib/runtime/agent/goal-understanding';

describe('agent runtime goal understanding', () => {
  it('extracts the user objective and required tools', () => {
    const service = new GoalUnderstandingService();
    const goal = service.understand({
      messages: [{ role: 'user', content: 'Refactor this repository and run tests.' }],
    });

    expect(goal.objective).toContain('Refactor this repository');
    expect(goal.requiredTools).toContain('shell');
    expect(goal.requiredTools).toContain('filesystem');
  });
});
