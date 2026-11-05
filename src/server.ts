import { routeAgentRequest } from "agents";
import { createMcpHandler } from "agents/mcp/server";
import { createServer } from "./mcp";

export { PolicyAgent } from "./agent";
export { PolicyLibrary } from "./library";
export { AnalyzePolicyWorkflow } from "./workflow";

const mcpHandler = createMcpHandler(createServer, { route: "/mcp" });

export default {
  async fetch(request, env, ctx) {
    const { pathname } = new URL(request.url);

    if (pathname === "/mcp") {
      // Optional shared-secret protection. Set it with: npx wrangler secret put MCP_TOKEN
      // For real users, put OAuth in front instead (see README).
      const token = (env as { MCP_TOKEN?: string }).MCP_TOKEN;
      if (token && request.headers.get("authorization") !== `Bearer ${token}`) {
        return new Response("Unauthorized", {
          status: 401,
          headers: { "www-authenticate": "Bearer" },
        });
      }
      return mcpHandler(request, env, ctx);
    }

    // The shared library is internal and reachable only through Worker RPC.
    if (pathname.startsWith("/agents/policy-library")) {
      return new Response("Not found", { status: 404 });
    }

    return (
      (await routeAgentRequest(request, env)) ??
      new Response("Not found", { status: 404 })
    );
  },
} satisfies ExportedHandler<Env>;
