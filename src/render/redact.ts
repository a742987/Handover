/**
 * Best-effort secret scrubbing for content leaving the machine — into the LLM
 * digest and into the rendered book. It is a redaction layer, not a guarantee:
 * anything already committed in plaintext can also carry secrets the patterns
 * below do not know.
 */

export const REDACTED = '[REDACTED]';

/**
 * key/value assignments — the value may be bare, double-quoted, or
 * single-quoted, and the key may carry a JSON-style trailing quote
 * (`"api_key": "..."`, `db_password: '...'`, `token=...` all match).
 */
const KEY_VALUE_RE =
  /((?:[\w.-]*)(?:api[_-]?key|access[_-]?key|secret[_-]?key|auth[_-]?token|token|secret|password|passwd)(?:[\w.-]*)["']?)(\s*[:=]\s*)("[^"\n]{6,}"|'[^'\n]{6,}'|[^\s"',;\n]{6,})/gi;

const FORMAT_RES: RegExp[] = [
  /\b(?:ghp|gho|ghu|ghs|ghr)_[A-Za-z0-9]{20,}\b/g, // GitHub PATs
  /\bgithub_pat_[A-Za-z0-9_]{20,}\b/g, // fine-grained PATs
  /\bAKIA[0-9A-Z]{16}\b/g, // AWS access key ids
  /\bxox[baprs]-[A-Za-z0-9-]{10,}\b/g, // Slack tokens
  /\bglpat-[A-Za-z0-9_-]{20,}\b/g, // GitLab PATs
  /\bsk-ant-[A-Za-z0-9_-]{20,}/g, // Anthropic keys
  /\bsk-[A-Za-z0-9_-]{20,}/g, // OpenAI-style keys
  /\bAIza[0-9A-Za-z_-]{35,}\b/g, // Google API keys
  // no trailing \b: padding chars (=, ., /) are not word chars and would be left behind
  /\bBearer\s+[A-Za-z0-9._~+/=-]{16,}/gi, // bearer tokens
  /\bBEGIN\s+[A-Z0-9 ]*PRIVATE\s+KEY[\s\S]{0,4000}?END\s+[A-Z0-9 ]*PRIVATE\s+KEY\b/g, // key material
];

export function redact(text: string): string {
  let out = text.replace(KEY_VALUE_RE, (_match, name: string, sep: string) => `${name}${sep}${REDACTED}`);
  for (const pattern of FORMAT_RES) {
    out = out.replace(pattern, REDACTED);
  }
  return out;
}
