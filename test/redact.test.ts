import { describe, expect, it } from 'vitest';
import { redact, REDACTED } from '../src/render/redact.js';
import { buildDigest } from '../src/distill/synthesize.js';
import { computeRisk } from '../src/risk/engine.js';
import { HandoverStore } from '../src/store/sqlite.js';

describe('redact', () => {
  it('scrubs provider token formats', () => {
    expect(redact('key ghp_Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa')).not.toContain('ghp_');
    expect(redact('github_pat_11ABCDEFGH01_zzzzzzzzzzzzzzzzzzzzzz')).toContain(REDACTED);
    expect(redact('aws AKIAIOSFODNN7EXAMPLE')).not.toContain('AKIA');
    expect(redact('slack xoxb-123456789012-abcd')).not.toContain('xoxb');
    expect(redact('glpat-abcdefghijklmnopqrstuvwx')).not.toContain('glpat');
    expect(redact('Authorization: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9')).not.toContain('eyJ');
  });

  it('scrubs key=value assignments but keeps the key name', () => {
    expect(redact('api_key: super-secret-123')).toBe(`api_key: ${REDACTED}`);
    expect(redact('DB_PASSWORD="hunter2longer"')).toContain(`${REDACTED}`);
    expect(redact('DB_PASSWORD="hunter2longer"')).not.toContain('hunter2');
  });

  it('scrubs private key blocks', () => {
    const pem = '-----BEGIN OPENSSH PRIVATE KEY-----\nb3BlbnNzaC1rZXktdjEA\nAAAAAAAAAAAA\n-----END OPENSSH PRIVATE KEY-----';
    expect(redact(pem)).not.toContain('b3Blbn');
  });

  it('leaves ordinary prose alone', () => {
    const text = 'Fix crash in settlement (#101) — the retry key must stay stable.';
    expect(redact(text)).toBe(text);
  });
});

describe('redacted digest', () => {
  it('scrubs secrets before anything is sent to the LLM', () => {
    const store = HandoverStore.inMemory();
    store.upsertCommit({
      sha: 'a'.repeat(40),
      repo: 'acme/api',
      authorLogin: 'alice',
      authoredAt: '2026-09-01T00:00:00Z',
      message: 'wire api_key: SUPERSECRETV1 into the client',
      additions: 1,
      deletions: 0,
      files: [{ path: 'src/client.ts', additions: 1, deletions: 0 }],
    });
    store.upsertPullRequest({
      repo: 'acme/api',
      number: 1,
      title: 'use env',
      authorLogin: 'alice',
      state: 'closed',
      createdAt: '2026-09-01T00:00:00Z',
      mergedAt: null,
      body: 'The old default ghp_Aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa is dead now.',
      additions: 1,
      deletions: 0,
      changedFiles: 1,
    });
    const risks = computeRisk(store, 'alice');
    const plain = buildDigest({ username: 'alice', repos: ['acme/api'], store, risks });
    expect(plain).toContain('ghp_Aaaa');
    const scrubbed = buildDigest({ username: 'alice', repos: ['acme/api'], store, risks, redact: true });
    expect(scrubbed).not.toContain('ghp_Aaaa');
    expect(scrubbed).not.toContain('SUPERSECRETV1');
    expect(scrubbed).toContain(REDACTED);
  });
});
