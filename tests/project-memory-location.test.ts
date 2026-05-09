/**
 * tests/project-memory-location.test.ts
 *
 * Tests for project memory path resolution.
 * Verifies .coatcard is placed in workspace root, never gateway root.
 */

import {
  getWorkspaceRoot,
  getCoatcardPath,
  getEmbeddingsPath,
  getSummariesPath,
  getArtifactsPath,
  getTaskGraphPath,
  getVectorsFilePath,
  getSummariesFilePath,
  getFileHashesPath,
  isLocalCacheEnabled,
  getWorkspaceId,
} from '@/lib/memory/project-memory-path';
import * as path from 'path';

describe('project-memory-path', () => {
  const origEnv = { ...process.env };

  afterEach(() => {
    process.env = { ...origEnv };
  });

  test('getWorkspaceRoot uses WORKSPACE_ROOT env var when set', () => {
    process.env.WORKSPACE_ROOT = '/home/user/myproject';
    expect(getWorkspaceRoot()).toBe(path.resolve('/home/user/myproject'));
  });

  test('getWorkspaceRoot uses COATCARD_PROJECT_ROOT as fallback', () => {
    delete process.env.WORKSPACE_ROOT;
    process.env.COATCARD_PROJECT_ROOT = '/home/user/otherproject';
    expect(getWorkspaceRoot()).toBe(path.resolve('/home/user/otherproject'));
  });

  test('getWorkspaceRoot falls back to cwd in dev', () => {
    delete process.env.WORKSPACE_ROOT;
    delete process.env.COATCARD_PROJECT_ROOT;
    (process.env as Record<string, string>).NODE_ENV = 'development';
    expect(getWorkspaceRoot()).toBe(process.cwd());
  });

  test('getCoatcardPath is under workspace root', () => {
    process.env.WORKSPACE_ROOT = '/project';
    const p = getCoatcardPath();
    expect(p).toContain('.coatcard');
    expect(p.startsWith(path.resolve('/project'))).toBe(true);
  });

  test('.coatcard is NEVER in gateway root when WORKSPACE_ROOT is set', () => {
    process.env.WORKSPACE_ROOT = '/target/project';
    const gatewayRoot = process.cwd();
    const coatcardPath = getCoatcardPath();
    // When WORKSPACE_ROOT is set and different from cwd, .coatcard should not be in cwd
    if (path.resolve('/target/project') !== gatewayRoot) {
      expect(coatcardPath.startsWith(gatewayRoot)).toBe(false);
    }
  });

  test('getEmbeddingsPath is under .coatcard', () => {
    const p = getEmbeddingsPath();
    expect(p).toContain('.coatcard');
    expect(p).toContain('retrieval-index');
  });

  test('getSummariesPath is under .coatcard', () => {
    const p = getSummariesPath();
    expect(p).toContain('.coatcard');
    expect(p).toContain('summaries');
  });

  test('getArtifactsPath is under .coatcard', () => {
    const p = getArtifactsPath();
    expect(p).toContain('.coatcard');
    expect(p).toContain('artifacts');
  });

  test('getTaskGraphPath is under .coatcard', () => {
    const p = getTaskGraphPath();
    expect(p).toContain('.coatcard');
    expect(p).toContain('task-graph');
  });

  test('getVectorsFilePath ends with vectors.json', () => {
    expect(getVectorsFilePath()).toMatch(/vectors\.json$/);
  });

  test('getSummariesFilePath ends with summaries.json', () => {
    expect(getSummariesFilePath()).toMatch(/summaries\.json$/);
  });

  test('getFileHashesPath ends with file-hashes.json', () => {
    expect(getFileHashesPath()).toMatch(/file-hashes\.json$/);
  });

  test('isLocalCacheEnabled defaults to true in test/dev', () => {
    delete process.env.ENABLE_LOCAL_MEMORY_CACHE;
    (process.env as Record<string, string>).NODE_ENV = 'test';
    expect(isLocalCacheEnabled()).toBe(true);
  });

  test('isLocalCacheEnabled respects explicit env var', () => {
    process.env.ENABLE_LOCAL_MEMORY_CACHE = 'false';
    expect(isLocalCacheEnabled()).toBe(false);

    process.env.ENABLE_LOCAL_MEMORY_CACHE = 'true';
    expect(isLocalCacheEnabled()).toBe(true);
  });

  test('getWorkspaceId uses WORKSPACE_ID when set', () => {
    process.env.WORKSPACE_ID = 'custom-id';
    expect(getWorkspaceId()).toBe('custom-id');
  });

  test('getWorkspaceId derives from workspace root path', () => {
    delete process.env.WORKSPACE_ID;
    const id = getWorkspaceId();
    expect(id.length).toBeGreaterThan(0);
    expect(id).not.toContain('\\'); // Should use forward slashes
  });

  test('different WORKSPACE_ROOT values produce different coatcard paths', () => {
    process.env.WORKSPACE_ROOT = '/project/a';
    const pathA = getCoatcardPath();

    process.env.WORKSPACE_ROOT = '/project/b';
    const pathB = getCoatcardPath();

    expect(pathA).not.toBe(pathB);
  });

  test('all sub-paths are nested under coatcard path', () => {
    const root = getCoatcardPath();
    expect(getEmbeddingsPath().startsWith(root)).toBe(true);
    expect(getSummariesPath().startsWith(root)).toBe(true);
    expect(getArtifactsPath().startsWith(root)).toBe(true);
    expect(getTaskGraphPath().startsWith(root)).toBe(true);
  });
});
