import { describe, expect, it } from 'vitest';
import { parseRepoSlug } from '../src/collect/github.js';

describe('parseRepoSlug', () => {
  it('splits a well-formed owner/name', () => {
    expect(parseRepoSlug('acme/api')).toEqual({ owner: 'acme', repo: 'api' });
  });

  it('rejects everything that is not exactly owner/name', () => {
    for (const bad of ['', 'acme', 'acme/', '/api', 'a/b/c', 'a/b/c/d']) {
      expect(() => parseRepoSlug(bad)).toThrow(/owner\/name/);
    }
  });
});
