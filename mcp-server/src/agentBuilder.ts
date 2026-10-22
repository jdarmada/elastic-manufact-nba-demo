/**
 * Mount a curated set of Elastic Agent Builder tools (ES|QL tools defined in Kibana) on this
 * MCP server by proxying Agent Builder's built-in MCP endpoint.
 *
 * Agent Builder's endpoint also lists built-in platform tools (connectors, workflows, ...).
 * Those must never reach a public endpoint, so the upstream connection is wrapped and only
 * allow-listed tools are listed or callable. Resources and prompts are not forwarded.
 */
import { MCPClient } from "@mcp-use/client";
import type { MCPServer, ProxyConnection } from "mcp-use";

// Agent Builder tools that complement (rather than duplicate) the native tools.
const DEFAULT_TOOLS = [
  "nba_team_defense_rankings",
  "nba_big_scoring_games",
  "nba_team_injury_report",
  "nba_team_upcoming_games",
];

export async function mountAgentBuilderTools(server: MCPServer): Promise<void> {
  const url = process.env.AGENT_BUILDER_MCP_URL;
  const apiKey = process.env.AGENT_BUILDER_API_KEY;
  if (!url || !apiKey) {
    console.log("[agent-builder] AGENT_BUILDER_MCP_URL / AGENT_BUILDER_API_KEY not set; skipping proxy");
    return;
  }
  const allowed = new Set(
    (process.env.AGENT_BUILDER_TOOLS ?? DEFAULT_TOOLS.join(",")).split(",").map((t) => t.trim()).filter(Boolean),
  );

  try {
    const client = new MCPClient({
      mcpServers: { elastic: { url, headers: { Authorization: `ApiKey ${apiKey}` } } },
    });
    const upstream = await withTimeout(client.connect("elastic"), 15_000);

    const curated: ProxyConnection = {
      // Mounted tools are namespaced by this name, e.g. elastic_nba_team_defense_rankings.
      info: { server: { name: "elastic" } },
      supports: (capability) => capability === "tools",
      listTools: async () => (await upstream.listTools()).filter((t) => allowed.has(t.name)),
      callTool: async (name, args, options) => {
        if (!allowed.has(name)) throw new Error(`Tool ${name} is not exposed`);
        return upstream.callTool(name, args, options);
      },
      listResources: async () => ({ resources: [] }),
      readResource: async () => {
        throw new Error("Resources are not exposed");
      },
      listPrompts: async () => ({ prompts: [] }),
      getPrompt: async () => {
        throw new Error("Prompts are not exposed");
      },
    };

    await server.proxy(curated);
    console.log(`[agent-builder] mounted ${[...allowed].join(", ")}`);
  } catch (err) {
    // The native tools keep working if Kibana is unreachable at startup.
    console.error(`[agent-builder] proxy disabled: ${err instanceof Error ? err.message : err}`);
  }
}

function withTimeout<T>(p: Promise<T>, ms: number): Promise<T> {
  return Promise.race([p, new Promise<T>((_, reject) => setTimeout(() => reject(new Error(`timed out after ${ms}ms`)), ms))]);
}
