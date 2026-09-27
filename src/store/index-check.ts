import { access } from 'node:fs/promises';
import path from 'node:path';

/** Fails with an actionable message instead of silently computing from an empty index. */
export async function requireIndex(dataDir: string, username: string, hint: string): Promise<string> {
  const dbPath = path.join(dataDir, `${username}.db`);
  try {
    await access(dbPath);
  } catch {
    throw new Error(`No index found at ${dbPath} — ${hint}`);
  }
  return dbPath;
}
