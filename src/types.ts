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
  /** head branch sha; covers new commits pushed (which updated_at does not bump) */
  headSha?: string | null;
}

/** A module is the top-level directory of a changed file; root files form the "(root)" module. */
export type ModuleName = string;

/** A first-person answer captured from the departing engineer (handover capture). */
export interface CapturedAnswer {
  id: number;
  question: string;
  answer: string;
  capturedAt: string;
}

export type EvidenceKind = 'commit' | 'pr' | 'review' | 'issue' | 'comment';

export interface EvidenceRef {
  kind: EvidenceKind;
  /** commit sha (short), "#123" for PR/issue, "review:456" or "#123 review:456" for a review */
  ref: string;
  url?: string;
  excerpt?: string;
  /**
   * owner/name of the repository the ref points into. Optional for backwards
   * compatibility, but set by the risk engine so multi-repo books can render
   * unambiguous refs like `owner/name#123`.
   */
  repo?: string;
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

/** What the collected data covers — rendered on the book's action page so the reader knows the limits up front. */
export interface BookCoverage {
  /** repositories in scope, as recorded for this book */
  repos: string[];
  /** where the data came from, e.g. "GitHub API", "local git clones" */
  sources: string[];
  /** earliest and latest commit author dates in the index (ISO, or null when no commits) */
  commitWindow: { from: string | null; to: string | null };
  counts: {
    commits: number;
    pullRequests: number;
    reviews: number;
    issues: number;
    /** comments on issues and PRs */
    comments: number;
    /** first-person answers recorded with `handover capture` */
    capturedAnswers: number;
  };
  /** distinct, attributed authors seen in the collected commits */
  contributors: number;
  /** commits no author could be attributed to (GitHub "unknown", mail patches, …) */
  unattributedCommits: number;
  /** human-readable gaps the reader must know before trusting the conclusions */
  gaps: string[];
}

/** One "confirm before the handover" entry on the book's action page. */
export interface ActionItem {
  /** module key as shown in the risk chapter ("owner/name:module") */
  module: string;
  /** observed signal, in one sentence */
  finding: string;
  /** the question the successor should have confirmed by the departing engineer */
  question: string;
  /** who is expected to confirm */
  confirmWith: string;
  /** concrete next step for the successor */
  nextStep: string;
  /** what Git history cannot show for this item */
  limitation: string;
  evidence: EvidenceRef[];
}

export interface HandoverBook {
  username: string;
  repos: string[];
  generatedAt: string;
  chapters: BookChapter[];
  /** set when any chapter was LLM-synthesized — the rendered privacy note depends on it */
  llmProvider?: string;
  llmModel?: string;
  /** true when secret-format scrubbing was applied to the digest and the rendered book */
  redacted?: boolean;
  /** data coverage statement for the action page */
  coverage?: BookCoverage;
  /** "confirm before the handover" entries for the action page */
  actions?: ActionItem[];
}
