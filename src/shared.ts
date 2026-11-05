// Types shared by the Worker and the browser. Keep this file free of runtime
// imports so the client bundle can import it safely.

export interface RedFlag {
  issue: string;
  quote: string;
  /** true when the quote was found verbatim in the fetched policy text */
  verified: boolean;
}

export interface PolicyReport {
  id: string;
  url: string;
  company: string;
  summary: string;
  riskScore: number;
  riskRationale: string;
  dataCollected: string[];
  sharedWith: string[];
  retention: string[];
  userRights: string[];
  redFlags: RedFlag[];
  sectionsRead: number;
  /** true when the policy was longer than the analysis limit */
  truncated: boolean;
  analyzedAt: number;
}

export interface PolicySummary {
  id: string;
  url: string;
  company: string;
  riskScore: number;
  topConcern: string | null;
  analyzedAt: number;
}

export interface AnalysisJob {
  url: string;
  percent: number;
  message: string;
  startedAt: number;
}

export interface PolicyAgentState {
  /** Policies this user has analyzed, newest first. Synced to the browser. */
  library: PolicySummary[];
  /** Running analyses keyed by workflow instance id. */
  jobs: Record<string, AnalysisJob>;
}

export function toSummary(report: PolicyReport): PolicySummary {
  return {
    id: report.id,
    url: report.url,
    company: report.company,
    riskScore: report.riskScore,
    topConcern: report.redFlags[0]?.issue ?? null,
    analyzedAt: report.analyzedAt,
  };
}
