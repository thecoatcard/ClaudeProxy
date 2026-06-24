/**
 * tests/edit-failure-classifier.test.ts
 *
 * Phase 9 tests — edit failure classifier (Phase 2),
 * tool name registration, path normalization, and CRLF normalization (Phase 8).
 */

import {
  classifyEditFailure,
  isEditTool,
  isReadTool,
  extractFilePath,
  normalizePath,
  normalizeLineEndings,
  EditFailureType,
} from '../lib/tools/edit-failure-classifier';

// ── classifyEditFailure ───────────────────────────────────────────────────────

describe('classifyEditFailure', () => {
  test('MULTIPLE_MATCHES — "multiple matches found"', () => {
    const r = classifyEditFailure('multiple matches found in file');
    expect(r.type).toBe('MULTIPLE_MATCHES');
    expect(r.confidence).toBe('high');
    expect(r.recoveryHint).toContain('surrounding context');
  });

  test('MULTIPLE_MATCHES — "found 3 matches"', () => {
    const r = classifyEditFailure('found 3 matches for the provided old_string');
    expect(r.type).toBe('MULTIPLE_MATCHES');
    expect(r.confidence).toBe('high');
  });

  test('WHITESPACE_MISMATCH — "whitespace mismatch"', () => {
    const r = classifyEditFailure('whitespace mismatch detected in old_string');
    expect(r.type).toBe('WHITESPACE_MISMATCH');
    expect(r.confidence).toBe('high');
    expect(r.recoveryHint).toContain('indentation');
  });

  test('WHITESPACE_MISMATCH — "leading whitespace"', () => {
    const r = classifyEditFailure('Expected leading whitespace not found');
    expect(r.type).toBe('WHITESPACE_MISMATCH');
  });

  test('EXACT_MATCH_FAILURE — "old_string not found"', () => {
    const r = classifyEditFailure('old_string not found in file');
    expect(r.type).toBe('EXACT_MATCH_FAILURE');
    expect(r.confidence).toBe('high');
    expect(r.recoveryHint).toContain('Re-read');
  });

  test('EXACT_MATCH_FAILURE — "exact match not found"', () => {
    const r = classifyEditFailure('exact match not found for the provided string');
    expect(r.type).toBe('EXACT_MATCH_FAILURE');
  });

  test('EXACT_MATCH_FAILURE — "no match found for old_str"', () => {
    const r = classifyEditFailure('No match found for old_str provided');
    expect(r.type).toBe('EXACT_MATCH_FAILURE');
  });

  test('FILE_CHANGED — "file modified since"', () => {
    const r = classifyEditFailure('File was modified since last read');
    expect(r.type).toBe('FILE_CHANGED');
    expect(r.confidence).toBe('high');
    expect(r.recoveryHint).toContain('Re-read');
  });

  test('NO_MATCH_FOUND — "no match" (medium confidence)', () => {
    const r = classifyEditFailure('no match available in document');
    expect(r.type).toBe('NO_MATCH_FOUND');
    expect(r.confidence).toBe('medium');
  });

  test('UNKNOWN — unrecognized error text', () => {
    const r = classifyEditFailure('something completely unexpected happened');
    expect(r.type).toBe('UNKNOWN');
    expect(r.confidence).toBe('low');
  });

  test('UNKNOWN — empty string', () => {
    const r = classifyEditFailure('');
    expect(r.type).toBe('UNKNOWN');
  });

  test('MULTIPLE_MATCHES takes priority over NO_MATCH_FOUND', () => {
    const r = classifyEditFailure('Multiple matches found — no match was exact');
    expect(r.type).toBe('MULTIPLE_MATCHES');
  });

  test('rawError is truncated to 400 chars', () => {
    const longError = 'A'.repeat(500);
    const r = classifyEditFailure(longError);
    expect(r.rawError.length).toBeLessThanOrEqual(400);
  });

  test('CRLF in error text is normalized (Phase 8)', () => {
    const r = classifyEditFailure('old_string not found\r\nin the file\r\n');
    expect(r.type).toBe('EXACT_MATCH_FAILURE');
  });
});

// ── isEditTool / isReadTool ───────────────────────────────────────────────────

describe('isEditTool', () => {
  test('str_replace_based_edit_tool → true', () => expect(isEditTool('str_replace_based_edit_tool')).toBe(true));
  test('edit_file → true', () => expect(isEditTool('edit_file')).toBe(true));
  test('replace_string_in_file → true', () => expect(isEditTool('replace_string_in_file')).toBe(true));
  test('read_file → false', () => expect(isEditTool('read_file')).toBe(false));
  test('bash → false', () => expect(isEditTool('bash')).toBe(false));
});

describe('isReadTool', () => {
  test('read_file → true', () => expect(isReadTool('read_file')).toBe(true));
  test('view_file → true', () => expect(isReadTool('view_file')).toBe(true));
  test('str_replace_editor → false', () => expect(isReadTool('str_replace_editor')).toBe(false));
});

// ── extractFilePath ───────────────────────────────────────────────────────────

describe('extractFilePath', () => {
  test('extracts path field', () => expect(extractFilePath({ path: '/a/b.ts' })).toBe('/a/b.ts'));
  test('extracts file_path field', () => expect(extractFilePath({ file_path: '/x.ts' })).toBe('/x.ts'));
  test('extracts filePath (camelCase)', () => expect(extractFilePath({ filePath: '/y.ts' })).toBe('/y.ts'));
  test('returns null on empty input', () => expect(extractFilePath(null)).toBeNull());
  test('returns null when no path field', () => expect(extractFilePath({ other: 'val' })).toBeNull());
});

// ── normalizePath ─────────────────────────────────────────────────────────────

describe('normalizePath', () => {
  test('backslashes → forward slashes (Phase 8)', () => {
    expect(normalizePath('C:\\Users\\Dev\\Project')).toBe('c:/users/dev/project');
  });
  test('lowercase', () => {
    expect(normalizePath('/Users/Dev/Project')).toBe('/users/dev/project');
  });
  test('trailing slash removed', () => {
    expect(normalizePath('/home/user/project/')).toBe('/home/user/project');
  });
  test('null input → null', () => expect(normalizePath(null)).toBeNull());
  test('undefined input → null', () => expect(normalizePath(undefined)).toBeNull());
});

// ── normalizeLineEndings ──────────────────────────────────────────────────────

describe('normalizeLineEndings', () => {
  test('CRLF → LF (Phase 8)', () => {
    expect(normalizeLineEndings('line1\r\nline2\r\n')).toBe('line1\nline2\n');
  });
  test('CR → LF', () => {
    expect(normalizeLineEndings('line1\rline2')).toBe('line1\nline2');
  });
  test('already LF → unchanged', () => {
    expect(normalizeLineEndings('line1\nline2')).toBe('line1\nline2');
  });
  test('empty string → empty string', () => {
    expect(normalizeLineEndings('')).toBe('');
  });
});
