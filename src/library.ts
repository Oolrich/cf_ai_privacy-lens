import { Agent } from "agents";
import { toSummary, type PolicyReport, type PolicySummary } from "./shared";

/**
 * One shared library of finished reports, keyed by a hash of the policy URL.
 *
 * A policy reads the same for every user, so analyses are cached here once
 * and reused by every chat session and every MCP client. Per-user memory
 * (chat history, which policies *you* looked at) lives in PolicyAgent.
 *
 * This Durable Object is only reachable through RPC from inside the Worker;
 * server.ts blocks its public /agents route.
 */
export class PolicyLibrary extends Agent<Env> {
  private tableReady = false;

  private ensureTable() {
    if (this.tableReady) return;
    this.sql`CREATE TABLE IF NOT EXISTS reports (
      id TEXT PRIMARY KEY,
      url TEXT NOT NULL,
      company TEXT NOT NULL,
      risk_score INTEGER NOT NULL,
      report TEXT NOT NULL,
      analyzed_at INTEGER NOT NULL
    )`;
    this.tableReady = true;
  }

  async save(report: PolicyReport): Promise<void> {
    this.ensureTable();
    this.sql`INSERT INTO reports (id, url, company, risk_score, report, analyzed_at)
      VALUES (${report.id}, ${report.url}, ${report.company}, ${report.riskScore},
              ${JSON.stringify(report)}, ${report.analyzedAt})
      ON CONFLICT(id) DO UPDATE SET
        url = excluded.url,
        company = excluded.company,
        risk_score = excluded.risk_score,
        report = excluded.report,
        analyzed_at = excluded.analyzed_at`;
  }

  async get(id: string): Promise<PolicyReport | null> {
    this.ensureTable();
    const rows = this.sql<{ report: string }>`SELECT report FROM reports WHERE id = ${id}`;
    return rows[0] ? (JSON.parse(rows[0].report) as PolicyReport) : null;
  }

  async list(limit = 50): Promise<PolicySummary[]> {
    this.ensureTable();
    const safeLimit = Math.min(Math.max(1, Math.floor(limit)), 200);
    const rows = this.sql<{ report: string }>`
      SELECT report FROM reports ORDER BY analyzed_at DESC LIMIT ${safeLimit}`;
    return rows.map((row) => toSummary(JSON.parse(row.report) as PolicyReport));
  }
}
