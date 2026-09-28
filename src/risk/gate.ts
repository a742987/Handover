import { moduleOf } from './engine.js';
import type { EvidenceRef, RiskItem } from '../types.js';

export interface GateMatch {
  /** "repo:module" key */
  module: string;
  score: number;
  rationale: string;
  evidence: EvidenceRef[];
}

/**
 * Which of the ranked sole-owner modules appear in a changed-file list.
 * Paths are repo-relative (as `gh pr diff --name-only` prints them); a risk
 * module "owner/name:dir" matches when any path's top-level dir is `dir`.
 */
export function matchTouchedModules(risks: RiskItem[], changedPaths: string[]): GateMatch[] {
  const touched = new Set<string>();
  for (const p of changedPaths) {
    const trimmed = p.trim();
    if (trimmed) {
      touched.add(moduleOf(trimmed));
    }
  }
  return risks
    .filter((risk) => {
      const colon = risk.module.indexOf(':');
      const moduleName = colon === -1 ? risk.module : risk.module.slice(colon + 1);
      return touched.has(moduleName);
    })
    .map((risk) => ({
      module: risk.module,
      score: risk.score,
      rationale: risk.rationale,
      evidence: risk.evidence,
    }));
}

/** Markdown PR-comment body listing the risky touched modules. */
export function renderGateComment(matches: GateMatch[], username: string): string {
  if (matches.length === 0) {
    return `**Handover gate:** this PR does not touch modules @${username} solely owns. No handover review needed.`;
  }
  const lines = [
    `**Handover gate** — this PR touches ${matches.length} module(s) that @${username} still solely owns.`,
    '',
    'The knowledge here has no second author or reviewer yet; ask them to walk you through it before their last day.',
    '',
  ];
  for (const match of matches) {
    lines.push(`- \`${match.module}\` (risk ${match.score.toFixed(3)})`);
    for (const ref of match.evidence.slice(0, 3)) {
      lines.push(`  - ${ref.ref}${ref.url ? ` — ${ref.url}` : ''}`);
    }
  }
  return lines.join('\n');
}
