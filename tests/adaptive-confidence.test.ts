/**
 * tests/adaptive-confidence.test.ts
 *
 * Tests for adaptive confidence thresholding.
 */

import { computeAdaptiveThreshold } from '@/lib/memory/retrieval-pipeline';

describe('computeAdaptiveThreshold', () => {
  test('returns lower threshold for 1-word queries', () => {
    const t = computeAdaptiveThreshold('auth');
    expect(t).toBe(0.2);
  });

  test('returns lower threshold for 2-word queries', () => {
    const t = computeAdaptiveThreshold('fix auth');
    expect(t).toBe(0.2);
  });

  test('returns lower threshold for 3-word queries', () => {
    const t = computeAdaptiveThreshold('fix auth bug');
    expect(t).toBe(0.2);
  });

  test('returns higher threshold for camelCase identifiers', () => {
    const t = computeAdaptiveThreshold('the handleSubmit function in the form');
    expect(t).toBe(0.4);
  });

  test('returns higher threshold for file path patterns', () => {
    const t = computeAdaptiveThreshold('what does /lib/auth.ts do in the project');
    expect(t).toBe(0.4);
  });

  test('returns higher threshold for function call patterns', () => {
    const t = computeAdaptiveThreshold('where is getUser() called from in the codebase');
    expect(t).toBe(0.4);
  });

  test('returns higher threshold for snake_case identifiers', () => {
    const t = computeAdaptiveThreshold('find the user_session variable usage');
    expect(t).toBe(0.4);
  });

  test('returns moderate threshold for error-related queries', () => {
    const t = computeAdaptiveThreshold('there is an error when starting the server');
    expect(t).toBe(0.35);
  });

  test('returns 0.3 for long general queries', () => {
    const t = computeAdaptiveThreshold('explain the overall system and how all the pieces interact with each other in general');
    expect(t).toBe(0.3);
  });

  test('handles empty string', () => {
    const t = computeAdaptiveThreshold('');
    expect(t).toBe(0.2);
  });

  test('threshold is always between 0.2 and 0.4', () => {
    const queries = [
      'x',
      'fix the build',
      'handleClick in Button component',
      'error when deploying to production environment',
      'explain the entire project architecture and design decisions made over the past year',
    ];
    for (const q of queries) {
      const t = computeAdaptiveThreshold(q);
      expect(t).toBeGreaterThanOrEqual(0.2);
      expect(t).toBeLessThanOrEqual(0.4);
    }
  });
});
