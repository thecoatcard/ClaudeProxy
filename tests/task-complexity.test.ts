/**
 * tests/task-complexity.test.ts
 *
 * Unit tests for lib/agent/task-complexity.ts
 */

import { classifyComplexity, requiresOrchestrator } from '../lib/agent/task-complexity';

function makeBody(text: string, toolCount = 0) {
  return {
    messages: [{ role: 'user', content: text }],
    tools: Array.from({ length: toolCount }, (_, i) => ({ name: `tool_${i}` })),
  };
}

describe('classifyComplexity', () => {
  // ── TRIVIAL ────────────────────────────────────────────────────────────────
  test('ping message → TRIVIAL', () => {
    const result = classifyComplexity(makeBody('ping'));
    expect(result.level).toBe('TRIVIAL');
    expect(result.orchestratorRequired).toBe(false);
  });

  test('simple hello → TRIVIAL', () => {
    const result = classifyComplexity(makeBody('hi'));
    expect(result.level).toBe('TRIVIAL');
  });

  test('quick fix request → TRIVIAL', () => {
    const result = classifyComplexity(makeBody('quick fix this typo'));
    expect(result.level).toBe('TRIVIAL');
  });

  // ── NORMAL ─────────────────────────────────────────────────────────────────
  test('small coding task → NORMAL', () => {
    const result = classifyComplexity(makeBody('add a helper function to utils.ts'));
    expect(result.level).toBe('NORMAL');
    expect(result.orchestratorRequired).toBe(true);
  });

  // ── COMPLEX ────────────────────────────────────────────────────────────────
  test('api keyword → COMPLEX', () => {
    const result = classifyComplexity(makeBody('add a REST api endpoint'));
    expect(result.level).toBe('COMPLEX');
    expect(result.orchestratorRequired).toBe(true);
  });

  test('high tool count (≥3) → COMPLEX', () => {
    const result = classifyComplexity(makeBody('do something', 3));
    expect(result.level).toBe('COMPLEX');
  });

  test('scaffold keyword → COMPLEX', () => {
    const result = classifyComplexity(makeBody('scaffold a new module'));
    expect(result.level).toBe('COMPLEX');
  });

  // ── MULTI_STAGE ────────────────────────────────────────────────────────────
  test('build app from scratch → MULTI_STAGE', () => {
    const result = classifyComplexity(makeBody('build a full-stack app from scratch'));
    expect(result.level).toBe('MULTI_STAGE');
    expect(result.orchestratorRequired).toBe(true);
  });

  test('dashboard keyword → MULTI_STAGE', () => {
    const result = classifyComplexity(makeBody('create a dashboard'));
    expect(result.level).toBe('MULTI_STAGE');
  });

  test('auth system → MULTI_STAGE', () => {
    const result = classifyComplexity(makeBody('add authentication to my app'));
    expect(result.level).toBe('MULTI_STAGE');
  });

  test('refactor → MULTI_STAGE', () => {
    const result = classifyComplexity(makeBody('refactor the entire codebase'));
    expect(result.level).toBe('MULTI_STAGE');
  });

  // ── Explicit override ──────────────────────────────────────────────────────
  test('"use subagents" → MULTI_STAGE with explicitOverride', () => {
    const result = classifyComplexity(makeBody('use subagents for this'));
    expect(result.level).toBe('MULTI_STAGE');
    expect(result.explicitOverride).toBe(true);
    expect(result.orchestratorRequired).toBe(true);
  });

  test('"switch to orchestrator" → MULTI_STAGE with explicitOverride', () => {
    const result = classifyComplexity(makeBody('switch to orchestrator mode'));
    expect(result.level).toBe('MULTI_STAGE');
    expect(result.explicitOverride).toBe(true);
  });

  test('"parallelize" → MULTI_STAGE with explicitOverride', () => {
    const result = classifyComplexity(makeBody('parallelize this task'));
    expect(result.level).toBe('MULTI_STAGE');
    expect(result.explicitOverride).toBe(true);
  });

  test('"delegate" → MULTI_STAGE with explicitOverride', () => {
    const result = classifyComplexity(makeBody('delegate this to subagents'));
    expect(result.level).toBe('MULTI_STAGE');
    expect(result.explicitOverride).toBe(true);
  });

  // ── requiresOrchestrator ───────────────────────────────────────────────────
  test('requiresOrchestrator returns false for TRIVIAL', () => {
    expect(requiresOrchestrator(makeBody('ping'))).toBe(false);
  });

  test('requiresOrchestrator returns true for NORMAL', () => {
    expect(requiresOrchestrator(makeBody('add a function'))).toBe(true);
  });

  test('requiresOrchestrator returns true for COMPLEX', () => {
    expect(requiresOrchestrator(makeBody('build an api endpoint'))).toBe(true);
  });

  test('requiresOrchestrator returns true for MULTI_STAGE', () => {
    expect(requiresOrchestrator(makeBody('create a full-stack app'))).toBe(true);
  });
});
