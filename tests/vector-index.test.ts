/**
 * tests/vector-index.test.ts
 * Tests for lib/memory/vector-index.ts
 */

import { VectorIndex, type VectorEntry } from '../lib/memory/vector-index';

// Mock fs to avoid actual disk I/O
jest.mock('fs', () => ({
  existsSync: jest.fn().mockReturnValue(false),
  readFileSync: jest.fn(),
  writeFileSync: jest.fn(),
  mkdirSync: jest.fn(),
}));

function makeEntry(id: string, vector: number[], type: VectorEntry['metadata']['type'] = 'file'): VectorEntry {
  return {
    id,
    vector,
    metadata: {
      type,
      title: id,
      text: `Content of ${id}`,
      embeddedAt: Date.now(),
    },
  };
}

describe('VectorIndex', () => {
  let index: VectorIndex;

  beforeEach(() => {
    index = new VectorIndex('/fake/project');
  });

  it('should start empty', () => {
    expect(index.size).toBe(0);
  });

  it('should insert and retrieve entries', () => {
    const entry = makeEntry('file1', [1, 0, 0]);
    index.insert(entry);
    expect(index.size).toBe(1);
    expect(index.has('file1')).toBe(true);
    expect(index.get('file1')).toEqual(entry);
  });

  it('should remove entries', () => {
    index.insert(makeEntry('file1', [1, 0, 0]));
    expect(index.remove('file1')).toBe(true);
    expect(index.size).toBe(0);
    expect(index.remove('nonexistent')).toBe(false);
  });

  it('should remove by prefix', () => {
    index.insert(makeEntry('src/a.ts:0', [1, 0, 0]));
    index.insert(makeEntry('src/a.ts:1', [0, 1, 0]));
    index.insert(makeEntry('src/b.ts:0', [0, 0, 1]));
    expect(index.removeByPrefix('src/a.ts')).toBe(2);
    expect(index.size).toBe(1);
  });

  it('should search by cosine similarity', () => {
    index.insert(makeEntry('close', [1, 0.1, 0]));
    index.insert(makeEntry('far', [0, 0, 1]));
    index.insert(makeEntry('medium', [0.5, 0.5, 0]));

    const results = index.search([1, 0, 0], 2);
    expect(results).toHaveLength(2);
    expect(results[0].entry.id).toBe('close');
    expect(results[0].score).toBeGreaterThan(results[1].score);
  });

  it('should filter by type', () => {
    index.insert(makeEntry('file1', [1, 0, 0], 'file'));
    index.insert(makeEntry('task1', [0.9, 0.1, 0], 'task'));
    index.insert(makeEntry('error1', [0.8, 0.2, 0], 'error'));

    const results = index.search([1, 0, 0], 5, 'task');
    expect(results).toHaveLength(1);
    expect(results[0].entry.id).toBe('task1');
  });

  it('should update entries', () => {
    index.insert(makeEntry('file1', [1, 0, 0]));
    const updated = index.update('file1', [0, 1, 0], { title: 'Updated' });
    expect(updated).toBe(true);
    expect(index.get('file1')!.vector).toEqual([0, 1, 0]);
    expect(index.get('file1')!.metadata.title).toBe('Updated');
  });

  it('should return false when updating nonexistent entry', () => {
    expect(index.update('nope', [1], {})).toBe(false);
  });

  it('should list all IDs', () => {
    index.insert(makeEntry('a', [1, 0, 0]));
    index.insert(makeEntry('b', [0, 1, 0]));
    expect(index.ids().sort()).toEqual(['a', 'b']);
  });

  it('should load from disk', () => {
    const fs = require('fs');
    const entries = [makeEntry('loaded', [1, 0, 0])];
    fs.existsSync.mockReturnValueOnce(true);
    fs.readFileSync.mockReturnValueOnce(JSON.stringify(entries));

    const idx = new VectorIndex('/fake');
    idx.load();
    expect(idx.size).toBe(1);
    expect(idx.has('loaded')).toBe(true);
  });

  it('should save to disk', () => {
    const fs = require('fs');
    index.insert(makeEntry('saved', [1, 0, 0]));
    fs.existsSync.mockReturnValue(true);

    index.save();
    expect(fs.writeFileSync).toHaveBeenCalledTimes(1);
    const written = JSON.parse(fs.writeFileSync.mock.calls[0][1]);
    expect(written).toHaveLength(1);
    expect(written[0].id).toBe('saved');
  });
});
