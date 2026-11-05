import { McpServer } from "@modelcontextprotocol/server";
import { getAgentByName } from "agents";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { MODEL, normalizePolicyUrl, resolvePolicyRef } from "./analysis";

/** The PolicyAgent instance that owns analyses requested over MCP. */
const MCP_AGENT_NAME = "mcp-requests";

const asText = (value: unknown) => ({
  content: [
    {
      type: "text" as const,
      text: typeof value === "string" ? value : JSON.stringify(value, null, 2),
    },
  ],
});

const asError = (message: string) => ({ ...asText(message), isError: true });

const errorMessage = (err: unknown) => (err instanceof Error ? err.message : String(err));

/**
 * The same reports the chat UI produces, exposed to any MCP client
 * (Claude, Cursor, an internal agent). A new server per request, as the
 * stateless MCP handler requires; durable data lives in PolicyLibrary.
 */
export function createServer() {
  const server = new McpServer({ name: "privacy-lens", version: "1.0.0" });
  const library = () => getAgentByName(env.PolicyLibrary, "global");

  server.registerTool(
    "list_analyzed_policies",
    {
      description: "List privacy policies that have already been analyzed, newest first, with their risk scores.",
      inputSchema: z.object({
        limit: z.number().int().min(1).max(100).optional().describe("Maximum results, default 25"),
      }),
    },
    async ({ limit }) => asText(await (await library()).list(limit ?? 25)),
  );

  server.registerTool(
    "get_policy_report",
    {
      description:
        "Get the full report for an analyzed privacy policy: summary, risk score, data collected, sharing, retention, user rights, and red flags with verbatim quotes.",
      inputSchema: z.object({
        policy: z.string().describe("Policy URL or report id"),
      }),
    },
    async ({ policy }) => {
      try {
        const report = await (await library()).get(await resolvePolicyRef(policy));
        return report ? asText(report) : asError("Not analyzed yet. Call analyze_policy with the URL first.");
      } catch (err) {
        return asError(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "ask_about_policy",
    {
      description: "Answer a question about an analyzed privacy policy, grounded only in its report.",
      inputSchema: z.object({
        policy: z.string().describe("Policy URL or report id"),
        question: z.string().max(500),
      }),
    },
    async ({ policy, question }) => {
      try {
        const report = await (await library()).get(await resolvePolicyRef(policy));
        if (!report) return asError("Not analyzed yet. Call analyze_policy with the URL first.");
        const answer = (await (env.AI as unknown as {
          run: (model: string, input: unknown) => Promise<{ response?: string }>;
        }).run(MODEL, {
          messages: [
            {
              role: "system",
              content:
                "Answer the question using only this privacy policy report. Quote red flags exactly when relevant. If the report does not cover the question, say so. You are not giving legal advice.",
            },
            { role: "user", content: `Report:\n${JSON.stringify(report)}\n\nQuestion: ${question}` },
          ],
          max_tokens: 800,
          temperature: 0.2,
        })) as { response?: string };
        return asText(answer.response ?? "No answer was generated.");
      } catch (err) {
        return asError(errorMessage(err));
      }
    },
  );

  server.registerTool(
    "analyze_policy",
    {
      description:
        "Start analyzing a privacy policy by URL. Returns the report if a recent one exists; otherwise the analysis runs in the background (about a minute) and get_policy_report returns it when finished.",
      inputSchema: z.object({
        url: z.string().describe("Full URL of the privacy policy page"),
      }),
    },
    async ({ url }) => {
      try {
        // Validate here so bad input fails fast instead of inside the Durable Object.
        await normalizePolicyUrl(url);
        const agent = await getAgentByName(env.PolicyAgent, MCP_AGENT_NAME);
        const outcome = await agent.startAnalysis(url);
        return outcome.status === "cached"
          ? asText(outcome.report)
          : asText({ status: outcome.status, url: outcome.url, next: "Call get_policy_report in about a minute." });
      } catch (err) {
        return asError(errorMessage(err));
      }
    },
  );

  return server;
}
