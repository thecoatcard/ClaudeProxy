import { RuntimeCostOptimizer } from '@/lib/runtime/agent/cost-optimizer';
import { DistributedExecutionCoordinator } from '@/lib/runtime/agent/distributed-execution';
import { RuntimeEventBus } from '@/lib/runtime/agent/event-bus';
import { McpRuntime } from '@/lib/runtime/agent/mcp-runtime';
import { RuntimePluginRegistry } from '@/lib/runtime/agent/plugin-sdk';

describe('agent runtime platform capabilities', () => {
  it('supports events, plugins, mcp, worker leases, and cost optimization', async () => {
    const bus = new RuntimeEventBus();
    const received: string[] = [];
    bus.on('*', (event) => {
      received.push(event.type);
    });
    await bus.emit('TaskStarted', { taskId: 'repository-analysis' }, 'session-1');
    expect(received).toEqual(['TaskStarted']);

    const plugins = new RuntimePluginRegistry();
    const lifecycle: string[] = [];
    plugins.register({
      manifest: { name: 'demo', version: '1.0.0', permissions: ['mcp'] },
      activate() { lifecycle.push('activate'); },
      deactivate() { lifecycle.push('deactivate'); },
    });
    await plugins.activateAll();
    await plugins.deactivateAll();
    expect(plugins.list()).toHaveLength(1);
    expect(lifecycle).toEqual(['activate', 'deactivate']);

    const mcp = new McpRuntime();
    mcp.registerTool({ name: 'echo', description: 'echo', handler: async (input) => input.value });
    mcp.registerResource({ uri: 'memory://plan', loader: async () => ({ ok: true }) });
    mcp.registerPrompt({ name: 'summary', render: async () => 'runtime summary' });
    await expect(mcp.invokeTool('echo', { value: 'hello' })).resolves.toBe('hello');
    await expect(mcp.readResource('memory://plan')).resolves.toEqual({ ok: true });
    await expect(mcp.renderPrompt('summary', {})).resolves.toBe('runtime summary');

    const distributed = new DistributedExecutionCoordinator();
    expect(distributed.lease('worker-1', 'session-1', 'task-1')).not.toBeNull();
    expect(distributed.heartbeat('session-1', 'task-1')?.workerId).toBe('worker-1');
    distributed.release('session-1', 'task-1');
    expect(distributed.snapshot()).toHaveLength(0);

    const optimizer = new RuntimeCostOptimizer();
    const decision = optimizer.decide({
      summary: 'runtime summary',
      selectedFiles: ['lib/runtime/agent/runtime.ts'],
      rankedItems: [],
      repositoryFacts: [],
      toolSummary: [],
      memorySummary: [],
      tokenBudget: 7000,
    });
    expect(decision.contextPressure).toBe('high');
    expect(decision.recommendedMode).toBe('compact');
  });
});
