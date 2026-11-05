import { AIChatAgent, type OnChatMessageOptions } from "@cloudflare/ai-chat";
import { getAgentByName } from "agents";
import { createAI } from "agents/models/ai-sdk";
import {
  convertToModelMessages,
  pruneMessages,
  stepCountIs,
  streamText,
  tool,
  type UIMessage,
} from "ai";
import { z } from "zod";
import {
  CACHE_TTL_MS,
  MODEL,
  normalizePolicyUrl,
  resolvePolicyRef,
} from "./analysis";
import {
  toSummary,
  type PolicyAgentState,
  type PolicyReport,
  type PolicySummary,
} from "./shared";

export type StartAnalysisResult =
  | { status: "cached"; report: PolicyReport }
  | { status: "started" | "already_running"; instanceId: string; url: string };

/**
 * One instance per user (the browser picks a stable random name).
 *
 * Memory lives in two places:
 * - chat history, persisted to this instance's SQLite by AIChatAgent
 * - `state.library`, the policies this user has analyzed, synced live to the UI
 */
export class PolicyAgent extends AIChatAgent<Env, PolicyAgentState> {
  initialState: PolicyAgentState = { library: [], jobs: {} };
  maxPersistedMessages = 200;

  private library() {
    return getAgentByName(this.env.PolicyLibrary, "global");
  }

  /**
   * Returns a cached report when a fresh one exists; otherwise starts the
   * durable analysis Workflow. Also used by the MCP server's analyze tool.
   */
  async startAnalysis(
    rawUrl: string,
    options: { force?: boolean } = {},
  ): Promise<StartAnalysisResult> {
    const { id, url } = await normalizePolicyUrl(rawUrl);

    if (!options.force) {
      const cached = await (await this.library()).get(id);
      if (cached && Date.now() - cached.analyzedAt < CACHE_TTL_MS) {
        this.remember(toSummary(cached));
        return { status: "cached", report: cached };
      }
    }

    const running = Object.entries(this.state.jobs).find(([, job]) => job.url === url);
    if (running) return { status: "already_running", instanceId: running[0], url };

    const instanceId = await this.runWorkflow(
      "ANALYZE_POLICY",
      { id, url },
      { metadata: { url } },
    );
    this.setState({
      ...this.state,
      jobs: {
        ...this.state.jobs,
        [instanceId]: { url, percent: 0, message: "Queued", startedAt: Date.now() },
      },
    });
    return { status: "started", instanceId, url };
  }

  private remember(summary: PolicySummary) {
    const library = [summary, ...this.state.library.filter((p) => p.id !== summary.id)]
      .sort((a, b) => b.analyzedAt - a.analyzedAt)
      .slice(0, 50);
    this.setState({ ...this.state, library });
  }

  private dropJob(instanceId: string) {
    const { [instanceId]: _finished, ...jobs } = this.state.jobs;
    this.setState({ ...this.state, jobs });
    return _finished;
  }

  /** Posts a message into the chat without starting a model turn. */
  private async postAssistantNote(text: string) {
    const note: UIMessage = {
      id: crypto.randomUUID(),
      role: "assistant",
      parts: [{ type: "text", text }],
    };
    await this.persistMessages([...this.messages, note]);
  }

  // --- Workflow callbacks ---------------------------------------------------

  async onWorkflowProgress(_workflow: string, instanceId: string, progress: unknown) {
    const job = this.state.jobs[instanceId];
    if (!job) return;
    const p = progress as { percent?: number; message?: string };
    this.setState({
      ...this.state,
      jobs: {
        ...this.state.jobs,
        [instanceId]: {
          ...job,
          percent: typeof p.percent === "number" ? p.percent : job.percent,
          message: p.message ?? job.message,
        },
      },
    });
  }

  async onWorkflowComplete(_workflow: string, instanceId: string, result?: unknown) {
    this.dropJob(instanceId);
    const summary = result as PolicySummary | undefined;
    if (!summary?.id) return;
    this.remember(summary);
    const concern = summary.topConcern ? ` The biggest concern: ${summary.topConcern}.` : "";
    await this.postAssistantNote(
      `I finished reading ${summary.company}'s privacy policy. Risk score: ${summary.riskScore}/10.${concern} Ask me what it says about selling your data, how long it keeps it, or how to delete it.`,
    );
  }

  async onWorkflowError(_workflow: string, instanceId: string, error: string) {
    const job = this.dropJob(instanceId);
    const host = job ? new URL(job.url).hostname : "that page";
    await this.postAssistantNote(`I couldn't analyze the policy at ${host}. ${error}`);
  }

  // --- Chat -----------------------------------------------------------------

  async onChatMessage(
    _onFinish: Parameters<AIChatAgent["onChatMessage"]>[0],
    options?: OnChatMessageOptions,
  ) {
    const ai = createAI({ binding: this.env.AI });

    const known = this.state.library.length
      ? this.state.library
          .map((p) => `- id ${p.id}: ${p.company}, risk ${p.riskScore}/10, ${p.url}`)
          .join("\n")
      : "None yet.";
    const running = Object.values(this.state.jobs).map((j) => `- ${j.url} (${j.message})`);

    const system = `You are Privacy Lens. You explain website privacy policies to people who are not lawyers.

How to work:
- When the user shares a link to a privacy policy, call analyze_policy. If it starts a background analysis, tell the user in one sentence that you're reading the policy and will post the results here, then stop.
- To answer any question about a policy, call get_report first and base your answer only on that report. Never invent policy terms.
- When you quote a policy, copy the quote exactly and wrap it in **double asterisks** so the interface highlights it. Use bold for nothing else. If a red flag has verified: false, say that the quote could not be matched to the page text.
- To compare policies, call compare_policies and lead with the differences that matter most.
- Keep answers short and concrete. You are not a lawyer; say so if the user asks for legal advice.

Policies this user has analyzed:
${known}
${running.length ? `\nStill being read:\n${running.join("\n")}` : ""}`;

    const result = streamText({
      model: ai(MODEL),
      system,
      messages: pruneMessages({
        messages: await convertToModelMessages(this.messages),
        toolCalls: "before-last-2-messages",
      }),
      abortSignal: options?.abortSignal,
      stopWhen: stepCountIs(5),
      tools: {
        analyze_policy: tool({
          description:
            "Analyze a privacy policy from its URL. Returns the report right away if it was analyzed recently; otherwise starts a background analysis that posts results to the chat when done.",
          inputSchema: z.object({
            url: z.string().describe("Full URL of the privacy policy page"),
            force: z
              .boolean()
              .optional()
              .describe("Re-read the page even if a recent report exists"),
          }),
          execute: async ({ url, force }) => {
            try {
              const outcome = await this.startAnalysis(url, { force });
              if (outcome.status === "cached") return { status: "ready", report: outcome.report };
              return {
                status: outcome.status,
                note: "Reading takes about a minute. Results will be posted in this chat automatically.",
              };
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) };
            }
          },
        }),

        get_report: tool({
          description: "Get the full analysis report for a policy the user has analyzed.",
          inputSchema: z.object({
            policy: z.string().describe("The report id or the policy URL"),
          }),
          execute: async ({ policy }) => {
            try {
              const report = await (await this.library()).get(await resolvePolicyRef(policy));
              return report ?? { error: "No report for that policy yet. Call analyze_policy first." };
            } catch (err) {
              return { error: err instanceof Error ? err.message : String(err) };
            }
          },
        }),

        compare_policies: tool({
          description: "Get reports for two or three policies so you can compare them.",
          inputSchema: z.object({
            policies: z
              .array(z.string())
              .min(2)
              .max(3)
              .describe("Report ids or policy URLs"),
          }),
          execute: async ({ policies }) => {
            const library = await this.library();
            const reports = await Promise.all(
              policies.map(async (ref) => {
                try {
                  return (await library.get(await resolvePolicyRef(ref))) ?? { ref, error: "Not analyzed yet" };
                } catch (err) {
                  return { ref, error: err instanceof Error ? err.message : String(err) };
                }
              }),
            );
            return { reports };
          },
        }),
      },
    });

    return result.toUIMessageStreamResponse();
  }
}
