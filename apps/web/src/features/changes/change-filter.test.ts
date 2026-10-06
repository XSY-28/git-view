import { describe, expect, it } from 'vitest';
import { matchesFileFilter } from './change-filter';

describe('file path filtering', () => {
  it('matches the complete path and rename source without treating punctuation as a query language', () => {
    const entry = { path: 'src/迁移/New [file].TS', oldPath: 'legacy/Original.ts' };
    expect(matchesFileFilter(entry, 'src/迁移')).toBe(true);
    expect(matchesFileFilter(entry, '  new [FILE]  ')).toBe(true);
    expect(matchesFileFilter(entry, 'legacy/original')).toBe(true);
    expect(matchesFileFilter(entry, '*.ts')).toBe(false);
  });
  it('restores every entry for an empty filter and does not match unrelated paths', () => {
    expect(matchesFileFilter({ path: 'a.txt' }, ' ')).toBe(true);
    expect(matchesFileFilter({ path: 'a.txt' }, 'b.txt')).toBe(false);
  });
});
