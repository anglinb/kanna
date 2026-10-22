import { Context, Effect, Layer, Option, Schema } from "effect"
import {
  deriveTicketState,
  type TicketHandoff,
  describeTicket,
  summarizeTicket,
  ticketAttentionCount,
  ticketChatLinks,
  type TicketArtifact,
  type TicketAuthor,
  type TicketChatInfo,
  type TicketDetail,
  type TicketHistoryEvent,
  type TicketRecord,
  type TicketReply,
  type TicketState,
  type TicketSummary,
} from "../shared/tickets"
import type { ChatAttachment } from "../shared/types"
import { TicketStore, type TicketStoreError, type TicketStoreEventInput } from "./ticket-store"

/**
 * The rules of a delegator's ticket board, over `TicketStore`. See
 * `shared/tickets.ts` for what a ticket is and how its column is derived.
 *
 * Every write here is one the orchestrator makes for an actor it has already
 * checked: the delegator's agent through its tools, the user through the
 * router, Kanna itself for hand-offs and reports. This file knows nothing of
 * messages; what gets sent to the delegator is the orchestrator's to decide.
 *
 * It also keeps the nudge's ledger: tickets that got news the delegator has
 * to answer (a user reply, a report on their turn), and tickets it then wrote on or
 * handed work from. In memory only. A restart loses at most one nudge.
 */

type HistoryInput = TicketHistoryEvent extends infer E ? E extends TicketHistoryEvent ? Omit<E, "id" | "ticketId" | "createdAt"> : never : never

/** Why a ticket is on the nudge's list. */
export type TicketNewsReason = { kind: "user_reply" } | { kind: "report"; chatId: string }

interface LedgerEntry {
  /** When news last landed. */
  newsAt: number
  reasons: TicketNewsReason[]
  /** When the delegator last wrote on it or handed work from it. */
  addressedAt?: number
}

/** The tickets a report covers, and the hand-offs it settles. */
export interface TicketCoverage {
  handoffs: TicketHandoff[]
  tickets: TicketRecord[]
}

/**
 * No ticket with that id on the delegator's board. The message is what the
 * delegator's agent reads in its tool result, so it says how to find one.
 */
export class TicketNotFoundError extends Schema.TaggedError<TicketNotFoundError>()(
  "@kanna/server/ticket-board/TicketNotFoundError",
  {
    delegatorChatId: Schema.String,
    ticketId: Schema.String,
  },
) {
  override get message() {
    return `Ticket ${this.ticketId} not found on this delegator's board. list_tickets shows its tickets.`
  }
}

const TICKET_INPUT_PROBLEMS = {
  missing_title: "A ticket needs a title.",
  empty_title: "The title cannot be empty.",
  empty_reply: "A reply needs text or a file.",
} as const

/** A write the board refuses as given. The message is what the caller (an agent, or the user) reads. */
export class TicketInputError extends Schema.TaggedError<TicketInputError>()(
  "@kanna/server/ticket-board/TicketInputError",
  {
    problem: Schema.Literals(["missing_title", "empty_title", "empty_reply"]),
    delegatorChatId: Schema.String,
    ticketId: Schema.optionalKey(Schema.String),
  },
) {
  override get message() {
    return TICKET_INPUT_PROBLEMS[this.problem]
  }
}

export interface TicketBoardOptions {
  /** How a chat stands, as a ticket shows it. Read when a ticket is summarized. */
  readonly chatInfo: (chatId: string) => TicketChatInfo | undefined
  readonly now?: () => number
}

/**
 * Reads answer from the store's memory and never wait. A write applies in
 * memory before it first waits, as `TicketStore.append` does, and succeeds
 * once it is on disk.
 */
export class TicketBoard extends Context.Service<TicketBoard, {
  /** Bumped on every change, for memo keys and push decisions. */
  readonly version: Effect.Effect<number>

  readonly list: (delegatorChatId: string) => Effect.Effect<TicketRecord[]>
  readonly get: (delegatorChatId: string, ticketId: string) => Effect.Effect<Option.Option<TicketRecord>>
  readonly require: (delegatorChatId: string, ticketId: string) => Effect.Effect<TicketRecord, TicketNotFoundError>
  /** The column a ticket is in. Derived from the ticket and its chats; reads nothing else. */
  readonly stateOf: (ticket: TicketRecord) => TicketState
  /** A ticket's row. Derived from the ticket and its chats; reads nothing else. */
  readonly summary: (ticket: TicketRecord) => TicketSummary
  readonly summaries: (delegatorChatId: string) => Effect.Effect<TicketSummary[]>
  readonly detail: (delegatorChatId: string, ticketId: string) => Effect.Effect<Option.Option<TicketDetail>>
  readonly attention: (delegatorChatId: string) => Effect.Effect<number>
  /** Has the delegator ever had a ticket. Old delegators start with an empty board. */
  readonly hasBoard: (delegatorChatId: string) => Effect.Effect<boolean>
  /**
   * The outstanding hand-offs a report on the chat's turns up to `throughTurn`
   * covers: those whose message went into one of those turns. A turn that was
   * stopped for a steer is never reported, so its hand-offs fall to the next
   * turn's report, which carries the same work on.
   *
   * `final` is the chat's last word for now. It also covers hand-offs from
   * before turns were recorded, and any whose send never said where its
   * message went (a restart mid-send), except those still being sent.
   */
  readonly coveredBy: (
    delegatorChatId: string,
    childChatId: string,
    throughTurn: number,
    options?: { final?: boolean; sending?: ReadonlySet<string> },
  ) => Effect.Effect<TicketCoverage>
  /** Hand-offs still waiting in the chat's queue, to place in the turn that takes them. */
  readonly queuedFor: (delegatorChatId: string, childChatId: string) => Effect.Effect<TicketHandoff[]>
  /** The hand-offs a queued message carries. */
  readonly carriedBy: (delegatorChatId: string, childChatId: string, queuedMessageId: string) => Effect.Effect<TicketHandoff[]>
  /** Of these chats, the ones no hand-off links to any ticket. */
  readonly untracked: (delegatorChatId: string, chatIds: readonly string[]) => Effect.Effect<string[]>
  readonly findHandoff: (delegatorChatId: string, delegationId: string) => Effect.Effect<Option.Option<TicketHandoff>>

  readonly create: (
    delegatorChatId: string,
    input: { title: string; body?: string },
  ) => Effect.Effect<TicketRecord, TicketInputError | TicketStoreError>
  /** Succeeds with the ticket as it was found, which the edit then changes in place. */
  readonly edit: (
    delegatorChatId: string,
    ticketId: string,
    input: { title?: string; body?: string },
  ) => Effect.Effect<TicketRecord, TicketNotFoundError | TicketInputError | TicketStoreError>
  /**
   * An explicit close or reopen. A close takes the ticket to Done unless a
   * chat on it is still working or waiting (those win), and drops a question
   * or a reply it was waiting on. A reopen does something only to a Done
   * ticket: it stays out of Done until work handed on after it finishes, or
   * it is closed again. A user's reopen also waits on the delegator.
   * Succeeds with whether anything changed.
   */
  readonly setStatus: (
    delegatorChatId: string,
    ticketId: string,
    status: "done" | "open",
    by: TicketAuthor,
  ) => Effect.Effect<boolean, TicketNotFoundError | TicketStoreError>
  /**
   * A reply on the ticket. The delegator's answers a user reply
   * (`awaitingDelegator`) and may ask one (`asksUser: true`) or withdraw the
   * one it asked (`asksUser: false`, for a question settled elsewhere); the
   * user's answers a question, waits on the delegator, reads the ticket, and
   * reopens it if it was Done.
   */
  readonly reply: (delegatorChatId: string, ticketId: string, input: {
    author: TicketAuthor
    text: string
    artifacts?: TicketArtifact[]
    attachments?: ChatAttachment[]
    asksUser?: boolean
  }) => Effect.Effect<TicketReply, TicketNotFoundError | TicketInputError | TicketStoreError>
  /**
   * The delegator handed work on this ticket to a chat. A Done ticket comes
   * back out of it (`reopened`), and a user reply it was waiting on is answered.
   */
  readonly handoff: (
    delegatorChatId: string,
    ticketId: string,
    childChatId: string,
    options?: { outstanding?: boolean },
  ) => Effect.Effect<{ delegationId: string; reopened: boolean }, TicketNotFoundError | TicketStoreError>
  /** Hand-offs whose queued message was removed before a turn took it: never sent, so gone. */
  readonly withdraw: (delegatorChatId: string, handoffs: readonly TicketHandoff[]) => Effect.Effect<void, TicketStoreError>
  /** Where a hand-off's message went: a turn of the chat, or its queue to wait for one. */
  readonly delivered: (
    delegatorChatId: string,
    handoffs: readonly TicketHandoff[],
    where: { turn: number } | { queuedMessageId: string },
  ) => Effect.Effect<void, TicketStoreError>
  /**
   * A report on the turns that handled these hand-offs: each of their
   * tickets gets the line, the hand-offs are settled, and the report is news
   * the delegator has to pass on. Only these: a chat that worked for other
   * tickets in other turns reported on those with those turns.
   */
  readonly recordReport: (
    delegatorChatId: string,
    childChatId: string,
    kind: "chat_finished" | "chat_failed",
    covered: { handoffs: readonly TicketHandoff[]; tickets: readonly TicketRecord[] },
  ) => Effect.Effect<void, TicketStoreError>
  /** The chat stopped to ask the user something, on these tickets' work. Settles nothing. */
  readonly recordAsking: (delegatorChatId: string, childChatId: string, tickets: readonly TicketRecord[]) => Effect.Effect<void, TicketStoreError>
  /**
   * The chat owes no report any more without having made one: stopped by its
   * parent, adopted away, or a hand-off's message never sent. All its
   * hand-offs, or exactly `delegationIds`.
   */
  readonly settle: (delegatorChatId: string, childChatId: string, delegationIds?: string[]) => Effect.Effect<void, TicketStoreError>
  readonly markRead: (delegatorChatId: string, ticketId: string) => Effect.Effect<void, TicketNotFoundError | TicketStoreError>
  readonly markUnread: (delegatorChatId: string, ticketId: string) => Effect.Effect<void, TicketNotFoundError | TicketStoreError>

  /**
   * The tickets with news the delegator has not written on or handed work
   * from since, and clears the ledger. Called once each time its turns run
   * out, so each piece of news is nudged about at most once.
   */
  readonly takeUnanswered: (delegatorChatId: string) => Effect.Effect<Array<{ ticket: TicketRecord; reasons: TicketNewsReason[] }>>
  /** Drops the ledger without nudging: the user stopped the delegator, or it went away. */
  readonly forgetNews: (delegatorChatId: string) => Effect.Effect<void>
}>()("@kanna/server/TicketBoard") {
  static readonly layer = (options: TicketBoardOptions) => Layer.effect(this, makeTicketBoard(options))
}

function shortId(prefix: string, length = 8) {
  return `${prefix}_${crypto.randomUUID().replace(/-/g, "").slice(0, length)}`
}

function history(ticketId: string, at: number, event: HistoryInput): TicketStoreEventInput {
  return { type: "history_added", at, event: { id: shortId("th"), ticketId, createdAt: at, ...event } as TicketHistoryEvent }
}

/**
 * A board over the `TicketStore` in context. Exported beside the layer
 * because the orchestrator builds its own: its `chatInfo` reads the
 * orchestrator, which is built after the services.
 */
export const makeTicketBoard = Effect.fn("TicketBoard.make")(function* (options: TicketBoardOptions) {
  const store = yield* TicketStore
  const chatInfo = options.chatInfo
  const now = options.now ?? Date.now
  const ledgers = new Map<string, Map<string, LedgerEntry>>()

  // ── Reads ──────────────────────────────────────────────────────────────

  const get = (delegatorChatId: string, ticketId: string) => store.get(delegatorChatId, ticketId.trim())

  const require = Effect.fn("TicketBoard.require")(function* (delegatorChatId: string, ticketId: string) {
    const ticket = yield* get(delegatorChatId, ticketId)
    if (Option.isNone(ticket)) return yield* new TicketNotFoundError({ delegatorChatId, ticketId })
    return ticket.value
  })

  const stateOf = (ticket: TicketRecord): TicketState => deriveTicketState(ticket, ticketChatLinks(ticket, chatInfo))
  const summary = (ticket: TicketRecord): TicketSummary => summarizeTicket(ticket, chatInfo)
  const summaries = (delegatorChatId: string) => Effect.map(store.list(delegatorChatId), (tickets) => tickets.map(summary))

  /** The chat's outstanding hand-offs on this board, with their tickets. */
  const outstandingFor = (delegatorChatId: string, childChatId: string) =>
    Effect.map(store.list(delegatorChatId), (tickets) => {
      const found: Array<{ handoff: TicketHandoff; ticket: TicketRecord }> = []
      for (const ticket of tickets) {
        for (const handoff of ticket.handoffs) {
          if (handoff.childChatId === childChatId && handoff.outstanding) found.push({ handoff, ticket })
        }
      }
      return found
    })

  const queuedFor = (delegatorChatId: string, childChatId: string) =>
    Effect.map(outstandingFor(delegatorChatId, childChatId), (found) =>
      found.map(({ handoff }) => handoff).filter((handoff) => handoff.turn === null))

  /** A short id no ticket on this board has: `tk_` and six hex digits, more if it must. */
  const newTicketId = Effect.fnUntraced(function* (delegatorChatId: string) {
    for (let length = 6; ; length += 1) {
      const id = shortId("tk", length)
      if (Option.isNone(yield* store.get(delegatorChatId, id))) return id
    }
  })

  /**
   * The events that take a Done ticket back out of Done, or none. A close is
   * dropped with it, so the ticket is not held in Done once its new work ends.
   */
  const reopenEvents = (ticket: TicketRecord, at: number, cause: Extract<HistoryInput, { kind: "reopened" }>): TicketStoreEventInput[] => {
    if (stateOf(ticket) !== "done") return []
    return [
      history(ticket.id, at, cause),
      ...(ticket.closed?.status === "done" ? [{ type: "flags_set", at, ticketId: ticket.id, closed: null } as const] : []),
    ]
  }

  // ── The nudge's ledger ─────────────────────────────────────────────────

  const ledger = (delegatorChatId: string) => {
    let existing = ledgers.get(delegatorChatId)
    if (!existing) {
      existing = new Map()
      ledgers.set(delegatorChatId, existing)
    }
    return existing
  }

  const noteNews = (delegatorChatId: string, ticketId: string, reason: TicketNewsReason, at: number) => {
    const entries = ledger(delegatorChatId)
    const entry = entries.get(ticketId)
    if (entry) {
      entry.newsAt = at
      entry.reasons.push(reason)
    } else {
      entries.set(ticketId, { newsAt: at, reasons: [reason] })
    }
  }

  const noteAddressed = (delegatorChatId: string, ticketId: string, at: number) => {
    const entry = ledgers.get(delegatorChatId)?.get(ticketId)
    if (entry) entry.addressedAt = at
  }

  // ── Writes ─────────────────────────────────────────────────────────────

  const create = Effect.fn("TicketBoard.create")(function* (delegatorChatId: string, input: { title: string; body?: string }) {
    yield* Effect.annotateCurrentSpan("delegatorChatId", delegatorChatId)
    const title = input.title.trim()
    if (!title) return yield* new TicketInputError({ problem: "missing_title", delegatorChatId })
    const at = now()
    const id = yield* newTicketId(delegatorChatId)
    yield* store.append(delegatorChatId, [{
      type: "ticket_created",
      at,
      ticket: { id, number: yield* store.nextNumber(delegatorChatId), title, body: input.body?.trim() ?? "" },
    }])
    // Applied in memory by the append, before its write.
    return Option.getOrThrow(yield* store.get(delegatorChatId, id))
  })

  const edit = Effect.fn("TicketBoard.edit")(function* (delegatorChatId: string, ticketId: string, input: { title?: string; body?: string }) {
    yield* Effect.annotateCurrentSpan("delegatorChatId", delegatorChatId)
    const ticket = yield* require(delegatorChatId, ticketId)
    const at = now()
    const title = input.title?.trim()
    if (input.title !== undefined && !title) return yield* new TicketInputError({ problem: "empty_title", delegatorChatId, ticketId: ticket.id })
    const events: TicketStoreEventInput[] = []
    const renamed = title !== undefined && title !== ticket.title
    const body = input.body !== undefined && input.body.trim() !== ticket.body ? input.body.trim() : undefined
    if (renamed || body !== undefined) {
      events.push({ type: "ticket_edited", at, ticketId: ticket.id, ...(renamed ? { title } : {}), ...(body !== undefined ? { body } : {}) })
    }
    if (renamed) events.push(history(ticket.id, at, { kind: "renamed", from: ticket.title }))
    yield* store.append(delegatorChatId, events)
    return ticket
  })

  const setStatus = Effect.fn("TicketBoard.setStatus")(function* (delegatorChatId: string, ticketId: string, status: "done" | "open", by: TicketAuthor) {
    yield* Effect.annotateCurrentSpan("delegatorChatId", delegatorChatId)
    const ticket = yield* require(delegatorChatId, ticketId)
    const at = now()
    if (status === "done") {
      if (ticket.closed?.status === "done") return false
      yield* store.append(delegatorChatId, [
        { type: "flags_set", at, ticketId: ticket.id, closed: { status: "done", by, at }, asksUser: false, awaitingDelegator: false },
        history(ticket.id, at, { kind: "closed", by }),
      ])
      return true
    }
    if (stateOf(ticket) !== "done") return false
    yield* store.append(delegatorChatId, [
      { type: "flags_set", at, ticketId: ticket.id, closed: { status: "open", by, at }, ...(by === "user" ? { awaitingDelegator: true } : {}) },
      history(ticket.id, at, { kind: "reopened", cause: "manual", by }),
    ])
    return true
  })

  const reply = Effect.fn("TicketBoard.reply")(function* (delegatorChatId: string, ticketId: string, input: {
    author: TicketAuthor
    text: string
    artifacts?: TicketArtifact[]
    attachments?: ChatAttachment[]
    asksUser?: boolean
  }) {
    yield* Effect.annotateCurrentSpan("delegatorChatId", delegatorChatId)
    const ticket = yield* require(delegatorChatId, ticketId)
    const text = input.text.trim()
    if (!text && !input.artifacts?.length && !input.attachments?.length) {
      return yield* new TicketInputError({ problem: "empty_reply", delegatorChatId, ticketId: ticket.id })
    }
    const at = now()
    const added: TicketReply = {
      id: shortId("rp"),
      ticketId: ticket.id,
      author: input.author,
      text,
      ...(input.artifacts?.length ? { artifacts: input.artifacts } : {}),
      ...(input.attachments?.length ? { attachments: input.attachments } : {}),
      ...(input.author === "delegator" && input.asksUser ? { asksUser: true as const } : {}),
      createdAt: at,
    }
    const events: TicketStoreEventInput[] = []
    if (input.author === "user") {
      events.push(...reopenEvents(ticket, at, { kind: "reopened", cause: "user_reply" }))
      events.push({ type: "reply_added", at, reply: added })
      events.push({ type: "flags_set", at, ticketId: ticket.id, asksUser: false, awaitingDelegator: true })
      events.push({ type: "read_set", at, ticketId: ticket.id, readAt: at })
      noteNews(delegatorChatId, ticket.id, { kind: "user_reply" }, at)
    } else {
      events.push({ type: "reply_added", at, reply: added })
      events.push({ type: "flags_set", at, ticketId: ticket.id, awaitingDelegator: false, ...(input.asksUser !== undefined ? { asksUser: input.asksUser } : {}) })
      noteAddressed(delegatorChatId, ticket.id, at)
    }
    yield* store.append(delegatorChatId, events)
    return added
  })

  const handoff = Effect.fn("TicketBoard.handoff")(function* (delegatorChatId: string, ticketId: string, childChatId: string, options?: { outstanding?: boolean }) {
    yield* Effect.annotateCurrentSpan("delegatorChatId", delegatorChatId)
    yield* Effect.annotateCurrentSpan("childChatId", childChatId)
    const ticket = yield* require(delegatorChatId, ticketId)
    const at = now()
    const delegationId = shortId("dl")
    const outstanding = options?.outstanding ?? true
    const reopen = reopenEvents(ticket, at, { kind: "reopened", cause: "chat_started", chatId: childChatId })
    yield* store.append(delegatorChatId, [
      ...reopen,
      {
        type: "handoff_added",
        at,
        // Placed in a turn once its message is delivered (`delivered`).
        handoff: { delegationId, ticketId: ticket.id, childChatId, createdAt: at, outstanding, ...(outstanding ? { turn: null } : {}) },
      },
      history(ticket.id, at, { kind: "sent_to", chatId: childChatId }),
      ...(ticket.awaitingDelegator ? [{ type: "flags_set", at, ticketId: ticket.id, awaitingDelegator: false } as const] : []),
    ])
    noteAddressed(delegatorChatId, ticket.id, at)
    return { delegationId, reopened: reopen.length > 0 }
  })

  const withdraw = Effect.fn("TicketBoard.withdraw")(function* (delegatorChatId: string, handoffs: readonly TicketHandoff[]) {
    const at = now()
    yield* store.append(delegatorChatId, handoffs.map((entry) => ({
      type: "handoff_withdrawn" as const,
      at,
      ticketId: entry.ticketId,
      delegationId: entry.delegationId,
    })))
  })

  const delivered = Effect.fn("TicketBoard.delivered")(function* (
    delegatorChatId: string,
    handoffs: readonly TicketHandoff[],
    where: { turn: number } | { queuedMessageId: string },
  ) {
    const at = now()
    yield* store.append(delegatorChatId, handoffs.map((entry) => ({
      type: "handoff_delivered" as const,
      at,
      ticketId: entry.ticketId,
      delegationId: entry.delegationId,
      ...where,
    })))
  })

  const recordReport = Effect.fn("TicketBoard.recordReport")(function* (
    delegatorChatId: string,
    childChatId: string,
    kind: "chat_finished" | "chat_failed",
    covered: { handoffs: readonly TicketHandoff[]; tickets: readonly TicketRecord[] },
  ) {
    if (covered.handoffs.length === 0) return
    const at = now()
    yield* store.append(delegatorChatId, [
      ...covered.tickets.map((ticket) => history(ticket.id, at, { kind, chatId: childChatId })),
      { type: "handoffs_settled", at, childChatId, delegationIds: covered.handoffs.map((entry) => entry.delegationId) },
    ])
    for (const ticket of covered.tickets) noteNews(delegatorChatId, ticket.id, { kind: "report", chatId: childChatId }, at)
  })

  const recordAsking = Effect.fn("TicketBoard.recordAsking")(function* (delegatorChatId: string, childChatId: string, tickets: readonly TicketRecord[]) {
    if (tickets.length === 0) return
    const at = now()
    yield* store.append(delegatorChatId, tickets.map((ticket) => history(ticket.id, at, { kind: "chat_asking", chatId: childChatId })))
  })

  const settle = Effect.fn("TicketBoard.settle")(function* (delegatorChatId: string, childChatId: string, delegationIds?: string[]) {
    const owed = (yield* outstandingFor(delegatorChatId, childChatId))
      .filter(({ handoff: entry }) => !delegationIds || delegationIds.includes(entry.delegationId))
    if (owed.length === 0) return
    yield* store.append(delegatorChatId, [{ type: "handoffs_settled", at: now(), childChatId, ...(delegationIds ? { delegationIds } : {}) }])
  })

  const markRead = Effect.fn("TicketBoard.markRead")(function* (delegatorChatId: string, ticketId: string) {
    const ticket = yield* require(delegatorChatId, ticketId)
    const at = Math.max(now(), ticket.updatedAt)
    yield* store.append(delegatorChatId, [{ type: "read_set", at, ticketId: ticket.id, readAt: at }])
  })

  const markUnread = Effect.fn("TicketBoard.markUnread")(function* (delegatorChatId: string, ticketId: string) {
    const ticket = yield* require(delegatorChatId, ticketId)
    yield* store.append(delegatorChatId, [{ type: "read_set", at: now(), ticketId: ticket.id, readAt: null }])
  })

  const takeUnanswered = Effect.fn("TicketBoard.takeUnanswered")(function* (delegatorChatId: string) {
    const entries = ledgers.get(delegatorChatId)
    if (!entries) return []
    ledgers.delete(delegatorChatId)
    const unanswered: Array<{ ticket: TicketRecord; reasons: TicketNewsReason[] }> = []
    for (const [ticketId, entry] of entries) {
      if (entry.addressedAt !== undefined && entry.addressedAt >= entry.newsAt) continue
      const ticket = yield* store.get(delegatorChatId, ticketId)
      if (Option.isSome(ticket)) unanswered.push({ ticket: ticket.value, reasons: entry.reasons })
    }
    return unanswered.sort((a, b) => a.ticket.number - b.ticket.number)
  })

  return {
    version: store.version,
    list: store.list,
    get,
    require,
    stateOf,
    summary,
    summaries,
    detail: (delegatorChatId: string, ticketId: string) =>
      Effect.map(get(delegatorChatId, ticketId), Option.map((ticket) => describeTicket(ticket, chatInfo))),
    attention: (delegatorChatId: string) => Effect.map(summaries(delegatorChatId), ticketAttentionCount),
    hasBoard: (delegatorChatId: string) => Effect.map(store.list(delegatorChatId), (tickets) => tickets.length > 0),
    coveredBy: (delegatorChatId, childChatId, throughTurn, options) =>
      Effect.map(outstandingFor(delegatorChatId, childChatId), (outstanding): TicketCoverage => {
        const covered = outstanding.filter(({ handoff: entry }) => {
          if (typeof entry.turn === "number") return entry.turn <= throughTurn
          if (!options?.final) return false
          if (entry.turn === undefined) return true
          return !entry.queuedMessageId && !options.sending?.has(entry.delegationId)
        })
        const tickets = [...new Map(covered.map(({ ticket }) => [ticket.id, ticket])).values()].sort((a, b) => a.number - b.number)
        return { handoffs: covered.map(({ handoff: entry }) => entry), tickets }
      }),
    queuedFor,
    carriedBy: (delegatorChatId, childChatId, queuedMessageId) =>
      Effect.map(queuedFor(delegatorChatId, childChatId), (queued) =>
        queued.filter((entry) => entry.queuedMessageId === queuedMessageId)),
    untracked: (delegatorChatId, chatIds) =>
      Effect.map(store.list(delegatorChatId), (tickets) => {
        const linked = new Set<string>()
        for (const ticket of tickets) {
          for (const entry of ticket.handoffs) linked.add(entry.childChatId)
        }
        return chatIds.filter((chatId) => !linked.has(chatId))
      }),
    findHandoff: (delegatorChatId, delegationId) =>
      Effect.map(store.list(delegatorChatId), (tickets) => {
        for (const ticket of tickets) {
          const found = ticket.handoffs.find((candidate) => candidate.delegationId === delegationId)
          if (found) return Option.some(found)
        }
        return Option.none<TicketHandoff>()
      }),
    create,
    edit,
    setStatus,
    reply,
    handoff,
    withdraw,
    delivered,
    recordReport,
    recordAsking,
    settle,
    markRead,
    markUnread,
    takeUnanswered,
    forgetNews: (delegatorChatId: string) => Effect.sync(() => {
      ledgers.delete(delegatorChatId)
    }),
  } satisfies TicketBoard["Service"]
})
