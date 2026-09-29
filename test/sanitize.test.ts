import { afterAll, describe, expect, it } from 'vitest';
import { execFileSync, spawnSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { GitDirectoryCollector } from '../src/collect/git.js';
import { HandoverStore } from '../src/store/sqlite.js';
import { parseCodeowners, ownersFor } from '../src/collect/codeowners.js';
import { sanitizeProse, sanitizeToken } from '../src/store/sanitize.js';
import type { CommitRecord, IssueRecord, PullRequestRecord, ReviewRecord } from '../src/types.js';

/**
 * Repository text reaches a terminal (`handover risk`, `bus-factor`) and a
 * `cat`/wiki/editor view of the book. Unstripped C0 controls let a commit
 * author, a file path or a CODEOWNERS handle emit `ESC [ 2 J` and then a forged
 * line, which the reader sees as the tool's own output — the one thing a report
 * built on "a human should confirm this" must not allow.
 *
 * Each case asserts the payload is gone *and* that the surrounding text is
 * still there: an assertion that only checks for absence passes vacuously when
 * nothing was written at all.
 */
const ESC = String.fromCharCode(27);
const FORGED = `${ESC}[1;31mGATE-APPROVED${ESC}[0m`;
const NO_CONTROLS = /[\x00-\x08\x0b\x0c\x0e-\x1f\x7f-\x9f]/;

describe('sanitizeProse / sanitizeToken', () => {
  it('drops the controls but keeps tab and newline, which carry meaning', () => {
    const prose = `line one\n\tline two${ESC}[2Jtail`;
    expect(sanitizeProse(prose)).toContain('\n');
    expect(sanitizeProse(prose)).toContain('\t');
    // the controls become spaces; the inert remainder of the sequence stays,
    // because deleting arbitrary text would silently edit the evidence
    expect(sanitizeProse(prose)).toMatch(/line two \[2Jtail/);
    expect(sanitizeProse(prose)).not.toMatch(NO_CONTROLS);
  });

  it('removes controls from single-token fields outright', () => {
    expect(sanitizeToken(`bob${FORGED}@example.com`)).toBe('bob[1;31mGATE-APPROVED[0m@example.com');
    expect(sanitizeToken(`src/${ESC}a.ts`)).toBe('src/a.ts');
    expect(sanitizeToken(`pay${FORGED}ments/x.ts`)).toBe('pay[1;31mGATE-APPROVED[0mments/x.ts');
    // an 8-bit CSI is as much a terminal command as ESC-[
    expect(sanitizeToken('bob\u009b2J')).toBe('bob2J');
  });

  it('strips bidi reordering and zero-width characters that forge or hide text', () => {
    // trojan-source toolkit: the bidi controls make a rendered line read one
    // way while its logical order is another; the zero-width characters hide
    // tokens from a reader while staying meaningful to a parser
    const LRE = '\u202a';
    const RLO = '\u202e';
    const PDF = '\u202c';
    const LRI = '\u2066';
    const PDI = '\u2069';
    const LRM = '\u200e';
    const ZWSP = '\u200b';
    const ZWJ = '\u200d';
    const WJ = '\u2060';
    const BOM = '\ufeff';

    const prose = `approved ${ZWSP}${ZWJ}${WJ}${BOM}path${LRE}x${PDF}${LRI}y${PDI}${LRM}end`;
    expect(sanitizeProse(prose)).toBe('approved pathxyend');

    const trojan = `safe ${RLO}eslaf ${PDF} line`;
    const cleaned = sanitizeProse(trojan);
    expect(cleaned).not.toContain(RLO);
    expect(cleaned).toContain('safe');
    expect(cleaned).toContain('eslaf');

    // logins and paths are token fields — same treatment, chars dropped
    expect(sanitizeToken(`do${RLO}g@example.com`)).toBe('dog@example.com');
    expect(sanitizeToken(`src/${ZWSP}x.ts`)).toBe('src/x.ts');
    expect(sanitizeToken(`pay${BOM}ments`)).toBe('payments');
  });
});

describe('the index strips controls on write, whichever collector supplied them', () => {
  const withCommit = (patch: Partial<CommitRecord>): CommitRecord => ({
    sha: 'a'.repeat(40),
    repo: 'acme/api',
    authorLogin: 'alice',
    authoredAt: '2026-09-01T00:00:00Z',
    message: 'settle idempotently',
    additions: 1,
    deletions: 0,
    files: [{ path: 'payments/charge.ts', additions: 1, deletions: 0 }],
    ...patch,
  });

  it('commit message, author handle and file path all come out clean', () => {
    const store = HandoverStore.inMemory();
    store.upsertCommit(withCommit({
      authorLogin: `bob${FORGED}@example.com`,
      message: `fix${FORGED} double charge`,
      files: [{ path: `pay${FORGED}ments/x.ts`, additions: 2, deletions: 0 }],
    }));
    const commit = store.allCommits()[0]!;
    expect(commit.message).toContain('double charge');
    expect(commit.message).not.toMatch(NO_CONTROLS);
    expect(commit.authorLogin).not.toMatch(NO_CONTROLS);
    expect(commit.authorLogin).toContain('example.com');
    // the residue of the inert sequence stays — erasing arbitrary characters
    // would silently edit evidence, the control bytes alone are the danger
    const storedPath = commit.files[0]?.path ?? '';
    expect(storedPath).not.toMatch(NO_CONTROLS);
    expect(storedPath).toMatch(/^pay.*ments\/x\.ts$/);
  });

  it('PR and issue titles/bodies, labels and comment authors too', () => {
    const store = HandoverStore.inMemory();
    const pr: PullRequestRecord = {
      repo: 'acme/api',
      number: 12,
      title: `retry backoff${FORGED}`,
      authorLogin: `carol${FORGED}`,
      state: 'closed',
      createdAt: '2026-09-02T00:00:00Z',
      mergedAt: null,
      body: `because the provider drops links${FORGED} after 30s`,
      additions: 3,
      deletions: 1,
      changedFiles: 1,
    };
    store.upsertPullRequest(pr);
    store.upsertPrFiles('acme/api', 12, [`src/${ESC}index.ts`]);
    const review: ReviewRecord = {
      id: 101,
      repo: 'acme/api',
      prNumber: 12,
      reviewerLogin: `dave${FORGED}`,
      state: 'APPROVED',
      submittedAt: '2026-09-03T00:00:00Z',
      body: `lgtm${FORGED}`,
      comments: [{ id: 5, reviewId: 101, path: `pay${ESC}/x.ts`, body: `keep it${FORGED}`, authorLogin: `dave${FORGED}` }],
    };
    store.upsertReview(review);
    const issue: IssueRecord = {
      repo: 'acme/api',
      number: 9,
      title: `outage${FORGED}`,
      authorLogin: 'erin',
      state: 'closed',
      createdAt: '2026-09-01T00:00:00Z',
      closedAt: null,
      labels: [`bug${FORGED}`],
      comments: [{ id: 7, number: 9, authorLogin: `erin${FORGED}`, createdAt: '2026-09-01T00:00:00Z', body: `hit twice${FORGED}` }],
      isPullRequest: false,
    };
    store.upsertIssue(issue);

    const storedPr = store.allPullRequests()[0]!;
    expect(storedPr.title).toContain('retry backoff');
    expect(storedPr.body).toContain('after 30s');
    expect(`${storedPr.title}${storedPr.body}${storedPr.authorLogin}`).not.toMatch(NO_CONTROLS);

    const storedReview = store.allReviews()[0]!;
    const firstComment = storedReview.comments[0];
    expect(storedReview.reviewerLogin).not.toMatch(NO_CONTROLS);
    expect(firstComment?.path).toBe('pay/x.ts');
    expect(firstComment?.body).toContain('keep it');

    const storedIssue = store.allIssues().find((entry) => entry.number === 9);
    expect(storedIssue!.labels).toEqual(['bug[1;31mGATE-APPROVED[0m']);
    expect(storedIssue!.labels.join('')).not.toMatch(NO_CONTROLS);
    expect(storedIssue!.comments[0]?.body).toContain('hit twice');
    const paths = store.allPrFiles().get('acme/api#12') ?? [];
    expect(paths.join('')).not.toMatch(NO_CONTROLS);
    expect(paths[0]).toContain('src/');
  });

  it('captured answers keep their paragraphs but lose the controls', () => {
    const store = HandoverStore.inMemory();
    store.addAnswer(`who to call${FORGED}`, `page sam\n\nthen rotate${FORGED} the key`);
    const answer = store.listAnswers()[0]!;
    expect(answer.answer).toContain('page sam\n\nthen rotate');
    expect(answer.answer).not.toMatch(NO_CONTROLS);
    expect(answer.question).not.toMatch(NO_CONTROLS);
    expect(answer.question).toContain('who to call');
  });

  it('CODEOWNERS handles are cleaned where bus-factor prints them', () => {
    const rules = parseCodeowners(`*  @plat${FORGED}`);
    const owners = ownersFor(rules, 'payments/x.ts');
    expect(owners.join('')).not.toMatch(NO_CONTROLS);
    expect(owners[0]).toContain('@plat');
  });
});

describe('the git boundary suppresses repo-forced terminal escapes', () => {
  const dirs: string[] = [];

  afterAll(async () => {
    await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  });

  /**
   * `color.ui = always` in the analysed repository's own config makes git emit
   * real ANSI escapes even with no TTY attached, and the collector prints
   * progress and error text straight to the terminal. The precondition is
   * asserted too: if a future git stops colouring non-terminals, this test says
   * so instead of quietly passing on nothing.
   */
  it('never lets a control byte through collect, and the vector is live', async () => {
    const dir = await mkdtemp(path.join(tmpdir(), 'handover-color-'));
    dirs.push(dir);
    const git = (...args: string[]) =>
      execFileSync('git', ['-C', dir, ...args], {
        encoding: 'utf8',
        env: {
          ...process.env,
          GIT_AUTHOR_NAME: 'Ann',
          GIT_AUTHOR_EMAIL: 'ann@example.com',
          GIT_COMMITTER_NAME: 'Ann',
          GIT_COMMITTER_EMAIL: 'ann@example.com',
        },
      });
    git('init', '-q', '-b', 'main');
    await mkdir(path.join(dir, 'payments'), { recursive: true });
    await writeFile(path.join(dir, 'payments', 'charge.ts'), 'export const a = 1;\n', 'utf8');
    git('add', '-A');
    git('commit', '-q', '-m', 'settle idempotently');
    git('config', 'color.ui', 'always');

    const raw = spawnSync('git', ['-C', dir, 'log', '--oneline'], { encoding: 'utf8' });
    expect(`${raw.stdout}${raw.stderr}`, 'git no longer colours a non-TTY; the premise of this test needs revisiting').toContain(ESC);

    const store = HandoverStore.inMemory();
    const messages: string[] = [];
    await new GitDirectoryCollector().collectInto(store, 'ann', [dir], {
      onProgress: (message) => messages.push(message),
    });
    expect(messages.join('\n')).not.toMatch(NO_CONTROLS);
    expect(messages.some((message) => message.includes('payments') || message.includes('repository')), 'collect produced no progress at all').toBe(true);
    for (const commit of store.allCommits()) {
      expect(`${commit.message} ${commit.authorLogin} ${commit.repo}`).not.toMatch(NO_CONTROLS);
      expect(commit.message).toContain('settle');
    }
    store.close();
  });
});

/**
 * The sanitizer only protects what passes through it, so the useful invariant is
 * not "these call sites are clean today" but "there is no other way to print".
 * Round seventeen converted the last module that wrote to the terminal directly;
 * this stops a ninth one from being added without noticing.
 */
describe('the printing surface is one choke point, mechanically', () => {
  it('has no bare console call anywhere in src/', () => {
    const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const offenders: string[] = [];
    const walk = (dir: string): void => {
      for (const entry of readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) {
          walk(full);
        } else if (entry.name.endsWith('.ts') && /console\.(log|warn|error|info|debug)/.test(readFileSync(full, 'utf8'))) {
          offenders.push(path.relative(root, full));
        }
      }
    };
    walk(root);
    expect(offenders).toEqual([]);
  });
});
