/**
 * The Kanna management tools an agent running inside Kanna gets: list and open
 * projects, list, read and create chats, send prompts, cancel a running turn.
 *
 * One definition, two transports. Claude sees these through an in-process SDK
 * MCP server (`kanna-mcp-claude.ts`) that calls straight into the EventStore
 * and AgentCoordinator. Codex sees them through a stdio MCP child process
 * (`kanna-mcp-stdio.ts`) that reaches the same operations over `/api/v1` on
 * loopback. Names, schemas and descriptions are shared, so the two agents are
 * looking at the same toolbox.
 *
 * Schemas are Zod raw shapes because that is what the Agent SDK's `tool()`
 * takes — it rejects a plain JSON Schema. The stdio bridge, which has to
 * advertise real JSON Schema on the wire, derives it with `z.toJSONSchema`.
 *
 * Deliberately no delete: removing a project or a chat destroys a person's
 * work with no undo in the UI, and nothing an agent does here is worth that.
 * `/api/v1` still has `DELETE /chats/:id` for human clients.
 *
 * Every mutating tool routes through `assertMaySpawn`, so a chat an agent
 * started cannot start more (see api/control.ts).
 */

import { z } from "zod"

export type KannaToolOperation =
  | "list_projects"
  | "add_project"
  | "list_chats"
  | "get_chat"
  | "create_chat"
  | "send_message"
  | "cancel_chat"
  | "reload"

export interface KannaToolContext {
  /**
   * Runs one operation. Backed either by direct control.ts calls or by an
   * HTTP round trip, depending on which transport built this context.
   */
  call: (operation: KannaToolOperation, input: Record<string, unknown>) => Promise<unknown>
}

export interface KannaToolDefinition {
  name: KannaToolOperation
  description: string
  /** Zod raw shape — the form `tool()` wants. */
  inputShape: z.ZodRawShape
}

/**
 * The model-facing knobs on a prompt. All optional: omitting them means
 * "whatever this chat already uses", which is nearly always what an agent
 * wants and what the person watching would expect to see happen.
 */
const PROMPT_SHAPE = {
  provider: z
    .enum(["claude", "codex", "cursor", "pi"])
    .optional()
    .describe("Which coding agent runs the turn. Defaults to the chat's current provider."),
  model: z
    .string()
    .optional()
    .describe('Model id for the turn (e.g. "opus", "gpt-5.3-codex"). Defaults to the chat\'s last model.'),
  effort: z
    .string()
    .optional()
    .describe("Reasoning effort, where the provider supports one: low, medium, high, or max."),
  planMode: z
    .boolean()
    .optional()
    .describe("Start the turn in plan mode, so it proposes a plan instead of editing files."),
} satisfies z.ZodRawShape

export const KANNA_TOOLS: KannaToolDefinition[] = [
  {
    name: "list_projects",
    description:
      "List the projects open in this Kanna instance, most recently active first, with each one's local path and how many unarchived chats it has.",
    inputShape: {},
  },
  {
    name: "add_project",
    description:
      "Open a local directory as a Kanna project. Creates the directory if it does not exist, and runs `git init` when it is empty so chats there produce diffs; an existing non-empty directory is left untouched. Opening a path that is already a project returns the existing project with created:false.",
    inputShape: {
      localPath: z.string().describe("Absolute path to the project directory. `~` is expanded."),
      title: z.string().optional().describe("Display name. Defaults to the directory name."),
    },
  },
  {
    name: "list_chats",
    description:
      "List chats, most recently active first, with their status (running, waiting_for_user, idle…) and provider. Filter to one project with projectId.",
    inputShape: {
      projectId: z.string().optional().describe("Only chats in this project. Omit for every project."),
      includeArchived: z.boolean().optional().describe("Include archived chats. Defaults to false."),
      limit: z.number().optional().describe("Maximum chats to return (default 50, max 200)."),
    },
  },
  {
    name: "get_chat",
    description:
      "Read one chat: its status, its queued messages, and its transcript. Returns the recent window by default; pass full to get the whole conversation, which on a long chat is very large.",
    inputShape: {
      chatId: z.string(),
      full: z.boolean().optional().describe("Return the entire transcript instead of the recent window."),
    },
  },
  {
    name: "create_chat",
    description:
      "Create a chat in a project. With `content`, the chat is created and its first turn starts immediately — that spends model credits and runs a real agent with file access in that project, so only do it when you have been asked to. Without `content`, an empty chat is created for a person to prompt. Returns as soon as the turn starts, not when it finishes; poll get_chat for status and output.",
    inputShape: {
      projectId: z.string(),
      content: z
        .string()
        .optional()
        .describe("Opening prompt. Starts a turn. Omit to create an empty chat instead."),
      ...PROMPT_SHAPE,
    },
  },
  {
    name: "send_message",
    description:
      "Send a prompt to an existing chat, starting a turn. Spends model credits and runs a real agent with file access — only do it when you have been asked to. If a turn is already running the prompt is queued behind it and `queued` comes back true. Returns as soon as the prompt lands, not when the turn finishes; poll get_chat for the result. You cannot send to your own chat.",
    inputShape: {
      chatId: z.string(),
      content: z.string(),
      ...PROMPT_SHAPE,
    },
  },
  {
    name: "cancel_chat",
    description: "Stop the turn running in a chat, the same way the stop button does. Safe on an idle chat.",
    inputShape: { chatId: z.string() },
  },
  {
    name: "reload",
    description:
      "Re-read every project and chat from Kanna's data directory, discarding what is held in memory, and push the result to any open browser. Use this after editing that directory directly — moving a chat between projects, importing one, fixing a record — so the running Kanna picks the change up without a restart. Nothing is written and nothing is deleted: if a file is unreadable or from another store version the reload is refused and the previous state stays loaded. A chat that has disappeared from disk but still had an agent running has that agent stopped, and comes back in droppedChatIds.",
    inputShape: {},
  },
]

/** JSON Schema for one tool, for transports that advertise schema on the wire. */
export function toolInputJsonSchema(definition: KannaToolDefinition) {
  return z.toJSONSchema(z.object(definition.inputShape))
}

/**
 * Instructions surfaced alongside the tools, so the model knows what this
 * server is before it reads any tool name.
 */
export const KANNA_TOOLS_INSTRUCTIONS = [
  "These tools manage the Kanna instance you are running inside: its projects and its chats.",
  "create_chat and send_message start real agent turns that cost money and can edit files — treat them as actions you take on request, not as a way to delegate work you could do yourself.",
  "There is no delete: removing a project or chat is left to the person at the keyboard.",
].join(" ")
