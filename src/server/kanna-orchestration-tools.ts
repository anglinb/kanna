import { Effect, Schema } from "effect"
import { z } from "zod"
import type { AgentProvider } from "../shared/types"
import { runKanna } from "./effect/bridge"
import { attachmentItemSchema, resolveAttachments } from "./kanna-display-tools"
import type { KannaToolDefinition, KannaToolResult } from "./kanna-tools"
import {
  READ_CHAT_KINDS,
  type ChatOrchestrator,
  type ChatWriteError,
  type Orchestrator,
  type ScheduleNotFoundError,
  type TicketActionError,
} from "./orchestrator"

/**
 * The chat tools: what a user can do to chats in Kanna, for an agent to do.
 * The rules live in `orchestrator.ts`; these are the schemas and the words
 * the model reads. `harness-instructions.ts` says when to reach for which.
 *
 * The schemas avoid unions on purpose. Each harness converts them its own
 * way (see `kanna-tool-adapters.ts`), and flat optional fields survive all of
 * them.
 */

const runOptions = {
  provider: z.string().optional().describe("claude, codex, cursor, grok or pi. Defaults to the chat's own. get_context lists them."),
  model: z.string().optional().describe("A model id from get_context. Defaults to the chat's own when the provider is unchanged."),
  effort: z.string().optional().describe("Reasoning effort, where the provider has one."),
  planMode: z.boolean().optional().describe("Run read-only, to plan without editing. Always on when this chat is in plan mode."),
}

/**
 * The result goes to the provider as JSON text only, so a large read is not
 * sent twice. The transcript keeps the value itself, which is what a chat
 * card reads the chat's id from.
 */
function reply(value: unknown): KannaToolResult & { transcriptContent: unknown } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], transcriptContent: value }
}

function orchestration(context: { orchestration?: ChatOrchestrator }) {
  if (!context.orchestration) throw new Error("The chat tools are not available in this session.")
  return context.orchestration
}

type Run = { provider?: AgentProvider; model?: string; effort?: string; planMode?: boolean }

/** What a tool's handler is handed, as `kanna-tools.ts` passes it. */
export type OrchestrationToolContext = Parameters<KannaToolDefinition["execute"]>[1]

/**
 * A tool's input did not match its schema, or the files a ticket reply names
 * could not be read. The message is the cause's, as the agent read it before.
 */
export class OrchestrationToolError extends Schema.TaggedError<OrchestrationToolError>()(
  "@kanna/server/kanna-orchestration-tools/OrchestrationToolError",
  {
    tool: Schema.String,
    chatId: Schema.String,
    stage: Schema.Literals(["input", "attachments"]),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

export type OrchestrationToolFailure = ChatWriteError | TicketActionError | ScheduleNotFoundError | OrchestrationToolError

/**
 * One chat tool. `run` is its work as an Effect over the orchestrator
 * service, given the raw input (it parses with `schema` itself). `execute` is
 * the Promise contract `kanna-tools.ts` calls today: it takes the
 * orchestrator from the context and runs `run` with `runKanna`. A tool
 * runtime that runs Effects calls `run` directly and turns its value into a
 * result with `orchestrationToolResult`.
 */
export interface OrchestrationTool extends KannaToolDefinition {
  readonly run: (
    input: unknown,
    orchestrator: Orchestrator["Service"],
    context: OrchestrationToolContext,
  ) => Effect.Effect<unknown, OrchestrationToolFailure>
}

/** A tool's value as the result a harness gets. See `reply`. */
export const orchestrationToolResult = reply

function tool<S extends z.ZodObject<z.ZodRawShape>>(spec: {
  name: string
  description: string
  schema: S
  run: (input: z.infer<S>, orchestrator: Orchestrator["Service"], context: OrchestrationToolContext) => Effect.Effect<unknown, OrchestrationToolFailure>
}): OrchestrationTool {
  const run = (input: unknown, orchestrator: Orchestrator["Service"], context: OrchestrationToolContext) =>
    Effect.try({
      try: () => spec.schema.parse(input),
      catch: (cause) => new OrchestrationToolError({ tool: spec.name, chatId: context.chatId, stage: "input", cause }),
    }).pipe(Effect.flatMap((parsed) => spec.run(parsed, orchestrator, context)))
  return {
    name: spec.name,
    description: spec.description,
    schema: spec.schema,
    run,
    async execute(input, context) {
      return reply(await runKanna(run(input, orchestration(context).service, context)))
    },
  }
}

const getContext = z.strictObject({})

const listChats = z.strictObject({
  projectId: z.string().optional().describe("Only chats in this project."),
  query: z.string().optional().describe("Text to find in titles and each chat's latest messages."),
  status: z.enum(["idle", "running", "needs_input", "waiting_on_subagent", "waiting_on_subchats", "completed", "failed", "cancelled"]).optional()
    .describe("waiting_on_subagent and waiting_on_subchats are a chat whose own turn ended while work it handed off is still going: its provider's own subagents, or chats it started. A shell or a monitor left running in the background is not a wait."),
  parentChatId: z.string().optional().describe("Only sub-chats of this chat."),
  includeArchived: z.boolean().optional(),
  limit: z.number().int().min(1).max(100).optional().describe("Default 30."),
  offset: z.number().int().min(0).optional(),
})

const readChat = z.strictObject({
  chatId: z.string(),
  after: z.number().int().min(-1).optional().describe("Entries after this index, oldest first. -1 reads from the start."),
  before: z.number().int().min(0).optional().describe("The latest entries before this index."),
  textOffset: z.number().int().min(0).optional().describe("With after: start the first entry at this character. next sets it to finish a cut entry."),
  lastTurns: z.number().int().min(1).optional().describe("Only the last N turns. A turn starts at a prompt; 1 is the latest turn."),
  kinds: z.array(z.enum(READ_CHAT_KINDS)).optional().describe("Entry kinds to return. Default: user_prompt, report, assistant_text, result, interrupted. reply is each turn's final assistant_text."),
  limit: z.number().int().min(1).max(200).optional().describe("Most entries per call. Default 40."),
})

/**
 * The ticket a delegator's hand-off is for. Required from a delegator, one
 * or the other, and ignored from any other chat (`chooseTicket`).
 */
const ticketChoice = {
  ticketId: z.string().optional().describe("Delegator chats: the ticket this work is for. Naming a Done ticket reopens it, so do that only for a defect in what it delivered; a new ask takes ticket instead. A delegator must pass this or ticket."),
  ticket: z.strictObject({
    title: z.string().min(1),
    body: z.string().optional().describe("Markdown: what the work is and what done looks like."),
  }).optional().describe("Delegator chats: create the ticket for this work in the same call. One ask per ticket."),
}

const createChat = z.strictObject({
  message: z.string().min(1).describe("The chat's first message. It sees nothing else of this conversation, so say everything it needs."),
  title: z.string().optional(),
  subchat: z.boolean().optional().describe("Default true: its result is sent back to this chat when it finishes, and stopping this chat stops it. false makes an independent chat for the user."),
  projectId: z.string().optional().describe("Defaults to this chat's project."),
  ...ticketChoice,
  ...runOptions,
})

const forkChat = z.strictObject({
  chatId: z.string().optional().describe("The chat to copy. Defaults to this one, copied as of its last finished turn."),
  message: z.string().optional().describe("A first message for the copy. Without one it sits idle."),
  title: z.string().optional(),
  subchat: z.boolean().optional().describe("Whether the copy reports back to this chat. Defaults to true when a message is given."),
  ...ticketChoice,
  ...runOptions,
})

const sendMessage = z.strictObject({
  chatId: z.string(),
  message: z.string().min(1),
  ...ticketChoice,
  delivery: z.enum(["queue", "steer"]).optional().describe("queue (default) starts it now if the chat is idle and after its current turn otherwise. steer interrupts the current turn to deliver it now."),
  adopt: z.boolean().optional().describe("true adopts the chat: this chat becomes its parent, as if it had started it. Use it when you hand work to an existing chat and need the result. From this message on, its reply arrives here as a message when its turn ends, it is listed as this chat's sub-chat, and this chat is not finished while that reply is owed. It stays adopted: later messages need no flag, and there is no undo. It is still the user's chat: it stays in their sidebar, and stopping this chat does not stop it, only drops the reply it owes. A chat that had another parent is taken from it, and that parent is told no more results are coming. A chat above this one, in the chain of chats that started it, cannot be adopted. Leave it unset for a message that needs no answer."),
  ...runOptions,
})

const cancelChat = z.strictObject({
  chatId: z.string(),
})

const updateChat = z.strictObject({
  chatId: z.string().optional().describe("Defaults to this chat."),
  title: z.string().optional(),
  pinned: z.boolean().optional(),
  done: z.boolean().optional().describe("Mark the chat done, or not done."),
  archived: z.boolean().optional().describe("true puts the chat away; it does not stop a running turn. false brings it back."),
})

const updateQueuedMessage = z.strictObject({
  chatId: z.string(),
  queuedMessageId: z.string().describe("From read_chat's queue."),
  action: z.enum(["remove", "send_now"]).describe("send_now interrupts the chat's current turn to deliver it."),
})

const setSchedule = z.strictObject({
  scheduleId: z.string().optional().describe("Change this schedule. Omit to create one."),
  name: z.string().optional(),
  message: z.string().optional().describe("What to send. Required for a new schedule."),
  chatId: z.string().optional().describe("The chat to send it to. Defaults to this chat."),
  newChat: z.boolean().optional().describe("Send it to a new chat on each run, instead of to an existing one."),
  projectId: z.string().optional().describe("With newChat: the project for the new chats. Defaults to this chat's."),
  inMinutes: z.number().min(0).optional().describe("Once, this many minutes from now."),
  runAt: z.string().optional().describe("Once, at this ISO 8601 time."),
  everyMinutes: z.number().min(1).optional().describe("Repeatedly, this often."),
  dailyAt: z.string().optional().describe("Every day at this 24-hour HH:MM, in the server's time zone (see get_context)."),
  weekdays: z.array(z.number().int().min(0).max(6)).optional().describe("With dailyAt: only these days, 0 for Sunday."),
  enabled: z.boolean().optional().describe("false pauses it."),
  maxRuns: z.number().int().min(1).optional().describe("Stop after this many runs."),
  ...runOptions,
})

const listSchedules = z.strictObject({
  chatId: z.string().optional().describe("Only schedules that send to this chat."),
  includeDisabled: z.boolean().optional(),
})

const deleteSchedule = z.strictObject({
  scheduleId: z.string(),
})

const createTicket = z.strictObject({
  title: z.string().min(1),
  body: z.string().optional().describe("Markdown: what the work is and what done looks like. Not progress."),
})

const updateTicket = z.strictObject({
  ticketId: z.string(),
  title: z.string().optional(),
  body: z.string().optional().describe("Replaces the body. Only when the ask or the plan changes."),
  status: z.enum(["done", "open"]).optional().describe("done closes it; open reopens it."),
})

const replyToTicket = z.strictObject({
  ticketId: z.string(),
  text: z.string().describe("Markdown."),
  asksUser: z.boolean().optional().describe("true only for a question that blocks the work or its Done; the ticket waits on the user until they reply. false withdraws an open question."),
  attachments: z.array(attachmentItemSchema).max(24).optional().describe("Files to show with the reply: local paths or HTTP/HTTPS URLs, as send_attachments takes them."),
})

const readTicket = z.strictObject({
  ticketId: z.string(),
})

const listTickets = z.strictObject({
  status: z.enum(["waiting_on_you", "in_progress", "done", "open"]).optional().describe("open is anything not done."),
  limit: z.number().int().min(1).max(200).optional().describe("Default 50."),
})

export const ORCHESTRATION_TOOLS: readonly OrchestrationTool[] = [
  tool({
    name: "get_context",
    description: "Where you are in Kanna: this chat's id, project, provider and model; the other projects; the providers and models a chat can run on; the current time.",
    schema: getContext,
    run: (_input, orchestrator, context) => orchestrator.getContext(context.chatId),
  }),
  tool({
    name: "list_chats",
    description: "List Kanna chats, newest first, with each one's status. Covers every project unless projectId is given.",
    schema: listChats,
    run: (input, orchestrator) => orchestrator.listChats(input),
  }),
  tool({
    name: "read_chat",
    description: "Read a chat: its status, sub-chats, queue and transcript. Entries come whole, up to 50,000 characters a call. One longer than what is left is cut, marked truncated, and finished by passing next back. Each entry has an index. With no position given, returns the latest entries. after reads forward from an index, before reads back from one, and lastTurns keeps to the latest turns (1 is the last turn). kinds filters entries: the default is what was said (prompts, reports, the agent's text, failures and stops); [\"reply\"] is just the agent's final reply in each turn; add tool_call and tool_result for tool inputs and outputs. next and earlier, when present, are the arguments for the page after and the page before.",
    schema: readChat,
    run: (input, orchestrator) => orchestrator.readChat(input),
  }),
  tool({
    name: "create_chat",
    description: "Start a new chat with a first message, on any provider and model. Returns at once. By default it is a sub-chat of this one: its reply arrives here as a message when its turn ends. If it is still waiting on work it handed off, the message says so and another follows when that work comes back.",
    schema: createChat,
    run: ({ message, title, subchat, projectId, ticketId, ticket, ...run }, orchestrator, context) =>
      orchestrator.createChat(context.chatId, { message, title, subchat, projectId, ticketId, ticket, ...(run as Run) }),
  }),
  tool({
    name: "fork_chat",
    description: "Copy a chat, conversation included, into a new chat that continues separately. The original is untouched.",
    schema: forkChat,
    run: ({ chatId, message, title, subchat, ticketId, ticket, ...run }, orchestrator, context) =>
      orchestrator.forkChat(context.chatId, { chatId, message, title, subchat, ticketId, ticket, ...(run as Run) }),
  }),
  tool({
    name: "send_message",
    description: "Send a message to another chat, as the user would. It starts a turn if the chat is idle and queues behind the current turn otherwise. A chat this one did not start sends nothing back when it finishes, unless this chat adopts it (adopt).",
    schema: sendMessage,
    run: ({ chatId, message, delivery, adopt, ticketId, ticket, ...run }, orchestrator, context) =>
      orchestrator.sendMessage(context.chatId, { chatId, message, delivery, adopt, ticketId, ticket, ...(run as Run) }),
  }),
  tool({
    name: "cancel_chat",
    description: "Stop a chat's current turn, and every sub-chat running under it.",
    schema: cancelChat,
    run: (input, orchestrator, context) => orchestrator.cancelChat(context.chatId, input.chatId),
  }),
  tool({
    name: "update_chat",
    description: "Rename a chat, pin it, mark it done, or archive it.",
    schema: updateChat,
    run: (input, orchestrator, context) => orchestrator.updateChat(context.chatId, input),
  }),
  tool({
    name: "update_queued_message",
    description: "Remove a message waiting in a chat's queue, or deliver it now.",
    schema: updateQueuedMessage,
    run: (input, orchestrator) => orchestrator.updateQueuedMessage(input),
  }),
  tool({
    name: "set_schedule",
    description: "Send a message later, once or on a repeat, to this chat, another chat, or a new chat each time. Give exactly one of inMinutes, runAt, everyMinutes or dailyAt. Pass scheduleId to change or pause one.",
    schema: setSchedule,
    run: (input, orchestrator, context) =>
      orchestrator.setSchedule(context.chatId, { ...input, provider: input.provider as AgentProvider | undefined }),
  }),
  tool({
    name: "list_schedules",
    description: "List schedules and when each runs next.",
    schema: listSchedules,
    run: (input, orchestrator) => orchestrator.listSchedules(input),
  }),
  tool({
    name: "delete_schedule",
    description: "Delete a schedule.",
    schema: deleteSchedule,
    run: (input, orchestrator) => orchestrator.deleteSchedule(input.scheduleId),
  }),
  tool({
    name: "create_ticket",
    description: "Delegator chats only. Add a ticket to this chat's board: one piece of work the user follows there. The body says what the work is and what done looks like, never progress. Returns ticketId and number. create_chat, send_message and fork_chat can also create one in the same call (ticket).",
    schema: createTicket,
    run: (input, orchestrator, context) => orchestrator.createTicket(context.chatId, input),
  }),
  tool({
    name: "update_ticket",
    description: "Delegator chats only. Rename a ticket or replace its body when its ask changes, so both match the work. A ticket is Done by itself once its chats have reported and nothing is asked. status done closes one whose work ends without a report (answered here, dropped, superseded) and clears its question. status open reopens one only for a defect in what it delivered; a new ask is a new ticket. A chat on it that is still working or waiting on the user keeps it out of Done until it finishes.",
    schema: updateTicket,
    run: (input, orchestrator, context) => orchestrator.updateTicket(context.chatId, input),
  }),
  tool({
    name: "reply_to_ticket",
    description: "Delegator chats only. Post on a ticket. The user reads the ticket, not this chat, and this is the only way to write on one. Post when its work comes back: start with whether the body's done-when is met, then what the user should know or try. Or post when you decide something for the user. Do not post a plan, a hand-off (the ticket records it) or \"nothing new\". asksUser: true puts the ticket in Waiting on you until the user replies there. Use it only when the work cannot go on, or be called done, without the answer, and lead with the question. A choice with a sensible default is not a block: name the default in the text and go on. asksUser: false withdraws a question settled elsewhere. For a mockup or a chart, call show_visualization with ticketId. Returns replyId.",
    schema: replyToTicket,
    run: ({ ticketId, text, asksUser, attachments }, orchestrator, context) => Effect.gen(function* () {
      // Checked before any file is copied, so a wrong ticket leaves nothing behind.
      yield* orchestrator.checkTicket(context.chatId, ticketId)
      if (!attachments?.length) return yield* orchestrator.replyToTicket(context.chatId, { ticketId, text, asksUser })
      const files = yield* Effect.tryPromise({
        try: () => resolveAttachments(attachments, context),
        catch: (cause) => new OrchestrationToolError({ tool: "reply_to_ticket", chatId: context.chatId, stage: "attachments", cause }),
      })
      return yield* orchestrator.replyToTicket(context.chatId, { ticketId, text, asksUser, artifacts: files.attachments }).pipe(
        // The reply did not land, so the copies it would have shown go.
        Effect.tapError(() => Effect.promise(() => files.cleanup())),
      )
    }),
  }),
  tool({
    name: "read_ticket",
    description: "Delegator chats only. Read a ticket whole: its body, replies and history, and its chats with how each stands now.",
    schema: readTicket,
    run: (input, orchestrator, context) => orchestrator.readTicket(context.chatId, input.ticketId),
  }),
  tool({
    name: "list_tickets",
    description: "Delegator chats only. This chat's tickets, latest activity first, each with its state (waiting_on_you, in_progress or done), a line of status, and its chats.",
    schema: listTickets,
    run: (input, orchestrator, context) => orchestrator.listTickets(context.chatId, input),
  }),
]
