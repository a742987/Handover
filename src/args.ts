import { InvalidArgumentError } from 'commander';

/** Collects repeated/comma-separated -r/--repo values into a list. */
export function parseRepos(value: string, previous: string[]): string[] {
  const repos = previous ?? [];
  for (const part of value.split(',')) {
    const repo = part.trim();
    if (repo) {
      repos.push(repo);
    }
  }
  return repos;
}

/**
 * Accepts ISO date or ISO date-time (e.g. 2024-01-01, 2024-01-01T10:00:00Z).
 * Rejects ambiguous formats like "Jan 1, 2024" or "1/1/2024" that new Date()
 * would otherwise parse silently.
 */
export function parseSince(value: string): string {
  const isoRe = /^\d{4}-\d{2}-\d{2}(T\d{2}:\d{2}(:\d{2}(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
  if (!isoRe.test(value)) {
    throw new InvalidArgumentError('--since expects an ISO date, e.g. 2024-01-01 or 2024-01-01T10:00:00Z');
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new InvalidArgumentError('--since expects an ISO date, e.g. 2024-01-01');
  }
  return date.toISOString();
}

/**
 * GitHub usernames are limited to alphanumerics and hyphens; validating here
 * prevents path traversal (e.g. "../../x") and Windows-invalid characters.
 * GitHub logins are case-insensitive — normalize so index files, books and
 * author comparisons all use one canonical form.
 */
export function parseUsername(value: string): string {
  if (!/^[A-Za-z0-9](?:[A-Za-z0-9-]*[A-Za-z0-9])?$/.test(value) || value.length > 39) {
    throw new InvalidArgumentError(`Invalid GitHub username "${value}" — must match [A-Za-z0-9-], 1-39 chars.`);
  }
  return value.toLowerCase();
}
