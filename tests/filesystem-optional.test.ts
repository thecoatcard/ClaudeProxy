/**
 * tests/filesystem-optional.test.ts
 *
 * Tests that file ingestion gracefully handles missing filesystem.
 */

import { supportsFileIngestion, scanProjectFiles } from '@/lib/memory/file-ingestion';

describe('filesystem-optional file ingestion', () => {
  test('supportsFileIngestion returns true when fs is available', () => {
    // In Node.js test environment, fs is always available
    expect(supportsFileIngestion()).toBe(true);
  });

  test('scanProjectFiles returns empty result for non-existent root', () => {
    const result = scanProjectFiles('/nonexistent/path/that/does/not/exist');
    expect(result.files).toHaveLength(0);
    expect(result.totalBytes).toBe(0);
  });

  test('scanProjectFiles uses workspace root when no arg provided', () => {
    // Should not throw even without explicit root
    const result = scanProjectFiles();
    expect(result).toHaveProperty('files');
    expect(result).toHaveProperty('skipped');
    expect(result).toHaveProperty('totalBytes');
  });

  test('scanProjectFiles scans real project files', () => {
    // Scan the actual workspace — should find at least package.json
    const result = scanProjectFiles(process.cwd());
    const fileNames = result.files.map(f => f.relativePath);
    expect(fileNames).toContain('package.json');
  });

  test('scanProjectFiles respects ignore patterns', () => {
    const result = scanProjectFiles(process.cwd());
    const fileNames = result.files.map(f => f.relativePath);
    // Should not include node_modules files
    const hasNodeModules = fileNames.some(f => f.includes('node_modules'));
    expect(hasNodeModules).toBe(false);
  });

  test('scanProjectFiles respects extension filter', () => {
    const result = scanProjectFiles(process.cwd());
    for (const file of result.files) {
      const ext = file.extension;
      expect(['.ts', '.tsx', '.js', '.jsx', '.mjs', '.json', '.md', '.mdx', '.css', '.scss', '.prisma', '.graphql', '.gql', '.yaml', '.yml', '.toml', '.env.example']).toContain(ext);
    }
  });

  test('scanProjectFiles ignores .coatcard directory', () => {
    const result = scanProjectFiles(process.cwd());
    const hasCoatcard = result.files.some(f => f.relativePath.includes('.coatcard'));
    expect(hasCoatcard).toBe(false);
  });
});
