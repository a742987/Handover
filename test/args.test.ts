import { describe, expect, it } from 'vitest';
import { InvalidArgumentError } from 'commander';
import { parseRepos, parseSince, parseUsername } from '../src/args.js';

describe('parseRepos', () => {
  it('splits on commas and trims whitespace', () => {
    expect(parseRepos('acme/api, acme/web', [])).toEqual(['acme/api', 'acme/web']);
  });

  it('accumulates across repeated flags', () => {
    expect(parseRepos('acme/api', parseRepos('acme/web', []))).toEqual(['acme/web', 'acme/api']);
  });

  it('drops empty parts', () => {
    expect(parseRepos(', ,acme/api,', [])).toEqual(['acme/api']);
  });
});

describe('parseSince', () => {
  it('accepts ISO date and date-time forms', () => {
    expect(parseSince('2024-01-01')).toBe('2024-01-01T00:00:00.000Z');
    expect(parseSince('2024-01-01T10:30:00Z')).toBe('2024-01-01T10:30:00.000Z');
    expect(parseSince('2024-01-01T10:30:00+09:00')).toBe('2024-01-01T01:30:00.000Z');
  });

  it('normalizes zoneless date-times to UTC, matching date-only forms', () => {
    expect(parseSince('2024-01-01T10:30')).toBe('2024-01-01T10:30:00.000Z');
    expect(parseSince('2024-01-01T10:30:00')).toBe('2024-01-01T10:30:00.000Z');
  });

  it('rejects ambiguous non-ISO formats that new Date() would accept', () => {
    for (const bad of ['Jan 1, 2024', '1/1/2024', '2024', 'last week', '']) {
      expect(() => parseSince(bad)).toThrow(InvalidArgumentError);
    }
  });

  it('rejects well-formed but impossible dates', () => {
    expect(() => parseSince('2024-13-45')).toThrow(InvalidArgumentError);
  });
});

describe('parseUsername', () => {
  it('accepts real GitHub username shapes', () => {
    expect(parseUsername('alice')).toBe('alice');
    expect(parseUsername('a'.repeat(39))).toBe('a'.repeat(39));
    expect(parseUsername('0-abc-x')).toBe('0-abc-x');
  });

  it('normalizes to lowercase (GitHub logins are case-insensitive)', () => {
    expect(parseUsername('Alice-CAN')).toBe('alice-can');
    expect(parseUsername('Octocat')).toBe('octocat');
  });

  it('rejects path traversal, separators and over-long names', () => {
    for (const bad of ['../../etc', 'a/b', 'a:b', '-lead', 'trail-', '_under', 'a'.repeat(40), '']) {
      expect(() => parseUsername(bad)).toThrow(InvalidArgumentError);
    }
  });
});
