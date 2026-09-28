import type { EvidenceRef } from '../types.js';

/**
 * Renders a citation token for the book. PR/issue/review numbers collide across
 * repositories, so when the book spans more than one repo the ref is qualified
 * with its `owner/name` prefix (e.g. `acme/api#123`) — commit shas are unique
 * enough not to need it.
 */
export function formatRef(ref: EvidenceRef, multiRepo: boolean): string {
  const needsRepo = multiRepo && ref.repo && /(^|\s)#\d+/.test(ref.ref) && !ref.ref.includes('/');
  if (!needsRepo || !ref.repo) {
    return ref.ref;
  }
  return ref.ref.replace(/(^|\s)(#\d+)/g, (_match, lead: string, num: string) => `${lead}${ref.repo}${num}`);
}

export function evidenceLink(ref: EvidenceRef, multiRepo: boolean): string {
  const label = formatRef(ref, multiRepo);
  return ref.url ? `[\`${label}\`](${ref.url})` : `\`${label}\``;
}

/** Bracketed citation token as it appears in chapter prose. */
export function evidenceToken(ref: EvidenceRef, multiRepo: boolean): string {
  return `[${formatRef(ref, multiRepo)}]`;
}
