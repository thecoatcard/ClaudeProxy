/**
 * tests/orchestrator-enforcer.test.ts
 *
 * Unit tests for lib/agent/orchestrator-enforcer.ts
 */

// Mock Redis / subagent-memory before importing orchestrator
jest.mock('../lib/redis', () => ({
  redis: {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue(undefined),
    del: jest.fn().mockResolvedValue(undefined),
    sadd: jest.fn().mockResolvedValue(undefined),
    smembers: jest.fn().mockResolvedValue([]),
    expire: jest.fn().mockResolvedValue(undefined),
    srem: jest.fn().mockResolvedValue(undefined),
  },
}));

import { prepareOrchestration, finalizeOrchestration } from '../lib/agent/orchestrator-enforcer';

function makeBody(text: string) {
  return { model: 'claude-3-5-sonnet', messages: [{ role: 'user', content: text }] };
}

describe('prepareOrchestration', () => {
  beforeEach(() => {
    process.env.ENABLE_GATEWAY_ORCHESTRATOR = 'true';
  });

  afterEach(() => {
    delete process.env.ENABLE_GATEWAY_ORCHESTRATOR;
  });

  test('trivial task → orchestrator disabled, body unchanged', async () => {
    const body = makeBody('ping');
    const { ctx, enrichedBody } = await prepareOrchestration(body, 'user-1');
    expect(ctx.orchestratorEnabled).toBe(false);
    expect(ctx.systemPromptInjected).toBe(false);
    expect(enrichedBody).toBe(body);
  });

  test('normal task → orchestrator enabled', async () => {
    const body = makeBody('add a helper function');
    const { ctx } = await prepareOrchestration(body, 'user-1');
    expect(ctx.orchestratorEnabled).toBe(true);
    expect(ctx.systemPromptInjected).toBe(true);
  });

  test('multi-stage task → orchestrator enabled with multiple subagent tasks', async () => {
    const body = makeBody('build a full-stack app from scratch');
    const { ctx } = await prepareOrchestration(body, 'user-1');
    expect(ctx.orchestratorEnabled).toBe(true);
    expect(ctx.subagentTasks.length).toBeGreaterThan(1);
  });

  test('complex task → orchestrator enabled, subagent tasks include verifier', async () => {
    const body = makeBody('create a REST api endpoint');
    const { ctx } = await prepareOrchestration(body, 'user-1');
    expect(ctx.orchestratorEnabled).toBe(true);
    const models = ctx.subagentTasks.map((t) => t.model);
    expect(models).toContain('gemma-4-31b-it'); // reasoning planner
  });

  test('enriched body contains orchestrator system prompt injection', async () => {
    const body = makeBody('add authentication system');
    const { enrichedBody } = await prepareOrchestration(body, 'user-1');
    expect(typeof enrichedBody.system).toBe('string');
    expect((enrichedBody.system as string)).toContain('COORDINATOR');
  });

  test('existing system prompt is preserved and extended', async () => {
    const body = { ...makeBody('create dashboard'), system: 'You are a helpful AI.' };
    const { enrichedBody } = await prepareOrchestration(body, 'user-1');
    expect((enrichedBody.system as string)).toContain('You are a helpful AI.');
    expect((enrichedBody.system as string)).toContain('COORDINATOR');
  });

  test('explicit override "use subagents" → orchestrator enabled', async () => {
    const body = makeBody('use subagents for this task');
    const { ctx } = await prepareOrchestration(body, 'user-1');
    expect(ctx.orchestratorEnabled).toBe(true);
    expect(ctx.complexity.explicitOverride).toBe(true);
  });

  test('explicit override "parallelize" → orchestrator enabled', async () => {
    const body = makeBody('parallelize this build');
    const { ctx } = await prepareOrchestration(body, 'user-1');
    expect(ctx.orchestratorEnabled).toBe(true);
  });
});

describe('finalizeOrchestration', () => {
  beforeEach(() => {
    process.env.ENABLE_GATEWAY_ORCHESTRATOR = 'true';
  });

  afterEach(() => {
    delete process.env.ENABLE_GATEWAY_ORCHESTRATOR;
  });

  test('does not throw when orchestratorEnabled=false', async () => {
    const body = makeBody('ping');
    const { ctx } = await prepareOrchestration(body, 'user-1');
    await expect(finalizeOrchestration(ctx)).resolves.not.toThrow();
  });

  test('does not throw when orchestratorEnabled=true', async () => {
    const body = makeBody('build a full app');
    const { ctx } = await prepareOrchestration(body, 'user-1');
    await expect(finalizeOrchestration(ctx, ['output.ts'])).resolves.not.toThrow();
  });
});
