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
 * would otherwise parse silently. Zoneless date-times are normalized to UTC —
 * new Date() parses them as local time, while date-only forms are UTC per the
 * ES spec, so "2024-01-01" and "2024-01-01T00:00" would otherwise disagree by
 * the machine's UTC offset.
 */
/**
 * Validate an ISO date or date-time and normalize it to UTC. Throws a plain
 * Error; the CLI wraps it in InvalidArgumentError, and the git collector calls
 * it directly so a library caller cannot reach git with a weaker check than the
 * one the flag itself enforces.
 */
export function normalizeSince(value: string): string {
  const isoRe = /^(\d{4}-\d{2}-\d{2})(T(\d{2}):(\d{2})(:(\d{2})(\.\d+)?)?(Z|[+-]\d{2}:?\d{2})?)?$/;
  const match = isoRe.exec(value);
  if (!match) {
    throw new Error('--since expects an ISO date, e.g. 2024-01-01 or 2024-01-01T10:00:00Z');
  }
  // Date.parse rolls impossible dates over (2024-02-30 → Mar 1, T24:00 → next
  // day) instead of rejecting them; check the calendar fields directly.
  const [, datePart, , hh, mm, , ss] = match;
  const [year, month, day] = datePart!.split('-').map(Number);
  const asUtc = new Date(Date.UTC(year!, month! - 1, day!));
  if (asUtc.getUTCFullYear() !== year || asUtc.getUTCMonth() !== month! - 1 || asUtc.getUTCDate() !== day!) {
    throw new Error(`--since "${value}" is not a real calendar date`);
  }
  if (Number(hh) > 23 || Number(mm) > 59 || Number(ss ?? 0) > 59) {
    throw new Error(`--since "${value}" has an out-of-range time component (T24:00, T10:60 …)`);
  }
  const zoneless = match[2] !== undefined && !/(Z|[+-]\d{2}:?\d{2})$/.test(value);
  const date = new Date(zoneless ? `${value}Z` : value);
  if (Number.isNaN(date.getTime())) {
    throw new Error('--since expects an ISO date, e.g. 2024-01-01');
  }
  return date.toISOString();
}

/** The CLI face of {@link normalizeSince}: same rules, commander-shaped failure. */
export function parseSince(value: string): string {
  try {
    return normalizeSince(value);
  } catch (error) {
    throw new InvalidArgumentError(error instanceof Error ? error.message : String(error));
  }
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
