/**
 * The Kanna management tools as an in-process MCP server for Claude.
 *
 * The Agent SDK can host a server that lives in this process
 * (`createSdkMcpServer`), so Claude's calls land straight on control.ts — no
 * HTTP hop, no child process, no key on disk, and nothing on a socket. Codex
 * has no equivalent hook and goes the long way round (kanna-mcp-stdio.ts).
 *
 * The server is built per turn because the tools need to know *which* chat is
 * calling: that is what bounds agent fan-out (see `assertMaySpawn`).
 *
 * MCP tools are not subject to the SDK's `tools` allowlist — that option only
 * selects built-ins — so nothing in agent.ts's toolset needs to change for
 * these to be callable.
 */

import { createSdkMcpServer, tool } from "@anthropic-ai/claude-agent-sdk"
import {
  KANNA_TOOLS,
  KANNA_TOOLS_INSTRUCTIONS,
  type KannaToolContext,
} from "./kanna-tools"
import { createLocalKannaControl } from "./kanna-control-local"
import { KANNA_MCP_SERVER_NAME } from "./kanna-mcp-bridge"
import type { ControlDeps } from "./api/control"

/** Tools reach the model as `mcp__kanna__<tool>`, matching the codex bridge. */
export function createClaudeKannaMcpServer(deps: ControlDeps, callerChatId: string) {
  const ctx: KannaToolContext = createLocalKannaControl(deps, { chatId: callerChatId })

  return createSdkMcpServer({
    name: KANNA_MCP_SERVER_NAME,
    version: "1",
    instructions: KANNA_TOOLS_INSTRUCTIONS,
    tools: KANNA_TOOLS.map((definition) =>
      tool(
        definition.name,
        definition.description,
        definition.inputShape,
        async (input: Record<string, unknown>) => {
          try {
            const result = await ctx.call(definition.name, input ?? {})
            return { content: [{ type: "text" as const, text: JSON.stringify(result, null, 2) }] }
          } catch (error) {
            // Reported as a tool error rather than thrown: a refused spawn or
            // a missing chat is something the model should read and adjust to,
            // not something that should fail the turn.
            return {
              content: [{ type: "text" as const, text: error instanceof Error ? error.message : String(error) }],
              isError: true,
            }
          }
        }
      )
    ),
  })
}
