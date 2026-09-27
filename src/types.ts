/**
 * Domain types for Handover.
 *
 * Everything in the rendered book must trace back to one of these collected
 * records — that is the evidence-chain rule from the project plan (§3.4).
 */

export interface CommitFile {
  path: string;
  additions: number;
  deletions: number;
}

export interface CommitRecord {
  sha: string;
  repo: string; // owner/name
  authorLogin: string; // "unknown" when GitHub cannot attribute the commit
  authoredAt: string; // ISO timestamp
  message: string;
  additions: number;
  deletions: number;
  files: CommitFile[];
}

export interface ReviewCommentRecord {
  id: number;
  reviewId: number;
  path: string;
  body: string;
  authorLogin: string;
}

export interface ReviewRecord {
  id: number;
  repo: string;
  prNumber: number;
  reviewerLogin: string; // "unknown" when GitHub cannot attribute the review
  state: string; // APPROVED | CHANGES_REQUESTED | COMMENTED | DISMISSED
  submittedAt: string | null;
  body: string;
  comments: ReviewCommentRecord[];
}

export interface CommentRecord {
  id: number;
  number: number; // issue or PR number (shared GitHub namespace)
  authorLogin: string;
  createdAt: string;
  body: string;
}

export interface IssueRecord {
  repo: string;
  number: number;
  title: string;
  authorLogin: string;
  state: string;
  createdAt: string;
  closedAt: string | null;
  labels: string[];
  comments: CommentRecord[];
  /** true for rows that mirror a pull request (GitHub shares one number namespace) */
  isPullRequest?: boolean;
  /** last GitHub-side activity; used to decide whether the cached row is still current */
  updatedAt?: string | null;
}

export interface PullRequestRecord {
  repo: string;
  number: number;
  title: string;
  authorLogin: string;
  state: string;
  createdAt: string;
  mergedAt: string | null;
  body: string;
  additions: number;
  deletions: number;
  changedFiles: number;
  /** last GitHub-side activity; used to decide whether the cached row is still current */
  updatedAt?: string | null;
}

/** A module is the top-level directory of a changed file; root files form the "(root)" module. */
export type ModuleName = string;

export type EvidenceKind = 'commit' | 'pr' | 'review' | 'issue' | 'comment';

export interface EvidenceRef {
  kind: EvidenceKind;
  /** commit sha (short), "#123" for PR/issue, "review:456" for a review */
  ref: string;
  url?: string;
  excerpt?: string;
}

export interface RiskFactor {
  /** share of the module's commits authored by the departing engineer, 0..1 */
  soleContributionRatio: number;
  /** normalized commit activity in the look-back window, 0..1 */
  changeFrequency: number;
  /** >= 1, bumped when the module's commits reference bug-labelled issues */
  incidentWeight: number;
  /** >= 1 multiplier: +0.5 sole reviewer, +0.25 sole author */
  irreplaceability: number;
}

export interface RiskItem {
  rank: number;
  /** keyed as "owner/name:module" when multiple repos are in scope */
  module: ModuleName;
  score: number;
  factors: RiskFactor;
  evidence: EvidenceRef[];
  /** human-readable justification; must cite the refs in `evidence` */
  rationale: string;
}

export type ChapterId = 1 | 2 | 3 | 4 | 5 | 6;

export interface BookChapter {
  id: ChapterId;
  title: string;
  /** markdown body */
  content: string;
  evidence: EvidenceRef[];
  generatedBy: 'llm' | 'deterministic';
}

export interface HandoverBook {
  username: string;
  repos: string[];
  generatedAt: string;
  chapters: BookChapter[];
  /** set when any chapter was LLM-synthesized — the rendered privacy note depends on it */
  llmProvider?: string;
  llmModel?: string;
}
