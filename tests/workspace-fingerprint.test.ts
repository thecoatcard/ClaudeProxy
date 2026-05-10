/**
 * tests/workspace-fingerprint.test.ts
 *
 * Unit tests for Phase 2 — Workspace Fingerprinting.
 * Covers: path extraction, normalisation, fingerprint derivation, comparison.
 */

import {
  normalizePath,
  extractWorkspaceRoot,
  computeWorkspaceFingerprint,
  compareWorkspaceFingerprints,
  FALLBACK_FINGERPRINT,
} from '../lib/session/workspace-fingerprint';

describe('normalizePath', () => {
  it('converts backslashes to forward slashes', () => {
    expect(normalizePath('C:\\Users\\foo\\bar')).toBe('c:/users/foo/bar');
  });

  it('lowercases the path', () => {
    expect(normalizePath('/Users/FOO/Bar')).toBe('/users/foo/bar');
  });

  it('removes trailing slash', () => {
    expect(normalizePath('/home/user/project/')).toBe('/home/user/project');
  });

  it('handles mixed separators', () => {
    expect(normalizePath('C:\\Users/Foo\\bar/')).toBe('c:/users/foo/bar');
  });
});

describe('extractWorkspaceRoot', () => {
  it('extracts from <workspacePath> tag in system text', () => {
    const sys = '<workspacePath>/home/user/myproject</workspacePath>';
    expect(extractWorkspaceRoot(sys, [])).toBe('/home/user/myproject');
  });

  it('extracts from <cwd> tag in system text', () => {
    const sys = '<cwd>/var/projects/api</cwd>';
    expect(extractWorkspaceRoot(sys, [])).toBe('/var/projects/api');
  });

  it('extracts from Cwd: header in system text', () => {
    const sys = 'Cwd: /home/user/project\nOther stuff';
    expect(extractWorkspaceRoot(sys, [])).toBe('/home/user/project');
  });

  it('extracts from Current Working Directory (...) pattern', () => {
    const sys = 'Current Working Directory (/home/user/workspace)';
    expect(extractWorkspaceRoot(sys, [])).toBe('/home/user/workspace');
  });

  it('extracts from early user messages', () => {
    const messages = [
      { role: 'user', content: '<environment_details>\n<workspacePath>/ws/project</workspacePath>\n</environment_details>' },
    ];
    expect(extractWorkspaceRoot('', messages)).toBe('/ws/project');
  });

  it('returns null when nothing is found', () => {
    expect(extractWorkspaceRoot('Hello world', [])).toBeNull();
  });

  it('only scans first 4 messages', () => {
    const messages = [
      { role: 'user', content: 'no path' },
      { role: 'user', content: 'no path' },
      { role: 'user', content: 'no path' },
      { role: 'user', content: 'no path' },
      { role: 'user', content: '<workspacePath>/ws/late</workspacePath>' },
    ];
    expect(extractWorkspaceRoot('', messages)).toBeNull();
  });
});

describe('computeWorkspaceFingerprint', () => {
  it('returns high-confidence fingerprint when workspace is found', () => {
    const sys = '<workspacePath>/home/user/project</workspacePath>';
    const fp = computeWorkspaceFingerprint(sys, []);
    expect(fp.confidence).toBe('high');
    expect(fp.fingerprint).not.toBe(FALLBACK_FINGERPRINT);
    expect(fp.normalizedPath).toBe('/home/user/project');
  });

  it('returns same fingerprint for the same workspace path', () => {
    const sys = '<workspacePath>/home/user/project</workspacePath>';
    const fp1 = computeWorkspaceFingerprint(sys, []);
    const fp2 = computeWorkspaceFingerprint(sys, []);
    expect(fp1.fingerprint).toBe(fp2.fingerprint);
  });

  it('returns different fingerprints for different workspaces', () => {
    const sys1 = '<workspacePath>/home/user/project-A</workspacePath>';
    const sys2 = '<workspacePath>/home/user/project-B</workspacePath>';
    const fp1 = computeWorkspaceFingerprint(sys1, []);
    const fp2 = computeWorkspaceFingerprint(sys2, []);
    expect(fp1.fingerprint).not.toBe(fp2.fingerprint);
  });

  it('returns none-confidence with fallback fingerprint when no path found', () => {
    const fp = computeWorkspaceFingerprint('No workspace here', []);
    expect(fp.confidence).toBe('none');
    expect(fp.fingerprint).toBe(FALLBACK_FINGERPRINT);
    expect(fp.normalizedPath).toBeNull();
  });

  it('normalises Windows paths consistently', () => {
    const sys1 = '<workspacePath>C:\\Users\\foo\\project</workspacePath>';
    const sys2 = '<workspacePath>C:/Users/foo/project</workspacePath>';
    const fp1 = computeWorkspaceFingerprint(sys1, []);
    const fp2 = computeWorkspaceFingerprint(sys2, []);
    expect(fp1.fingerprint).toBe(fp2.fingerprint);
  });
});

describe('compareWorkspaceFingerprints', () => {
  it('returns match for equal fingerprints', () => {
    expect(compareWorkspaceFingerprints('abc123', 'abc123')).toBe('match');
  });

  it('returns mismatch for different fingerprints', () => {
    expect(compareWorkspaceFingerprints('abc123', 'xyz789')).toBe('mismatch');
  });

  it('returns unknown when either is null', () => {
    expect(compareWorkspaceFingerprints(null, 'abc123')).toBe('unknown');
    expect(compareWorkspaceFingerprints('abc123', null)).toBe('unknown');
    expect(compareWorkspaceFingerprints(null, null)).toBe('unknown');
  });

  it('returns unknown when either is the fallback fingerprint', () => {
    expect(compareWorkspaceFingerprints(FALLBACK_FINGERPRINT, 'abc123')).toBe('unknown');
    expect(compareWorkspaceFingerprints('abc123', FALLBACK_FINGERPRINT)).toBe('unknown');
  });
});
