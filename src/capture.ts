import { createInterface } from 'node:readline/promises';
import { QUESTIONS } from './distill/synthesize.js';
import type { HandoverStore } from './store/sqlite.js';

export interface CaptureEntry {
  question: string;
  answer: string;
}

/** Inserts non-empty entries; returns how many were stored. */
export function applyAnswers(store: HandoverStore, entries: CaptureEntry[], capturedAt = new Date().toISOString()): number {
  let stored = 0;
  for (const entry of entries) {
    const question = entry.question.trim();
    const answer = entry.answer.trim();
    if (!question || !answer) {
      continue;
    }
    store.addAnswer(question, answer, capturedAt);
    stored += 1;
  }
  return stored;
}

/** Parses the --answers JSON contract: [{question, answer}, ...]. */
export function parseAnswersJson(raw: string): CaptureEntry[] {
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    throw new Error('--answers file does not contain valid JSON');
  }
  if (!Array.isArray(parsed)) {
    throw new Error('--answers must be a JSON array of {"question": "...", "answer": "..."} objects');
  }
  return parsed.map((item, index) => {
    const entry = item as Partial<CaptureEntry>;
    if (typeof entry?.question !== 'string' || typeof entry?.answer !== 'string') {
      throw new Error(`--answers entry ${index + 1} must have string "question" and "answer"`);
    }
    return { question: entry.question, answer: entry.answer };
  });
}

/**
 * Walks the standing question set with the departing engineer. Answers are
 * typed as one or more lines, finished by a blank line; "skip" leaves the
 * question open. Each entry is stored immediately so an interrupted session
 * keeps whatever was captured.
 */
export async function runInteractiveCapture(store: HandoverStore, username: string): Promise<number> {
  const rl = createInterface({ input: process.stdin, output: process.stdout });
  let stored = 0;
  try {
    console.log(`Capturing first-person answers for @${username}. The book is stronger for every honest sentence.`);
    console.log('Type your answer, finish with a blank line. "skip" leaves it open, "quit" stops.\n');
    for (const question of QUESTIONS) {
      console.log(`Q: ${question}`);
      const lines: string[] = [];
      for (;;) {
        const line = (await rl.question(lines.length === 0 ? '> ' : '… ')).replace(/\r$/, '');
        if (line.trim() === '') {
          break;
        }
        if (lines.length === 0 && /^skip$/i.test(line.trim())) {
          console.log('   (skipped)\n');
          break;
        }
        if (lines.length === 0 && /^quit$/i.test(line.trim())) {
          return stored;
        }
        lines.push(line);
      }
      const answer = lines.join('\n').trim();
      if (answer) {
        stored += applyAnswers(store, [{ question, answer }]);
        console.log(`   captured (${answer.split('\n').length} lines)\n`);
      }
    }
    console.log('Add any question of your own, or press blank to finish.');
    for (;;) {
      const question = (await rl.question('Question: ')).trim();
      if (!question) {
        break;
      }
      const answer = (await rl.question('Answer: ')).trim();
      if (answer) {
        stored += applyAnswers(store, [{ question, answer }]);
      }
    }
  } finally {
    rl.close();
  }
  return stored;
}
