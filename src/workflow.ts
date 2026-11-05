import { getAgentByName } from "agents";
import { AgentWorkflow } from "agents/workflows";
import type { AgentWorkflowEvent, AgentWorkflowStep } from "agents/workflows";
import { NonRetryableError } from "cloudflare:workflows";
import type { PolicyAgent } from "./agent";
import {
  MAX_POLICY_CHARS,
  type ChunkFindings,
  chunkText,
  extractFindings,
  htmlToText,
  synthesizeReport,
} from "./analysis";
import { toSummary, type PolicySummary } from "./shared";

export interface AnalyzeParams {
  id: string;
  url: string;
}

/**
 * Reads a privacy policy end to end.
 *
 * Why a Workflow and not a plain tool call: a long policy needs 10+ LLM calls
 * and can take a minute or more. Each section is its own durable step, so if
 * section 9 fails, the retry resumes at section 9 instead of re-reading the
 * whole document, and the user's chat stays responsive meanwhile.
 */
export class AnalyzePolicyWorkflow extends AgentWorkflow<PolicyAgent, AnalyzeParams> {
  async run(event: AgentWorkflowEvent<AnalyzeParams>, step: AgentWorkflowStep) {
    const { id, url } = event.payload;

    await this.reportProgress({ step: "fetch", percent: 0.03, message: "Fetching the page" });

    const sourceText = await step.do(
      "fetch-policy",
      { retries: { limit: 3, delay: "5 seconds", backoff: "exponential" }, timeout: "1 minute" },
      async () => {
        const res = await fetch(url, {
          redirect: "follow",
          headers: {
            "user-agent": "PrivacyLens/1.0 (privacy policy summarizer)",
            accept: "text/html,text/plain;q=0.9",
          },
        });
        if (res.status === 404 || res.status === 410) {
          throw new NonRetryableError(`The page returned ${res.status}. Check the link.`);
        }
        if (!res.ok) throw new Error(`The page returned ${res.status}`);

        const type = res.headers.get("content-type") ?? "";
        if (!/text\/(html|plain)|application\/xhtml/.test(type)) {
          throw new NonRetryableError(
            `This link returns ${type || "an unknown format"}. Use a link to a web page.`,
          );
        }
        const body = await res.text();
        const text = type.includes("html") ? htmlToText(body) : body;
        if (text.length < 800) {
          throw new NonRetryableError(
            "The page has almost no readable text. It may load its content with JavaScript; try a direct or printable version of the policy.",
          );
        }
        return text.slice(0, MAX_POLICY_CHARS);
      },
    );

    // Pure function of a durable step's output, so it is safe outside a step.
    const { chunks, truncated } = chunkText(sourceText);

    const findings: ChunkFindings[] = [];
    for (let i = 0; i < chunks.length; i++) {
      const sectionFindings = await step.do(
        `extract-section-${i}`,
        { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "2 minutes" },
        () => extractFindings(this.env.AI, chunks[i], i, chunks.length),
      );
      findings.push(sectionFindings);
      await this.reportProgress({
        step: "extract",
        percent: 0.05 + 0.8 * ((i + 1) / chunks.length),
        message: `Read section ${i + 1} of ${chunks.length}`,
      });
    }

    await this.reportProgress({ step: "synthesize", percent: 0.9, message: "Writing the report" });

    const report = await step.do(
      "synthesize-report",
      { retries: { limit: 3, delay: "10 seconds", backoff: "exponential" }, timeout: "3 minutes" },
      () => synthesizeReport(this.env.AI, { id, url, findings, sourceText, truncated }),
    );

    await step.do("save-to-library", async () => {
      const library = await getAgentByName(this.env.PolicyLibrary, "global");
      await library.save(report);
    });

    const summary: PolicySummary = toSummary(report);
    await step.reportComplete(summary);
    return summary;
  }
}
