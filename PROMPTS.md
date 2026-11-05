# AI prompts used

AI-assisted coding was used to build this project. This file records the prompts, as the assignment asks.

**Keep this file honest and up to date.** Add every meaningful prompt you give an AI tool while working on the project, including follow-ups and fixes, in the order you used them. Reviewers mostly want to see how you directed the tool and what you decided yourself.

## Development prompts

### 1. Planning (Claude, claude.ai)

> We plan to fast track candidates who complete an assignment to build a type of AI-powered application on Cloudflare. An AI-powered application should include the following components: LLM (recommend using Llama 3.3 on Workers AI), or an external LLM of your choice; Workflow / coordination (recommend using Workflows, Workers or Durable Objects); User input via chat or voice (recommend using Pages or Realtime); Memory or state

Outcome: three project ideas. I chose to combine a privacy-policy analyst with an MCP server.

### 2. Scaffold (Claude, claude.ai)

> lets combine the two

Outcome: initial scaffold (agent, workflow, shared library, MCP server, chat UI, README). Checked against the current Agents SDK docs, type-checked, and smoke-tested the MCP endpoint locally.

### 3. …

<!-- Add the rest of your prompts here as you go. For each one, note what you changed or rejected. -->

## Prompts used by the application at runtime

These are part of the product, not the development process. They live in the code:

- Section extraction prompt: `EXTRACT_PROMPT` in `src/analysis.ts`
- Report synthesis prompt: `SYNTHESIZE_PROMPT` in `src/analysis.ts`
- Chat agent system prompt: in `onChatMessage` in `src/agent.ts`
- MCP question-answering prompt: in the `ask_about_policy` tool in `src/mcp.ts`
