import { describe, expect, it } from 'vitest';
import { HandoverStore } from '../src/store/sqlite.js';
import { applyAnswers, parseAnswersJson } from '../src/capture.js';
import { QUESTIONS, synthesizeChapters, renderRecordedAnswers } from '../src/distill/synthesize.js';
import type { CommitRecord } from '../src/types.js';

const REPO = 'acme/api';
const USERNAME = 'alice';

function seedStore(): HandoverStore {
  const store = HandoverStore.inMemory();
  const commit: CommitRecord = {
    sha: 'a'.repeat(40),
    repo: REPO,
    authorLogin: USERNAME,
    authoredAt: '2026-09-01T00:00:00Z',
    message: 'settle',
    additions: 1,
    deletions: 0,
    files: [{ path: 'payments/charge.ts', additions: 1, deletions: 0 }],
  };
  store.upsertCommit(commit);
  store.setMeta('repos', REPO);
  return store;
}

describe('applyAnswers', () => {
  it('stores answers with a capture timestamp and skips empty entries', () => {
    const store = seedStore();
    const stored = applyAnswers(
      store,
      [
        { question: 'Q1', answer: 'A1' },
        { question: '  ', answer: 'ignored' },
        { question: 'Q2', answer: '  ' },
      ],
      '2026-09-20T10:00:00Z',
    );
    expect(stored).toBe(1);
    const answers = store.listAnswers();
    expect(answers).toHaveLength(1);
    expect(answers[0]?.question).toBe('Q1');
    expect(answers[0]?.capturedAt).toBe('2026-09-20T10:00:00Z');
  });

  it('round-trips deletion by id', () => {
    const store = seedStore();
    applyAnswers(store, [
      { question: 'Q1', answer: 'A1' },
      { question: 'Q2', answer: 'A2' },
    ]);
    store.deleteAnswer(1);
    expect(store.listAnswers().map((a) => a.question)).toEqual(['Q2']);
  });
});

describe('parseAnswersJson', () => {
  it('parses the documented contract', () => {
    expect(parseAnswersJson('[{"question":"Q","answer":"A"}]')).toEqual([{ question: 'Q', answer: 'A' }]);
  });

  it('rejects invalid JSON, non-arrays and malformed entries', () => {
    expect(() => parseAnswersJson('nope')).toThrow(/valid JSON/);
    expect(() => parseAnswersJson('{"question":"Q"}')).toThrow(/array/);
    expect(() => parseAnswersJson('[{"question":"Q"}]')).toThrow(/entry 1/);
  });
});

describe('chapter 6 injection', () => {
  it('appends recorded answers to the fallback letter', async () => {
    const store = seedStore();
    applyAnswers(store, [{ question: QUESTIONS[0]!, answer: 'The settlement state machine.\nIt hides timezone math.' }]);
    const chapters = await synthesizeChapters({ username: USERNAME, repos: [REPO], store, risks: [], onProgress: () => {} }, null);
    const letter = chapters.find((chapter) => chapter.id === 6)!;
    expect(letter.content).toContain('Recorded answers from @alice');
    expect(letter.content).toContain('The settlement state machine.');
    expect(letter.content).toContain('timezone math');
  });

  it('renders nothing when no answers were captured', () => {
    expect(renderRecordedAnswers('alice', [])).toBe('');
  });
});
