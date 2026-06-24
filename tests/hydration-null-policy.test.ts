/**
 * tests/hydration-null-policy.test.ts
 *
 * Unit tests for Phase 3 — Safe Null Workspace Policy.
 *
 * Key behaviour: when BOTH workspace roots are null/undefined,
 * evaluateHydration() must deny hydration (unless hasExplicitConversationId is true).
 */

import {
  evaluateHydration,
  evaluateHydrationForEstablishedSession,
} from '../lib/context/hydration-guard';

const TWO_MESSAGES = [
  { role: 'user', content: 'Previous message' },
  { role: 'user', content: 'Continue the work' },
];

const SINGLE_MESSAGE = [
  { role: 'user', content: 'Hello!' },
];

describe('Phase 3 — Null Workspace Policy (evaluateHydration)', () => {
  it('denies hydration when both workspace roots are null (anonymous session)', () => {
    const verdict = evaluateHydration({
      messages: TWO_MESSAGES,
      conversationId: 'anon-abc',
      currentWorkspaceRoot: null,
      storedWorkspaceRoot: null,
      hasExplicitConversationId: false,
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe('HYDRATION_SKIPPED_NULL_WORKSPACE');
  });

  it('denies hydration when both workspace roots are undefined (anonymous session)', () => {
    const verdict = evaluateHydration({
      messages: TWO_MESSAGES,
      conversationId: 'anon-abc',
      currentWorkspaceRoot: undefined,
      storedWorkspaceRoot: undefined,
      hasExplicitConversationId: false,
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe('HYDRATION_SKIPPED_NULL_WORKSPACE');
  });

  it('allows hydration when both workspace roots are null but session is explicit', () => {
    const verdict = evaluateHydration({
      messages: TWO_MESSAGES,
      conversationId: 'explicit-session-abc',
      currentWorkspaceRoot: null,
      storedWorkspaceRoot: null,
      hasExplicitConversationId: true,
    });
    // Should pass null-workspace gate (explicit ID is trusted).
    // May still fail semantic continuity gate for short histories.
    // We only assert it did NOT fail with HYDRATION_SKIPPED_NULL_WORKSPACE.
    expect(verdict.reason).not.toBe('HYDRATION_SKIPPED_NULL_WORKSPACE');
  });

  it('allows hydration when current workspace is known but stored is null', () => {
    const verdict = evaluateHydration({
      messages: TWO_MESSAGES,
      conversationId: 'anon-abc',
      currentWorkspaceRoot: '/home/user/project',
      storedWorkspaceRoot: null,
      hasExplicitConversationId: false,
    });
    // One-known, one-null is a pass on the workspace gate
    expect(verdict.reason).not.toBe('HYDRATION_SKIPPED_NULL_WORKSPACE');
    expect(verdict.reason).not.toBe('HYDRATION_SKIPPED_WORKSPACE_MISMATCH');
  });

  it('denies hydration when workspaces are different (both known)', () => {
    const verdict = evaluateHydration({
      messages: TWO_MESSAGES,
      conversationId: 'anon-abc',
      currentWorkspaceRoot: '/home/user/project-A',
      storedWorkspaceRoot: '/home/user/project-B',
      hasExplicitConversationId: false,
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe('HYDRATION_SKIPPED_WORKSPACE_MISMATCH');
  });

  it('allows hydration when workspaces match and session is multi-turn', () => {
    const messages = [
      ...TWO_MESSAGES,
      { role: 'assistant', content: 'Let me check that.' },
      { role: 'user', content: 'Please look at the previous task result' },
    ];
    const verdict = evaluateHydration({
      messages,
      conversationId: 'anon-abc',
      currentWorkspaceRoot: '/home/user/project',
      storedWorkspaceRoot: '/home/user/project',
      hasExplicitConversationId: false,
    });
    expect(verdict.allow).toBe(true);
    expect(verdict.reason).toBe('HYDRATION_APPROVED');
  });

  it('denies on /clear reset even when workspaces match', () => {
    const messages = [
      { role: 'user', content: '/clear' },
      { role: 'user', content: 'Fresh start' },
    ];
    const verdict = evaluateHydration({
      messages,
      conversationId: 'anon-abc',
      currentWorkspaceRoot: '/home/user/project',
      storedWorkspaceRoot: '/home/user/project',
      hasExplicitConversationId: false,
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe('HYDRATION_SKIPPED_CLEAR_RESET');
  });

  it('denies on session binding mismatch', () => {
    const verdict = evaluateHydration({
      messages: TWO_MESSAGES,
      conversationId: 'anon-abc',
      currentWorkspaceRoot: '/home/user/project',
      storedWorkspaceRoot: '/home/user/project',
      hasExplicitConversationId: false,
      sessionBindingStatus: 'mismatch',
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe('HYDRATION_SKIPPED_BINDING_MISMATCH');
  });

  it('passes binding gate when status is "valid"', () => {
    const messages = [
      ...TWO_MESSAGES,
      { role: 'assistant', content: 'Working on it.' },
      { role: 'user', content: 'Continue from the previous result' },
    ];
    const verdict = evaluateHydration({
      messages,
      conversationId: 'anon-abc',
      currentWorkspaceRoot: '/home/user/project',
      storedWorkspaceRoot: '/home/user/project',
      hasExplicitConversationId: false,
      sessionBindingStatus: 'valid',
    });
    expect(verdict.allow).toBe(true);
  });
});

describe('Phase 3 — evaluateHydrationForEstablishedSession', () => {
  it('allows hydration when both workspace roots are null (established session)', () => {
    // Established sessions (compacted marker present) have proven continuity —
    // null-null workspace is acceptable.
    const verdict = evaluateHydrationForEstablishedSession({
      messages: TWO_MESSAGES,
      conversationId: 'some-session',
      currentWorkspaceRoot: null,
      storedWorkspaceRoot: null,
    });
    // Should NOT deny because of null workspace for established sessions
    expect(verdict.reason).not.toBe('HYDRATION_SKIPPED_NULL_WORKSPACE');
  });

  it('denies on clear reset', () => {
    const verdict = evaluateHydrationForEstablishedSession({
      messages: [{ role: 'user', content: '/clear' }],
      conversationId: 'some-session',
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe('HYDRATION_SKIPPED_CLEAR_RESET');
  });

  it('denies on workspace mismatch in established session', () => {
    const verdict = evaluateHydrationForEstablishedSession({
      messages: TWO_MESSAGES,
      conversationId: 'some-session',
      currentWorkspaceRoot: '/home/user/project-A',
      storedWorkspaceRoot: '/home/user/project-B',
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe('HYDRATION_SKIPPED_WORKSPACE_MISMATCH');
  });

  it('denies on binding mismatch in established session', () => {
    const verdict = evaluateHydrationForEstablishedSession({
      messages: TWO_MESSAGES,
      conversationId: 'some-session',
      sessionBindingStatus: 'mismatch',
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe('HYDRATION_SKIPPED_BINDING_MISMATCH');
  });
});
