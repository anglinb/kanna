import { Cause, Effect, Exit, Schema } from "effect"
import type { AgentProvider } from "../shared/types"
import { AttachmentItem, resolveDisplayAttachments } from "./kanna-display-tools"
import { KannaToolArgumentsError } from "./kanna-tool-arguments"
import { defineKannaTool, KannaToolRefusal, type KannaTool, type KannaToolContext, type KannaToolOutput } from "./kanna-tool-definition"
import {
  READ_CHAT_KINDS,
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

const optional = <S extends Schema.Top>(schema: S, description?: string) =>
  Schema.optionalKey(description ? schema.annotate({ description }) : schema)
const integer = (minimum: number, maximum?: number) => Schema.Finite.check(
  Schema.isInt(), Schema.isGreaterThanOrEqualTo(minimum),
  ...(maximum === undefined ? [] : [Schema.isLessThanOrEqualTo(maximum)]),
)
const number = (minimum: number) => Schema.Finite.check(Schema.isGreaterThanOrEqualTo(minimum))
const nonEmpty = Schema.String.check(Schema.isMinLength(1))

const runOptions = {
  provider: optional(Schema.String, "claude, codex, cursor, grok or pi. Defaults to the chat's own. get_context lists them."),
  model: optional(Schema.String, "A model id from get_context. Defaults to the chat's own when the provider is unchanged."),
  effort: optional(Schema.String, "Reasoning effort, where the provider has one."),
  planMode: optional(Schema.Boolean, "Run read-only, to plan without editing. Always on when this chat is in plan mode."),
}

/**
 * The result goes to the provider as JSON text only, so a large read is not
 * sent twice. The transcript keeps the value itself, which is what a chat
 * card reads the chat's id from.
 */
function reply(value: unknown): KannaToolOutput & { transcriptContent: unknown } {
  return { content: [{ type: "text", text: JSON.stringify(value) }], transcriptContent: value }
}

type Run = { provider?: AgentProvider; model?: string; effort?: string; planMode?: boolean }

/**
 * A tool's input did not match its schema, or the files a ticket reply names
 * could not be read. The message is the cause's, as the agent read it before.
 */
export class OrchestrationToolError extends Schema.TaggedError<OrchestrationToolError>()(
  "@kanna/server/kanna-orchestration-tools/OrchestrationToolError",
  {
    tool: Schema.String,
    chatId: Schema.String,
    stage: Schema.Literal("attachments"),
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

export type OrchestrationToolFailure = ChatWriteError | TicketActionError | ScheduleNotFoundError | OrchestrationToolError | KannaToolRefusal

/**
 * One chat tool, decoded by the native Kanna tool runtime.
 */
export type OrchestrationTool = KannaTool

/** A tool's value as the result a harness gets. See `reply`. */
export const orchestrationToolResult = reply

function tool<S extends Schema.Decoder<unknown>>(spec: {
  name: string
  description: string
  parameters: S
  run: (input: S["Type"], orchestrator: Orchestrator["Service"], context: KannaToolContext) => Effect.Effect<unknown, OrchestrationToolFailure, import("effect").FileSystem.FileSystem>
  /**
   * Reads, and tools that protect their own writes, can stop when the call is
   * cancelled. Every other tool's orchestrator call runs to the end: it makes
   * several changes in turn (create, rename, send) and an interrupt between
   * them would leave a half-made chat or a report owed for a turn that never
   * started. Before Effect these calls ran detached from the call's signal.
   */
  interruptible?: true
}): OrchestrationTool {
  const native = defineKannaTool({
    name: spec.name,
    description: spec.description,
    parameters: spec.parameters,
    execute: Effect.fn(`KannaOrchestrationTools.${spec.name}`)(function* (input, context) {
      yield* Effect.annotateCurrentSpan("chatId", context.chatId)
      const orchestrator = context.orchestration
      if (!orchestrator) return yield* new KannaToolRefusal({ tool: spec.name, message: "The chat tools are not available in this session." })
      const run = spec.run(input, orchestrator, context)
      return reply(yield* (spec.interruptible ? run : Effect.uninterruptible(run)))
    }),
  })
  // Effect emits a different JSON Schema and one issue per extra key for an
  // empty record; zod gave providers a strict empty object and grouped keys.
  return spec.name === "get_context"
    ? {
      ...native,
      inputSchema: { $schema: "https://json-schema.org/draft/2020-12/schema", type: "object", properties: {}, additionalProperties: false },
      decode: (input: unknown) => native.decode(input).pipe(Effect.catchTag("@kanna/server/kanna-tool-arguments/KannaToolArgumentsError", (error) => {
        if (input === null || typeof input !== "object" || Array.isArray(input)) return Effect.fail(error)
        const keys = Object.keys(input)
        const message = JSON.stringify([{
          code: "unrecognized_keys", keys, path: [],
          message: `Unrecognized key${keys.length === 1 ? "" : "s"}: ${keys.map((key) => JSON.stringify(key)).join(", ")}`,
        }], null, 2)
        return Effect.fail(new KannaToolArgumentsError({ tool: spec.name, message, cause: error }))
      })),
    }
    : native
}

const getContext = Schema.Record(Schema.String, Schema.Never)

const listChats = Schema.Struct({
  projectId: optional(Schema.String, "Only chats in this project."),
  query: optional(Schema.String, "Text to find in titles and each chat's latest messages."),
  status: optional(Schema.Literals(["idle", "running", "needs_input", "waiting_on_subagent", "waiting_on_subchats", "completed", "failed", "cancelled"]), "waiting_on_subagent and waiting_on_subchats are a chat whose own turn ended while work it handed off is still going: its provider's own subagents, or chats it started. A shell or a monitor left running in the background is not a wait."),
  parentChatId: optional(Schema.String, "Only sub-chats of this chat."),
  includeArchived: optional(Schema.Boolean),
  limit: optional(integer(1, 100), "Default 30."),
  offset: optional(integer(0)),
})

const readChat = Schema.Struct({
  chatId: Schema.String,
  after: optional(integer(-1), "Entries after this index, oldest first. -1 reads from the start."),
  before: optional(integer(0), "The latest entries before this index."),
  textOffset: optional(integer(0), "With after: start the first entry at this character. next sets it to finish a cut entry."),
  lastTurns: optional(integer(1), "Only the last N turns. A turn starts at a prompt; 1 is the latest turn."),
  kinds: optional(Schema.Array(Schema.Literals(READ_CHAT_KINDS)), "Entry kinds to return. Default: user_prompt, report, assistant_text, result, interrupted. reply is each turn's final assistant_text."),
  limit: optional(integer(1, 200), "Most entries per call. Default 40."),
})

/**
 * The ticket a delegator's hand-off is for. Required from a delegator, one
 * or the other, and ignored from any other chat (`chooseTicket`).
 */
const ticketChoice = {
  ticketId: optional(Schema.String, "Delegator chats: the ticket this work is for. Naming a Done ticket reopens it, so do that only for a defect in what it delivered; a new ask takes ticket instead. A delegator must pass this or ticket."),
  ticket: optional(Schema.Struct({
    title: nonEmpty,
    body: optional(Schema.String, "Markdown: what the work is and what done looks like."),
  }), "Delegator chats: create the ticket for this work in the same call. One ask per ticket."),
}

const createChat = Schema.Struct({
  message: nonEmpty.annotate({ description: "The chat's first message. It sees nothing else of this conversation, so say everything it needs." }),
  title: optional(Schema.String),
  subchat: optional(Schema.Boolean, "Default true: its result is sent back to this chat when it finishes, and stopping this chat stops it. false makes an independent chat for the user."),
  projectId: optional(Schema.String, "Defaults to this chat's project."),
  ...ticketChoice,
  ...runOptions,
})

const forkChat = Schema.Struct({
  chatId: optional(Schema.String, "The chat to copy. Defaults to this one, copied as of its last finished turn."),
  message: optional(Schema.String, "A first message for the copy. Without one it sits idle."),
  title: optional(Schema.String),
  subchat: optional(Schema.Boolean, "Whether the copy reports back to this chat. Defaults to true when a message is given."),
  ...ticketChoice,
  ...runOptions,
})

const sendMessage = Schema.Struct({
  chatId: Schema.String,
  message: nonEmpty,
  ...ticketChoice,
  delivery: optional(Schema.Literals(["queue", "steer"]), "queue (default) starts it now if the chat is idle and after its current turn otherwise. steer interrupts the current turn to deliver it now."),
  adopt: optional(Schema.Boolean, "true adopts the chat: this chat becomes its parent, as if it had started it. Use it when you hand work to an existing chat and need the result. From this message on, its reply arrives here as a message when its turn ends, it is listed as this chat's sub-chat, and this chat is not finished while that reply is owed. It stays adopted: later messages need no flag, and there is no undo. It is still the user's chat: it stays in their sidebar, and stopping this chat does not stop it, only drops the reply it owes. A chat that had another parent is taken from it, and that parent is told no more results are coming. A chat above this one, in the chain of chats that started it, cannot be adopted. Leave it unset for a message that needs no answer."),
  ...runOptions,
})

const cancelChat = Schema.Struct({
  chatId: Schema.String,
})

const updateChat = Schema.Struct({
  chatId: optional(Schema.String, "Defaults to this chat."),
  title: optional(Schema.String),
  pinned: optional(Schema.Boolean),
  done: optional(Schema.Boolean, "Mark the chat done, or not done."),
  archived: optional(Schema.Boolean, "true puts the chat away; it does not stop a running turn. false brings it back."),
})

const updateQueuedMessage = Schema.Struct({
  chatId: Schema.String,
  queuedMessageId: Schema.String.annotate({ description: "From read_chat's queue." }),
  action: Schema.Literals(["remove", "send_now"]).annotate({ description: "send_now interrupts the chat's current turn to deliver it." }),
})

const setSchedule = Schema.Struct({
  scheduleId: optional(Schema.String, "Change this schedule. Omit to create one."),
  name: optional(Schema.String),
  message: optional(Schema.String, "What to send. Required for a new schedule."),
  chatId: optional(Schema.String, "The chat to send it to. Defaults to this chat."),
  newChat: optional(Schema.Boolean, "Send it to a new chat on each run, instead of to an existing one."),
  projectId: optional(Schema.String, "With newChat: the project for the new chats. Defaults to this chat's."),
  inMinutes: optional(number(0), "Once, this many minutes from now."),
  runAt: optional(Schema.String, "Once, at this ISO 8601 time."),
  everyMinutes: optional(number(1), "Repeatedly, this often."),
  dailyAt: optional(Schema.String, "Every day at this 24-hour HH:MM, in the server's time zone (see get_context)."),
  weekdays: optional(Schema.Array(integer(0, 6)), "With dailyAt: only these days, 0 for Sunday."),
  enabled: optional(Schema.Boolean, "false pauses it."),
  maxRuns: optional(integer(1), "Stop after this many runs."),
  ...runOptions,
})

const listSchedules = Schema.Struct({
  chatId: optional(Schema.String, "Only schedules that send to this chat."),
  includeDisabled: optional(Schema.Boolean),
})

const deleteSchedule = Schema.Struct({
  scheduleId: Schema.String,
})

const createTicket = Schema.Struct({
  title: nonEmpty,
  body: optional(Schema.String, "Markdown: what the work is and what done looks like. Not progress."),
})

const updateTicket = Schema.Struct({
  ticketId: Schema.String,
  title: optional(Schema.String),
  body: optional(Schema.String, "Replaces the body. Only when the ask or the plan changes."),
  status: optional(Schema.Literals(["done", "open"]), "done closes it; open reopens it."),
})

const replyToTicket = Schema.Struct({
  ticketId: Schema.String,
  text: Schema.String.annotate({ description: "Markdown." }),
  asksUser: optional(Schema.Boolean, "true only for a question that blocks the work or its Done; the ticket waits on the user until they reply. false withdraws an open question."),
  attachments: optional(Schema.Array(AttachmentItem).check(Schema.isMaxLength(24)), "Files to show with the reply: local paths or HTTP/HTTPS URLs, as send_attachments takes them."),
})

const readTicket = Schema.Struct({
  ticketId: Schema.String,
})

const listTickets = Schema.Struct({
  status: optional(Schema.Literals(["waiting_on_you", "in_progress", "done", "open"]), "open is anything not done."),
  limit: optional(integer(1, 200), "Default 50."),
})

export const ORCHESTRATION_TOOLS: readonly OrchestrationTool[] = [
  tool({
    name: "get_context",
    description: "Where you are in Kanna: this chat's id, project, provider and model; the other projects; the providers and models a chat can run on; the current time.",
    parameters: getContext,
    interruptible: true,
    run: (_input, orchestrator, context) => orchestrator.getContext(context.chatId),
  }),
  tool({
    name: "list_chats",
    description: "List Kanna chats, newest first, with each one's status. Covers every project unless projectId is given.",
    parameters: listChats,
    interruptible: true,
    run: (input, orchestrator) => orchestrator.listChats(input),
  }),
  tool({
    name: "read_chat",
    description: "Read a chat: its status, sub-chats, queue and transcript. Entries come whole, up to 50,000 characters a call. One longer than what is left is cut, marked truncated, and finished by passing next back. Each entry has an index. With no position given, returns the latest entries. after reads forward from an index, before reads back from one, and lastTurns keeps to the latest turns (1 is the last turn). kinds filters entries: the default is what was said (prompts, reports, the agent's text, failures and stops); [\"reply\"] is just the agent's final reply in each turn; add tool_call and tool_result for tool inputs and outputs. next and earlier, when present, are the arguments for the page after and the page before.",
    parameters: readChat,
    interruptible: true,
    run: (input, orchestrator) => orchestrator.readChat({ ...input, kinds: input.kinds ? [...input.kinds] : undefined }),
  }),
  tool({
    name: "create_chat",
    description: "Start a new chat with a first message, on any provider and model. Returns at once. By default it is a sub-chat of this one: its reply arrives here as a message when its turn ends. If it is still waiting on work it handed off, the message says so and another follows when that work comes back.",
    parameters: createChat,
    run: ({ message, title, subchat, projectId, ticketId, ticket, ...run }, orchestrator, context) =>
      orchestrator.createChat(context.chatId, { message, title, subchat, projectId, ticketId, ticket, ...(run as Run) }),
  }),
  tool({
    name: "fork_chat",
    description: "Copy a chat, conversation included, into a new chat that continues separately. The original is untouched.",
    parameters: forkChat,
    run: ({ chatId, message, title, subchat, ticketId, ticket, ...run }, orchestrator, context) =>
      orchestrator.forkChat(context.chatId, { chatId, message, title, subchat, ticketId, ticket, ...(run as Run) }),
  }),
  tool({
    name: "send_message",
    description: "Send a message to another chat, as the user would. It starts a turn if the chat is idle and queues behind the current turn otherwise. A chat this one did not start sends nothing back when it finishes, unless this chat adopts it (adopt).",
    parameters: sendMessage,
    run: ({ chatId, message, delivery, adopt, ticketId, ticket, ...run }, orchestrator, context) =>
      orchestrator.sendMessage(context.chatId, { chatId, message, delivery, adopt, ticketId, ticket, ...(run as Run) }),
  }),
  tool({
    name: "cancel_chat",
    description: "Stop a chat's current turn, and every sub-chat running under it.",
    parameters: cancelChat,
    run: (input, orchestrator, context) => orchestrator.cancelChat(context.chatId, input.chatId),
  }),
  tool({
    name: "update_chat",
    description: "Rename a chat, pin it, mark it done, or archive it.",
    parameters: updateChat,
    run: (input, orchestrator, context) => orchestrator.updateChat(context.chatId, input),
  }),
  tool({
    name: "update_queued_message",
    description: "Remove a message waiting in a chat's queue, or deliver it now.",
    parameters: updateQueuedMessage,
    run: (input, orchestrator) => orchestrator.updateQueuedMessage(input),
  }),
  tool({
    name: "set_schedule",
    description: "Send a message later, once or on a repeat, to this chat, another chat, or a new chat each time. Give exactly one of inMinutes, runAt, everyMinutes or dailyAt. Pass scheduleId to change or pause one.",
    parameters: setSchedule,
    run: (input, orchestrator, context) =>
      orchestrator.setSchedule(context.chatId, { ...input, weekdays: input.weekdays ? [...input.weekdays] : undefined, provider: input.provider as AgentProvider | undefined }),
  }),
  tool({
    name: "list_schedules",
    description: "List schedules and when each runs next.",
    parameters: listSchedules,
    interruptible: true,
    run: (input, orchestrator) => orchestrator.listSchedules(input),
  }),
  tool({
    name: "delete_schedule",
    description: "Delete a schedule.",
    parameters: deleteSchedule,
    run: (input, orchestrator) => orchestrator.deleteSchedule(input.scheduleId),
  }),
  tool({
    name: "create_ticket",
    description: "Delegator chats only. Add a ticket to this chat's board: one piece of work the user follows there. The body says what the work is and what done looks like, never progress. Returns ticketId and number. create_chat, send_message and fork_chat can also create one in the same call (ticket).",
    parameters: createTicket,
    run: (input, orchestrator, context) => orchestrator.createTicket(context.chatId, input),
  }),
  tool({
    name: "update_ticket",
    description: "Delegator chats only. Rename a ticket or replace its body when its ask changes, so both match the work. A ticket is Done by itself once its chats have reported and nothing is asked. status done closes one whose work ends without a report (answered here, dropped, superseded) and clears its question. status open reopens one only for a defect in what it delivered; a new ask is a new ticket. A chat on it that is still working or waiting on the user keeps it out of Done until it finishes.",
    parameters: updateTicket,
    run: (input, orchestrator, context) => orchestrator.updateTicket(context.chatId, input),
  }),
  tool({
    name: "reply_to_ticket",
    description: "Delegator chats only. Post on a ticket. The user reads the ticket, not this chat, and this is the only way to write on one. Post when its work comes back: start with whether the body's done-when is met, then what the user should know or try. Or post when you decide something for the user. Do not post a plan, a hand-off (the ticket records it) or \"nothing new\". asksUser: true puts the ticket in Waiting on you until the user replies there. Use it only when the work cannot go on, or be called done, without the answer, and lead with the question. A choice with a sensible default is not a block: name the default in the text and go on. asksUser: false withdraws a question settled elsewhere. For a mockup or a chart, call show_visualization with ticketId. Returns replyId.",
    parameters: replyToTicket,
    interruptible: true,
    run: ({ ticketId, text, asksUser, attachments }, orchestrator, context) => Effect.gen(function* () {
      // Checked before any file is copied, so a wrong ticket leaves nothing behind.
      yield* orchestrator.checkTicket(context.chatId, ticketId)
      if (!attachments?.length) return yield* Effect.uninterruptible(orchestrator.replyToTicket(context.chatId, { ticketId, text, asksUser }))
      const files = yield* resolveDisplayAttachments(attachments, context).pipe(
        Effect.catchCause((cause) => Effect.fail(new OrchestrationToolError({
          tool: "reply_to_ticket", chatId: context.chatId, stage: "attachments", cause: Cause.squash(cause),
        }))),
      )
      // Copying stays cancellable; once the reply starts it lands, and its files with it.
      return yield* orchestrator.replyToTicket(context.chatId, { ticketId, text, asksUser, artifacts: files.attachments }).pipe(
        Effect.onExit((exit) => Exit.isSuccess(exit) ? Effect.void : files.cleanup),
        Effect.uninterruptible,
      )
    }),
  }),
  tool({
    name: "read_ticket",
    description: "Delegator chats only. Read a ticket whole: its body, replies and history, and its chats with how each stands now.",
    parameters: readTicket,
    interruptible: true,
    run: (input, orchestrator, context) => orchestrator.readTicket(context.chatId, input.ticketId),
  }),
  tool({
    name: "list_tickets",
    description: "Delegator chats only. This chat's tickets, latest activity first, each with its state (waiting_on_you, in_progress or done), a line of status, and its chats.",
    parameters: listTickets,
    interruptible: true,
    run: (input, orchestrator, context) => orchestrator.listTickets(context.chatId, input),
  }),
]
