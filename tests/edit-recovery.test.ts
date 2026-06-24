/**
 * tests/edit-recovery.test.ts
 *
 * Phase 9 tests — edit recovery strategy guidance (Phases 3, 4, 5):
 *   - REREAD_AND_RETRY on first failure
 *   - WRITE_FALLBACK on second failure
 *   - ESCALATE on third+ failure
 *   - Large patch granularity hint (Phase 5)
 *   - Write fallback hint content (Phase 4)
 */

import {
  buildEditRecoveryGuidance,
  buildWriteFallbackHint,
  checkPatchGranularity,
  LARGE_PATCH_THRESHOLD,
} from '../lib/tools/edit-recovery';

// ── buildEditRecoveryGuidance ─────────────────────────────────────────────────

describe('buildEditRecoveryGuidance — first failure (attempt 1)', () => {
  test('returns REREAD_AND_RETRY step', () => {
    const r = buildEditRecoveryGuidance(1, 'EXACT_MATCH_FAILURE', '/src/app.ts');
    expect(r.step).toBe('REREAD_AND_RETRY');
  });

  test('guidance contains EDIT_RECOVERY marker', () => {
    const r = buildEditRecoveryGuidance(1, 'EXACT_MATCH_FAILURE', '/src/app.ts');
    expect(r.guidance).toContain('[EDIT_RECOVERY]');
  });

  test('guidance mentions re-read step', () => {
    const r = buildEditRecoveryGuidance(1, 'EXACT_MATCH_FAILURE', '/src/app.ts');
    expect(r.guidance).toContain('Re-read');
  });

  test('guidance mentions max 2 retries', () => {
    const r = buildEditRecoveryGuidance(1, 'EXACT_MATCH_FAILURE', '/src/app.ts');
    expect(r.guidance).toContain('Max 2');
  });

  test('guidance contains file path reference', () => {
    const r = buildEditRecoveryGuidance(1, 'EXACT_MATCH_FAILURE', '/src/app.ts');
    expect(r.guidance).toContain('app.ts');
  });

  test('WHITESPACE_MISMATCH — guidance mentions indentation', () => {
    const r = buildEditRecoveryGuidance(1, 'WHITESPACE_MISMATCH', '/a.ts');
    expect(r.guidance).toContain('indentation');
  });

  test('MULTIPLE_MATCHES — guidance mentions context lines', () => {
    const r = buildEditRecoveryGuidance(1, 'MULTIPLE_MATCHES', '/a.ts');
    expect(r.guidance).toContain('context');
  });

  test('FILE_CHANGED — guidance mentions re-read', () => {
    const r = buildEditRecoveryGuidance(1, 'FILE_CHANGED', '/a.ts');
    expect(r.guidance).toContain('Re-read');
  });

  test('null filePath — uses generic file reference', () => {
    const r = buildEditRecoveryGuidance(1, 'EXACT_MATCH_FAILURE', null);
    expect(r.guidance).toContain('the file');
  });
});

describe('buildEditRecoveryGuidance — second failure (attempt 2)', () => {
  test('returns WRITE_FALLBACK step', () => {
    const r = buildEditRecoveryGuidance(2, 'EXACT_MATCH_FAILURE', '/src/app.ts');
    expect(r.step).toBe('WRITE_FALLBACK');
  });

  test('guidance contains write instruction', () => {
    const r = buildEditRecoveryGuidance(2, 'EXACT_MATCH_FAILURE', '/src/app.ts');
    expect(r.guidance).toContain('Write');
  });

  test('guidance says "failed twice"', () => {
    const r = buildEditRecoveryGuidance(2, 'WHITESPACE_MISMATCH', '/src/app.ts');
    expect(r.guidance).toContain('twice');
  });

  test('guidance prohibits third attempt', () => {
    const r = buildEditRecoveryGuidance(2, 'EXACT_MATCH_FAILURE', '/src/app.ts');
    expect(r.guidance).toContain('third');
  });
});

describe('buildEditRecoveryGuidance — third failure (attempt 3)', () => {
  test('returns ESCALATE step', () => {
    const r = buildEditRecoveryGuidance(3, 'EXACT_MATCH_FAILURE', '/src/app.ts');
    expect(r.step).toBe('ESCALATE');
  });

  test('guidance contains MANDATORY marker', () => {
    const r = buildEditRecoveryGuidance(3, 'UNKNOWN', '/src/app.ts');
    expect(r.guidance).toContain('MANDATORY');
  });

  test('guidance prohibits retry', () => {
    const r = buildEditRecoveryGuidance(3, 'UNKNOWN', '/src/app.ts');
    expect(r.guidance).toContain('DO NOT retry');
  });

  test('attempt 4+ also returns ESCALATE', () => {
    const r = buildEditRecoveryGuidance(5, 'EXACT_MATCH_FAILURE', '/src/app.ts');
    expect(r.step).toBe('ESCALATE');
    expect(r.guidance).toContain('MANDATORY');
  });
});

describe('buildEditRecoveryGuidance — large patch (Phase 5)', () => {
  const largePatch = LARGE_PATCH_THRESHOLD + 1;

  test('large patch triggers granularity guidance on attempt 1', () => {
    const r = buildEditRecoveryGuidance(1, 'EXACT_MATCH_FAILURE', '/src/app.ts', largePatch);
    expect(r.step).toBe('REREAD_AND_RETRY');
    expect(r.guidance).toContain('Large patch');
  });

  test('guidance mentions split into smaller hunks', () => {
    const r = buildEditRecoveryGuidance(1, 'EXACT_MATCH_FAILURE', '/src/app.ts', largePatch);
    expect(r.guidance).toContain('Split');
  });

  test('small patch does not trigger granularity hint', () => {
    const r = buildEditRecoveryGuidance(1, 'EXACT_MATCH_FAILURE', '/src/app.ts', 100);
    expect(r.guidance).not.toContain('Large patch');
  });
});

// ── buildWriteFallbackHint ────────────────────────────────────────────────────

describe('buildWriteFallbackHint', () => {
  test('contains EDIT_RECOVERY marker', () => {
    const hint = buildWriteFallbackHint('`app.ts`', 'EXACT_MATCH_FAILURE');
    expect(hint).toContain('[EDIT_RECOVERY]');
  });

  test('mentions Write strategy', () => {
    const hint = buildWriteFallbackHint('`app.ts`', 'WHITESPACE_MISMATCH');
    expect(hint).toContain('Write');
  });

  test('prohibits third attempt', () => {
    const hint = buildWriteFallbackHint('`app.ts`', 'EXACT_MATCH_FAILURE');
    expect(hint).toContain('third');
  });
});

// ── checkPatchGranularity ─────────────────────────────────────────────────────

describe('checkPatchGranularity (Phase 5)', () => {
  test('empty string when below threshold', () => {
    expect(checkPatchGranularity(100)).toBe('');
  });

  test('empty string at exact threshold', () => {
    expect(checkPatchGranularity(LARGE_PATCH_THRESHOLD)).toBe('');
  });

  test('guidance string when above threshold', () => {
    const result = checkPatchGranularity(LARGE_PATCH_THRESHOLD + 1);
    expect(result).toContain('Large patch');
    expect(result).toContain('Split');
  });

  test('guidance includes char count', () => {
    const result = checkPatchGranularity(600);
    expect(result).toContain('600');
  });
});
