import path from 'node:path';
import { realpathSync } from 'node:fs';

export type LlmProviderName = 'openai' | 'anthropic' | 'ollama';

export interface HandoverConfig {
  githubToken: string;
  provider: LlmProviderName;
  model: string;
  ollamaUrl: string;
  /** directory holding the per-person SQLite index and the generated book */
  dataDir: string;
  /** scrub known secret formats from the LLM digest and the rendered book */
  redact: boolean;
  /** skip LLM synthesis entirely — deterministic chapters only, nothing leaves the machine */
  noLlm: boolean;
  /** Per-request timeout for GitHub calls; a hung connection must not stall a collect. */
  githubTimeoutMs: number;
  /** Per-request timeout for one LLM completion (retries are on top of this). */
  llmTimeoutMs: number;
  /**
   * Base URL override for GitHub Enterprise Server. Validated before use: it is
   * where GITHUB_TOKEN is sent, so an unattended environment variable must not
   * be able to point the token at an arbitrary host.
   */
  githubApiUrl?: string;
}

export const DEFAULT_MODELS: Record<LlmProviderName, string> = {
  openai: 'gpt-4o-mini',
  anthropic: 'claude-sonnet-4-5',
  ollama: 'llama3.2',
};

const PROVIDERS: readonly LlmProviderName[] = ['openai', 'anthropic', 'ollama'];

/** Hosts GITHUB_API_URL may point at; anything else is refused. */
const GITHUB_API_HOSTS = new Set(['api.github.com']);

function env(name: string): string | undefined {
  const value = process.env[name];
  return value === undefined || value === '' ? undefined : value;
}

/** A positive integer, or the default when unset/invalid — timeouts are not worth failing a run over. */
function envNumber(name: string, fallback: number): number {
  const raw = env(name);
  if (raw === undefined) {
    return fallback;
  }
  const value = Number(raw);
  return Number.isInteger(value) && value > 0 ? value : fallback;
}

function truthy(name: string): boolean {
  return /^(1|true|yes)$/i.test(env(name) ?? '');
}

/**
 * Realpath when the path exists — a symlinked or junctioned segment must not
 * launder a path past the root check — and a plain resolve for directories that
 * do not exist yet (a dataDir is created after confinement). For a
 * not-yet-existing path the deepest *existing* ancestor is resolved, so a
 * junction below the allowed root still cannot carry a yet-to-be-created
 * subdirectory outside it.
 */
export function canonicalize(value: string): string {
  try {
    return realpathSync(value);
  } catch {
    let dir = path.dirname(value);
    const tail = [path.basename(value)];
    for (;;) {
      try {
        const base = realpathSync(dir);
        return `${base}${path.sep}${tail.join(path.sep)}`;
      } catch {
        const basename = path.basename(dir);
        const parent = path.dirname(dir);
        if (basename === '' || parent === dir) {
          // reached the filesystem root without finding anything real
          return path.resolve(value);
        }
        tail.unshift(basename);
        dir = parent;
      }
    }
  }
}

/** Windows paths compare case-insensitively; everywhere else they do not. */
export function sameOrBelow(candidate: string, root: string): boolean {
  const fold = process.platform === 'win32';
  const c = fold ? candidate.toLowerCase() : candidate;
  const r = fold ? root.toLowerCase() : root;
  return c === r || c.startsWith(r.endsWith(path.sep) ? r : r + path.sep);
}

/**
 * GITHUB_API_URL is the destination of the Authorization header, so a stray or
 * injected value would hand GITHUB_TOKEN to any host. Only https, no
 * credentials in the URL, and either api.github.com or an explicitly configured
 * Enterprise host (HANDOVER_GHE_HOST) are accepted.
 */
export function parseGitHubApiUrl(value: string): string {
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw new Error(`GITHUB_API_URL "${value}" is not a valid URL`);
  }
  if (url.protocol !== 'https:') {
    throw new Error(`GITHUB_API_URL must use https (got "${url.protocol}//${url.host}") — the GitHub token would be sent in the clear`);
  }
  if (url.username || url.password) {
    throw new Error('GITHUB_API_URL must not embed credentials');
  }
  const allowed = new Set([
    ...GITHUB_API_HOSTS,
    ...(env('HANDOVER_GHE_HOST') ?? '').split(',').map((host) => host.trim().toLowerCase()).filter(Boolean),
  ]);
  // Compare the host *with* its port: hostname-only matching would wave
  // `https://api.github.com:8443/` through and send GITHUB_TOKEN to a port the
  // allow-list never meant. A bare entry covers the default (or omitted) port;
  // an explicit `host:port` entry is the only way to allow a non-default one.
  const hostname = url.hostname.toLowerCase();
  const portAllowed =
    url.port === '' || url.port === '443'
      ? allowed.has(hostname)
      : allowed.has(`${hostname}:${url.port}`);
  if (!portAllowed) {
    throw new Error(
      `GITHUB_API_URL points at "${url.host}", which is not api.github.com — set HANDOVER_GHE_HOST=<your-enterprise-host> to allow your GitHub Enterprise Server instance`,
    );
  }
  return url.toString().replace(/\/+$/, '');
}

/**
 * Confine a data directory offered by a model-supplied tool argument.
 *
 * The CLI does not need this — there, the person typing --data-dir is the one
 * authorizing it. The MCP server is different: `dataDir` arrives from a model,
 * and the pipeline mkdir's it and writes `<user>.db` plus the book into it, so
 * an injected instruction could otherwise create directories and clobber files
 * anywhere the process can write. The root is the directory the server was
 * launched from; an operator may add exactly one more with HANDOVER_DATA_ROOT.
 */
export function confineDataDir(value: string, roots: string[] = defaultDataDirRoots()): string {
  if (value.includes('\0')) {
    throw new Error('dataDir must not contain a NUL byte');
  }
  const resolved = canonicalize(value);
  const allowed = roots.map(canonicalize);
  if (!allowed.some((root) => sameOrBelow(resolved, root))) {
    throw new Error(
      `dataDir "${value}" is outside the permitted roots (${allowed.join(', ')}) — run handover-mcp from the directory that should hold the index, or set HANDOVER_DATA_ROOT`,
    );
  }
  return resolved;
}

function defaultDataDirRoots(): string[] {
  return [process.cwd(), ...(env('HANDOVER_DATA_ROOT') ? [env('HANDOVER_DATA_ROOT')!] : [])];
}

function defaultGitDirRoots(): string[] {
  return [
    process.cwd(),
    ...(env('HANDOVER_DATA_ROOT') ? [env('HANDOVER_DATA_ROOT')!] : []),
    ...(env('HANDOVER_GIT_ROOT') ?? '').split(',').map((root) => root.trim()).filter(Boolean),
  ];
}

/**
 * Confine a local git clone directory offered by a model-supplied tool argument.
 *
 * `gitDirs` points the collector at any git repository on disk — `git log` then
 * reads every commit message, path and author inside it and the results reach
 * the model's transcript — so a prompt-injected tool call must not aim it at an
 * arbitrary clone on the machine. Like dataDir, the roots are the directory the
 * server was launched from and HANDOVER_DATA_ROOT; because clones usually live
 * outside the workspace, an operator may add more with a comma-separated
 * HANDOVER_GIT_ROOT. Existing symlinks/junctions are resolved before the check.
 */
export function confineGitDir(value: string, roots: string[] = defaultGitDirRoots()): string {
  if (value.includes('\0')) {
    throw new Error('gitDir must not contain a NUL byte');
  }
  const resolved = canonicalize(value);
  const allowed = roots.map(canonicalize);
  if (!allowed.some((root) => sameOrBelow(resolved, root))) {
    throw new Error(
      `gitDir "${value}" is outside the permitted roots (${allowed.join(', ')}) — run handover-mcp from the directory that holds the clones, or set HANDOVER_GIT_ROOT=<allowed clone directories>`,
    );
  }
  return resolved;
}

export function loadConfig(overrides: Partial<HandoverConfig> = {}): HandoverConfig {
  const providerName: string = overrides.provider ?? env('HANDOVER_PROVIDER') ?? 'anthropic';
  if (!(PROVIDERS as readonly string[]).includes(providerName)) {
    throw new Error(`Unknown LLM provider "${providerName}" (expected one of: ${PROVIDERS.join(', ')})`);
  }
  const provider = providerName as LlmProviderName;
  const githubApiUrl = overrides.githubApiUrl ?? env('GITHUB_API_URL');
  return {
    githubToken: overrides.githubToken ?? env('GITHUB_TOKEN') ?? '',
    provider,
    model: overrides.model ?? env('HANDOVER_MODEL') ?? DEFAULT_MODELS[provider],
    ollamaUrl: overrides.ollamaUrl ?? env('OLLAMA_URL') ?? 'http://localhost:11434',
    dataDir: overrides.dataDir ?? env('HANDOVER_DATA_DIR') ?? 'handover-data',
    githubTimeoutMs: overrides.githubTimeoutMs ?? envNumber('HANDOVER_GITHUB_TIMEOUT_MS', 60_000),
    llmTimeoutMs: overrides.llmTimeoutMs ?? envNumber('HANDOVER_LLM_TIMEOUT_MS', 120_000),
    // Redaction is on by default: the digest and the book quote raw repository
    // text, and a committed secret should not be copied onward by accident.
    // HANDOVER_REDACT=1 is the legacy explicit-on spelling (it is in every
    // translated README) — it is simply redundant now, and only the opt-out
    // changes behavior.
    redact: overrides.redact ?? !truthy('HANDOVER_NO_REDACT'),
    // LLM synthesis is opt-in. A developer who already exports ANTHROPIC_API_KEY
    // for other tooling must not have their repositories uploaded by the first
    // `handover gen` they ever run.
    // HANDOVER_NO_LLM is the 0.1.2-era explicit-off spelling that every translated
    // README promises; it is honoured, and wins over HANDOVER_LLM when both are in
    // the environment — an inherited "stay offline" must never be outranked.
    noLlm: overrides.noLlm ?? (truthy('HANDOVER_NO_LLM') ? true : truthy('HANDOVER_LLM') ? false : true),
    githubApiUrl: githubApiUrl ? parseGitHubApiUrl(githubApiUrl) : undefined,
  };
}
