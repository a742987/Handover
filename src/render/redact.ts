/**
 * Best-effort secret scrubbing for content leaving the machine — into the LLM
 * digest and into the rendered book. It is a redaction layer, not a guarantee:
 * anything already committed in plaintext can also carry secrets the patterns
 * below do not know.
 */

export const REDACTED = '[REDACTED]';

const KEY_VALUE_RE =
  /((?:[\w.-]*)(?:api[_-]?key|access[_-]?key|secret[_-]?key|auth[_-]?token|token|secret|password|passwd)(?:[\w.-]*))(\s*[:=]\s*)"?[^\s"',;\n]{6,}"?/gi;

const FORMAT_RES: RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, // GitHub PATs
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // fine-grained PATs
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab PATs
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}\b/gi, // bearer tokens
  /\bBEGIN\s+[A-Z0-9 ]*PRIVATE\s+KEY[\s\S]{0,4000}?END\s+[A-Z0-9 ]*PRIVATE\s+KEY\b/g, // key material
];

export function redact(text: string): string {
  let out = text.replace(KEY_VALUE_RE, (_match, name: string, sep: string) => `${name}${sep}${REDACTED}`);
  for (const pattern of FORMAT_RES) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}
