/**
 * tests/context-isolation.test.ts
 *
 * Validates that the hydration guard correctly gates compacted memory, rolling
 * summaries, and operational state injection based on:
 *   - workspace boundary
 *   - /clear detection
 *   - semantic continuity
 *   - session freshness
 *
 * Key scenario guarded: Claude Code restores full local conversation history
 * across terminal restarts. A "new" session can arrive with 20+ old messages.
 * The workspace boundary gate must catch cross-workspace leakage regardless
 * of message count.
 */

import {
  evaluateHydration,
  evaluateHydrationForEstablishedSession,
  extractWorkspaceRootFromSystem,
  extractWorkspaceRootFromMessages,
  messagesContainCompactedMarker,
} from '../lib/context/hydration-guard';

// ─── Helpers ──────────────────────────────────────────────────────────────────

function userMsg(text: string) {
  return { role: 'user', content: text };
}

function assistantMsg(text: string) {
  return { role: 'assistant', content: text };
}

/** Simulates a Claude Code user message with <environment_details> injected. */
function claudeCodeMsg(userText: string, workspacePath: string) {
  return {
    role: 'user',
    content: `<environment_details>\n<workspacePath>${workspacePath}</workspacePath>\n<cwd>${workspacePath}</cwd>\n</environment_details>\n${userText}`,
  };
}

function compactedMsg() {
  return {
    role: 'assistant',
    content: '<!-- compacted:v2 -->\n[COMPACTED RANGE]\nrange_id:1-5-abc123\n[/COMPACTED RANGE]\n[COMPACTED MEMORY BLOCK]\nGoal: Build API\n[/COMPACTED MEMORY BLOCK]',
  };
}

const BASE_CTX = {
  conversationId: 'conv-test-001',
  currentWorkspaceRoot: null,
  storedWorkspaceRoot: null,
};

// ─── Test 1: New workspace — no hydration ─────────────────────────────────────

describe('context-isolation', () => {
  test('1. new workspace with stored workspace → blocks hydration', () => {
    const verdict = evaluateHydration({
      ...BASE_CTX,
      messages: [userMsg('hi')],
      currentWorkspaceRoot: '/home/user/projectA',
      storedWorkspaceRoot: '/home/user/projectB',
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe('HYDRATION_SKIPPED_WORKSPACE_MISMATCH');
  });

  // ─── Test 2: Same workspace, continue → hydrates ───────────────────────────

  test('2. same workspace with continuation signal → allows hydration', () => {
    const verdict = evaluateHydration({
      ...BASE_CTX,
      messages: [userMsg('continue the migration task')],
      currentWorkspaceRoot: '/home/user/projectA',
      storedWorkspaceRoot: '/home/user/projectA',
    });
    expect(verdict.allow).toBe(true);
    expect(verdict.reason).toBe('HYDRATION_APPROVED');
  });

  // ─── Test 3: /clear detection → blocks hydration ──────────────────────────

  test('3. /clear in messages → blocks hydration', () => {
    const verdict = evaluateHydration({
      ...BASE_CTX,
      messages: [
        userMsg('help me with the API'),
        assistantMsg('sure'),
        userMsg('/clear'),
        userMsg('hi'),
      ],
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe('HYDRATION_SKIPPED_CLEAR_RESET');
  });

  // ─── Test 4: "hi" alone → blocks hydration ────────────────────────────────

  test('4. trivial greeting "hi" → blocks hydration (low continuity)', () => {
    const verdict = evaluateHydration({
      ...BASE_CTX,
      messages: [userMsg('hi')],
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe('HYDRATION_SKIPPED_LOW_CONTINUITY');
  });

  test('4b. trivial greeting "hello" → blocks hydration', () => {
    const verdict = evaluateHydration({
      ...BASE_CTX,
      messages: [userMsg('hello')],
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe('HYDRATION_SKIPPED_LOW_CONTINUITY');
  });

  // ─── Test 5: "continue" → hydrates ───────────────────────────────────────

  test('5. "continue" → allows hydration', () => {
    const verdict = evaluateHydration({
      ...BASE_CTX,
      messages: [userMsg('continue')],
    });
    expect(verdict.allow).toBe(true);
    expect(verdict.reason).toBe('HYDRATION_APPROVED');
  });

  test('5b. "resume the previous task" → allows hydration', () => {
    const verdict = evaluateHydration({
      ...BASE_CTX,
      messages: [userMsg('resume the previous task')],
    });
    expect(verdict.allow).toBe(true);
    expect(verdict.reason).toBe('HYDRATION_APPROVED');
  });

  // ─── Test 6: Unrelated task → blocks hydration ───────────────────────────

  test('6. unrelated new task without context → blocks hydration', () => {
    // A single brand-new short message that isn't a continuation
    const verdict = evaluateHydration({
      ...BASE_CTX,
      messages: [userMsg('hey')],
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe('HYDRATION_SKIPPED_LOW_CONTINUITY');
  });

  // ─── Test 7: Established session with markers → uses lighter gate ─────────

  test('7. established session (has compacted markers) + same workspace → approved', () => {
    const verdict = evaluateHydrationForEstablishedSession({
      ...BASE_CTX,
      messages: [compactedMsg(), userMsg('finish the refactor')],
      currentWorkspaceRoot: '/home/user/project',
      storedWorkspaceRoot: '/home/user/project',
    });
    expect(verdict.allow).toBe(true);
    expect(verdict.reason).toBe('HYDRATION_APPROVED');
  });

  test('7b. established session + /clear → still blocked', () => {
    const verdict = evaluateHydrationForEstablishedSession({
      ...BASE_CTX,
      messages: [compactedMsg(), userMsg('/clear'), userMsg('start fresh')],
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe('HYDRATION_SKIPPED_CLEAR_RESET');
  });

  test('7c. established session + workspace mismatch → blocked', () => {
    const verdict = evaluateHydrationForEstablishedSession({
      ...BASE_CTX,
      messages: [compactedMsg(), userMsg('continue')],
      currentWorkspaceRoot: '/home/user/newProject',
      storedWorkspaceRoot: '/home/user/oldProject',
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe('HYDRATION_SKIPPED_WORKSPACE_MISMATCH');
  });

  // ─── Test 8: messagesContainCompactedMarker ───────────────────────────────

  test('8. detects v2 compacted marker in messages', () => {
    expect(messagesContainCompactedMarker([compactedMsg()])).toBe(true);
  });

  test('8b. detects v1 compacted marker in messages', () => {
    const msg = { role: 'assistant', content: '<!-- compacted:v1 --> some summary' };
    expect(messagesContainCompactedMarker([msg])).toBe(true);
  });

  test('8c. no marker → returns false', () => {
    expect(messagesContainCompactedMarker([userMsg('hello'), assistantMsg('hi there')])).toBe(false);
  });

  // ─── Test 9: extractWorkspaceRootFromSystem ───────────────────────────────

  test('9. extracts workspacePath from Claude Code environment_details (system)', () => {
    const system = '<environment_details><workspacePath>/Users/dev/myproject</workspacePath></environment_details>';
    expect(extractWorkspaceRootFromSystem(system)).toBe('/Users/dev/myproject');
  });

  test('9b. extracts Cwd field from system text', () => {
    const system = 'You are a coding assistant.\nCwd: /home/user/project';
    expect(extractWorkspaceRootFromSystem(system)).toBe('/home/user/project');
  });

  test('9c. returns null when no workspace info in system', () => {
    expect(extractWorkspaceRootFromSystem('You are a helpful assistant.')).toBeNull();
  });

  test('9d. extracts workspace from "Current Working Directory" header', () => {
    const system = '# Current Working Directory (/Users/dev/projectA) Files\nfile.ts';
    expect(extractWorkspaceRootFromSystem(system)).toBe('/Users/dev/projectA');
  });

  // ─── Test 9e–9g: extractWorkspaceRootFromMessages ────────────────────────

  test('9e. extracts workspacePath from Claude Code user message', () => {
    const messages = [claudeCodeMsg('hi', '/Users/dev/TrainAi/library')];
    expect(extractWorkspaceRootFromMessages(messages)).toBe('/Users/dev/TrainAi/library');
  });

  test('9f. extracts workspacePath from <cwd> tag in user message', () => {
    const messages = [{
      role: 'user',
      content: '<environment_details>\n<cwd>C:\\Users\\Dev\\myproject</cwd>\n</environment_details>\nhello',
    }];
    expect(extractWorkspaceRootFromMessages(messages)).toBe('C:\\Users\\Dev\\myproject');
  });

  test('9g. extracts workspace from "Current Working Directory" in user message', () => {
    const messages = [{
      role: 'user',
      content: '# Current Working Directory (C:\\Users\\Dev\\app) Files\nfile.ts\nhello world',
    }];
    expect(extractWorkspaceRootFromMessages(messages)).toBe('C:\\Users\\Dev\\app');
  });

  test('9h. returns null when no workspace in messages', () => {
    expect(extractWorkspaceRootFromMessages([userMsg('hello')])).toBeNull();
  });

  // ─── Test 10: Windows path normalisation ──────────────────────────────────

  test('10. same Windows path with different case/slash → workspace matches', () => {
    const verdict = evaluateHydration({
      ...BASE_CTX,
      messages: [userMsg('continue where we left off')],
      currentWorkspaceRoot: 'C:\\Users\\Dev\\ProjectA',
      storedWorkspaceRoot: 'c:/users/dev/projecta',
    });
    expect(verdict.allow).toBe(true);
    expect(verdict.reason).toBe('HYDRATION_APPROVED');
  });

  // ─── Test 11: Multi-turn session with same workspace → approved ───────────

  test('11. multi-turn session with same workspace → approved', () => {
    const verdict = evaluateHydration({
      ...BASE_CTX,
      messages: [
        claudeCodeMsg('Let\'s build an API', '/home/user/projectA'),
        assistantMsg('Sure, what endpoints?'),
        claudeCodeMsg('GET /users', '/home/user/projectA'),
        assistantMsg('Got it.'),
        claudeCodeMsg('yes please', '/home/user/projectA'),
      ],
      currentWorkspaceRoot: '/home/user/projectA',
      storedWorkspaceRoot: '/home/user/projectA',
    });
    expect(verdict.allow).toBe(true);
    expect(verdict.reason).toBe('HYDRATION_APPROVED');
  });

  // ─── Test 12: Unknown workspace roots → pass gate ────────────────────────

  test('12. unknown workspace roots (both null) → does not block', () => {
    const verdict = evaluateHydration({
      ...BASE_CTX,
      messages: [userMsg('continue the task')],
      currentWorkspaceRoot: null,
      storedWorkspaceRoot: null,
    });
    expect(verdict.allow).toBe(true);
  });

  // ─── CRITICAL: Test 13 — The exact failure scenario from the bug report ───
  // Claude Code restores conversation history. User types "hi" in a NEW
  // terminal at a DIFFERENT workspace (TrainAi/library). Gateway receives
  // 20+ messages from the old TrainAi session + a new "hi". Old context
  // must be BLOCKED.

  test('13. CRITICAL: old conversation history + "hi" in different workspace → blocks hydration', () => {
    // Simulates the exact bug: Claude Code sent 20 old messages from TrainAi
    // session plus a new "hi" from TrainAi/library.
    const oldSessionMessages = [
      claudeCodeMsg('Let\'s create the stress-test-lab directory', 'C:\\Users\\Dev\\TrainAi'),
      assistantMsg('Creating the directory...'),
      claudeCodeMsg('add sub-directories: logs, src, docs', 'C:\\Users\\Dev\\TrainAi'),
      assistantMsg('Done. Directories created.'),
      claudeCodeMsg('now create the config files', 'C:\\Users\\Dev\\TrainAi'),
      assistantMsg('Created config files.'),
    ];
    const newHiMessage = claudeCodeMsg('hi', 'C:\\Users\\Dev\\TrainAi\\library');

    const verdict = evaluateHydration({
      ...BASE_CTX,
      conversationId: 'stable-claude-session-id',
      messages: [...oldSessionMessages, newHiMessage],
      currentWorkspaceRoot: 'C:\\Users\\Dev\\TrainAi\\library',  // extracted from new "hi" message
      storedWorkspaceRoot:  'C:\\Users\\Dev\\TrainAi',           // stored from old session
    });

    // TrainAi ≠ TrainAi\library (different path depth) → must block
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe('HYDRATION_SKIPPED_WORKSPACE_MISMATCH');
  });

  test('13b. old conversation history + "hi" same workspace → allows hydration', () => {
    // Same workspace → should allow (legitimate continuation)
    const messages = [
      claudeCodeMsg('Let\'s build an API', 'C:\\Users\\Dev\\TrainAi'),
      assistantMsg('Sure.'),
      claudeCodeMsg('hi', 'C:\\Users\\Dev\\TrainAi'),
    ];
    const verdict = evaluateHydration({
      ...BASE_CTX,
      conversationId: 'same-workspace-session',
      messages,
      currentWorkspaceRoot: 'C:\\Users\\Dev\\TrainAi',
      storedWorkspaceRoot:  'C:\\Users\\Dev\\TrainAi',
    });
    expect(verdict.allow).toBe(true);
    expect(verdict.reason).toBe('HYDRATION_APPROVED');
  });

  test('13c. "hi" alone (no workspace info) with NO stored workspace → blocks by low continuity', () => {
    // No workspace info anywhere, but "hi" is a trivial greeting → low continuity
    const verdict = evaluateHydration({
      ...BASE_CTX,
      messages: [userMsg('hi')],
      currentWorkspaceRoot: null,
      storedWorkspaceRoot: null,
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe('HYDRATION_SKIPPED_LOW_CONTINUITY');
  });

  // ─── Test 14: Subdirectory — strict isolation blocks it ──────────────────
  // User spec: "Workspace root must match. Strict path-aware memory isolation."
  // TrainAi ≠ TrainAi/library even if one is a subdirectory.

  test('14. subdirectory of stored workspace → blocked (strict isolation)', () => {
    // stored: /home/user/myrepo, current: /home/user/myrepo/packages/api
    // Different workspace roots \u2192 must block.
    const verdict = evaluateHydration({
      ...BASE_CTX,
      messages: [userMsg('continue working on the API')],
      currentWorkspaceRoot: '/home/user/myrepo/packages/api',
      storedWorkspaceRoot:  '/home/user/myrepo',
    });
    expect(verdict.allow).toBe(false);
    expect(verdict.reason).toBe('HYDRATION_SKIPPED_WORKSPACE_MISMATCH');
  });
});
