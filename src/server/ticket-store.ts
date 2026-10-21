import path from "node:path"
import { Context, Deferred, Effect, Exit, FileSystem, Layer, Option, Predicate, Schema } from "effect"
import type {
  TicketClosure,
  TicketHandoff,
  TicketHistoryEvent,
  TicketRecord,
  TicketReply,
} from "../shared/tickets"

/**
 * Where a delegator's tickets live: one append-only event file per delegator,
 * `tickets/<delegatorChatId>.jsonl`, folded into memory on boot.
 *
 * Kept apart from the EventStore's logs because nothing else reads it, and a
 * board only ever grows by small events (a reply, a history line, a hand-off).
 * Like the EventStore's logs it is compacted: once a file passes
 * `COMPACTION_THRESHOLD_BYTES` it is rewritten as one `board_snapshot` line,
 * and appends carry on after it. A crash mid-rewrite leaves the old file, as
 * the snapshot goes to a temp file that is renamed over.
 *
 * This file stores and folds. The rules (what a reply clears, when a ticket
 * reopens) are the orchestrator's, in `ticket-board.ts`.
 */

const TICKET_LOG_VERSION = 1
const COMPACTION_THRESHOLD_BYTES = 512 * 1024

export type TicketStoreEvent = { v: typeof TICKET_LOG_VERSION; at: number } & (
  | { type: "ticket_created"; ticket: Pick<TicketRecord, "id" | "number" | "title" | "body"> }
  | { type: "ticket_edited"; ticketId: string; title?: string; body?: string }
  | { type: "reply_added"; reply: TicketReply }
  | { type: "history_added"; event: TicketHistoryEvent }
  | { type: "handoff_added"; handoff: TicketHandoff }
  /** A hand-off's message went into the chat's queue, or into a turn of it. */
  | { type: "handoff_delivered"; ticketId: string; delegationId: string; turn?: number; queuedMessageId?: string }
  /**
   * A hand-off whose message was taken out of the chat's queue before any
   * turn took it: the work was never sent. The hand-off goes, and so does the
   * "sent to" line it added, so the ticket shows no row for work no chat had.
   */
  | { type: "handoff_withdrawn"; ticketId: string; delegationId: string }
  /**
   * The chat's outstanding hand-offs are settled: all of them, those on
   * `ticketIds`, or exactly `delegationIds`.
   */
  | { type: "handoffs_settled"; childChatId: string; ticketIds?: string[]; delegationIds?: string[] }
  /** `closed: null` drops the closure. */
  | { type: "flags_set"; ticketId: string; asksUser?: boolean; awaitingDelegator?: boolean; closed?: TicketClosure | null }
  | { type: "read_set"; ticketId: string; readAt: number | null }
  | { type: "board_snapshot"; tickets: TicketRecord[] }
)

/** One event, as callers hand it in: the store stamps the version. */
export type TicketStoreEventInput = TicketStoreEvent extends infer E ? E extends TicketStoreEvent ? Omit<E, "v"> : never : never

interface Board {
  tickets: Map<string, TicketRecord>
  /** Bytes in the file since its last compaction, to know when to compact again. */
  bytes: number
}

function cloneTicket(ticket: TicketRecord): TicketRecord {
  return {
    ...ticket,
    replies: [...ticket.replies],
    history: [...ticket.history],
    handoffs: ticket.handoffs.map((handoff) => ({ ...handoff })),
  }
}

/** Folds one event into a board. Unknown tickets are skipped, not fatal: an event can outlive what it pointed at. */
export function applyTicketEvent(tickets: Map<string, TicketRecord>, delegatorChatId: string, event: TicketStoreEvent) {
  switch (event.type) {
    case "board_snapshot": {
      tickets.clear()
      for (const ticket of event.tickets) tickets.set(ticket.id, cloneTicket(ticket))
      return
    }
    case "ticket_created": {
      tickets.set(event.ticket.id, {
        ...event.ticket,
        delegatorChatId,
        createdAt: event.at,
        updatedAt: event.at,
        asksUser: false,
        awaitingDelegator: false,
        replies: [],
        history: [],
        handoffs: [],
      })
      return
    }
    case "handoffs_settled": {
      const only = event.ticketIds ? new Set(event.ticketIds) : null
      const exactly = event.delegationIds ? new Set(event.delegationIds) : null
      for (const ticket of tickets.values()) {
        if (only && !only.has(ticket.id)) continue
        for (const handoff of ticket.handoffs) {
          if (handoff.childChatId !== event.childChatId) continue
          if (exactly && !exactly.has(handoff.delegationId)) continue
          handoff.outstanding = false
        }
      }
      return
    }
  }
  const ticketId = event.type === "reply_added"
    ? event.reply.ticketId
    : event.type === "history_added"
      ? event.event.ticketId
      : event.type === "handoff_delivered" || event.type === "handoff_withdrawn"
        ? event.ticketId
      : event.type === "handoff_added"
        ? event.handoff.ticketId
        : event.ticketId
  const ticket = tickets.get(ticketId)
  if (!ticket) return
  switch (event.type) {
    case "ticket_edited":
      if (event.title !== undefined) ticket.title = event.title
      if (event.body !== undefined) {
        ticket.body = event.body
        ticket.bodyEditedAt = event.at
      }
      return
    case "reply_added":
      ticket.replies.push(event.reply)
      ticket.updatedAt = Math.max(ticket.updatedAt, event.reply.createdAt)
      return
    case "history_added":
      ticket.history.push(event.event)
      ticket.updatedAt = Math.max(ticket.updatedAt, event.event.createdAt)
      return
    case "handoff_added":
      ticket.handoffs.push({ ...event.handoff })
      return
    case "handoff_delivered": {
      const handoff = ticket.handoffs.find((candidate) => candidate.delegationId === event.delegationId)
      if (!handoff) return
      if (event.turn !== undefined) handoff.turn = event.turn
      if (event.queuedMessageId !== undefined) handoff.queuedMessageId = event.queuedMessageId
      return
    }
    case "handoff_withdrawn": {
      const index = ticket.handoffs.findIndex((candidate) => candidate.delegationId === event.delegationId)
      if (index === -1) return
      const [handoff] = ticket.handoffs.splice(index, 1)
      // The line is written in the same batch as the hand-off, with its time.
      const line = ticket.history.findIndex((entry) => (
        entry.kind === "sent_to" && entry.chatId === handoff!.childChatId && entry.createdAt === handoff!.createdAt
      ))
      if (line !== -1) ticket.history.splice(line, 1)
      return
    }
    case "flags_set":
      if (event.asksUser !== undefined) ticket.asksUser = event.asksUser
      if (event.awaitingDelegator !== undefined) ticket.awaitingDelegator = event.awaitingDelegator
      if (event.closed === null) delete ticket.closed
      else if (event.closed) ticket.closed = { ...event.closed }
      return
    case "read_set":
      if (event.readAt === null) delete ticket.readAt
      else ticket.readAt = event.readAt
      return
  }
}

export class TicketStoreError extends Schema.TaggedError<TicketStoreError>()(
  "@kanna/server/ticket-store/TicketStoreError",
  {
    operation: Schema.Literals(["load", "append", "compact"]),
    delegatorChatId: Schema.optionalKey(Schema.String),
    filePath: Schema.String,
    cause: Schema.Defect(),
  },
) {
  override get message() {
    return this.cause instanceof Error ? this.cause.message : String(this.cause)
  }
}

export interface TicketStoreOptions {
  dataDir: string
  /** Compact a board's file once it passes this many bytes. Tests set it low. */
  compactionThresholdBytes?: number
}

/**
 * Every delegator's board, loaded when the layer is built. Reads answer
 * from memory; `append` applies in memory at once and then writes, one write
 * at a time, in the order the appends ran.
 */
export class TicketStore extends Context.Service<TicketStore, {
  readonly dir: string
  /** Bumped on every change, for memo keys and push decisions. */
  readonly version: Effect.Effect<number>
  /**
   * Applies the events in memory at once, then appends them in one write.
   * Applied first so a read straight after sees them, as the EventStore does.
   * Succeeds once the write is on disk.
   */
  readonly append: (delegatorChatId: string, events: TicketStoreEventInput[]) => Effect.Effect<void, TicketStoreError>
  /** For tests: compacts now, whatever the size. */
  readonly compact: (delegatorChatId: string) => Effect.Effect<void, TicketStoreError>
  /** Succeeds when every write queued so far has finished, failed or not. */
  readonly flush: Effect.Effect<void>
  readonly list: (delegatorChatId: string) => Effect.Effect<TicketRecord[]>
  readonly get: (delegatorChatId: string, ticketId: string) => Effect.Effect<Option.Option<TicketRecord>>
  readonly nextNumber: (delegatorChatId: string) => Effect.Effect<number>
  /** Delegators with a board, for sweeps that look across all of them. */
  readonly delegatorChatIds: Effect.Effect<string[]>
}>()("@kanna/server/TicketStore") {
  static readonly layer = (options: TicketStoreOptions) => Layer.effect(this, makeTicketStore(options))
}

const decodeLine = Schema.decodeUnknownOption(Schema.fromJsonString(Schema.Unknown))

/**
 * Events carry no Schema yet (`shared/tickets.ts` is plain types, and a
 * board must keep loading every line older builds wrote). A line is taken
 * when it is this log version's; `applyTicketEvent` skips what it cannot
 * place, and a line that throws while folding is skipped like a bad one.
 */
const isCurrentEvent = (value: unknown): value is TicketStoreEvent =>
  Predicate.hasProperty(value, "v") && value.v === TICKET_LOG_VERSION

const makeTicketStore = Effect.fn("TicketStore.make")(function* (options: TicketStoreOptions) {
  const fs = yield* FileSystem.FileSystem
  const dir = path.join(options.dataDir, "tickets")
  const compactionThresholdBytes = options.compactionThresholdBytes ?? COMPACTION_THRESHOLD_BYTES
  const boards = new Map<string, Board>()
  let version = 0
  const filePath = (delegatorChatId: string) => path.join(dir, `${delegatorChatId}.jsonl`)
  const fail = (operation: TicketStoreError["operation"], target: string, delegatorChatId?: string) => (cause: unknown) =>
    Effect.fail(new TicketStoreError({ operation, filePath: target, cause, ...(delegatorChatId === undefined ? {} : { delegatorChatId }) }))

  // The write chain: each write starts when the one queued before it has
  // finished, failed or not.
  let tail: Effect.Effect<void> = Effect.void
  const enqueueWrite = (write: Effect.Effect<void, TicketStoreError>) => Effect.suspend(() => {
    const previous = tail
    const done = Deferred.makeUnsafe<void>()
    tail = Deferred.await(done)
    return previous.pipe(
      Effect.andThen(write),
      Effect.tapError((error) => Effect.logWarning("tickets: write failed:", error)),
      Effect.ensuring(Deferred.succeed(done, undefined)),
    )
  })

  const board = (delegatorChatId: string): Board => {
    let existing = boards.get(delegatorChatId)
    if (!existing) {
      existing = { tickets: new Map(), bytes: 0 }
      boards.set(delegatorChatId, existing)
    }
    return existing
  }

  /** Rewrites the file as one snapshot of the board as it is in memory. Runs on the write chain. */
  const compactBoard = (delegatorChatId: string) => Effect.suspend(() => {
    const current = boards.get(delegatorChatId)
    if (!current) return Effect.void
    const snapshot: TicketStoreEvent = {
      v: TICKET_LOG_VERSION,
      at: Date.now(),
      type: "board_snapshot",
      tickets: [...current.tickets.values()].map(cloneTicket),
    }
    const text = `${JSON.stringify(snapshot)}\n`
    const target = filePath(delegatorChatId)
    const temp = `${target}.tmp`
    return fs.writeFileString(temp, text).pipe(
      Effect.andThen(fs.rename(temp, target)),
      Effect.andThen(Effect.sync(() => { current.bytes = Buffer.byteLength(text) })),
      Effect.catchTag("PlatformError", fail("compact", target, delegatorChatId)),
    )
  }).pipe(Effect.withSpan("TicketStore.compactBoard", { attributes: { delegatorChatId } }))

  const loadBoard = Effect.fnUntraced(function* (delegatorChatId: string) {
    const target = filePath(delegatorChatId)
    const bytes = yield* fs.readFile(target).pipe(Effect.catchTag("PlatformError", fail("load", target, delegatorChatId)))
    const loaded: Board = { tickets: new Map(), bytes: bytes.byteLength }
    const lines = Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("utf8").split("\n")
    for (const [index, line] of lines.entries()) {
      if (!line.trim()) continue
      const event = decodeLine(line)
      const folded = Option.isSome(event) && isCurrentEvent(event.value)
        ? yield* Effect.exit(Effect.sync(() => applyTicketEvent(loaded.tickets, delegatorChatId, event.value as TicketStoreEvent)))
        : null
      // A line cut off by a crash. Anything else bad is skipped too: a board
      // that loses one event is better than one that does not load.
      const bad = Option.isNone(event) || (folded !== null && Exit.isFailure(folded))
      if (bad && index < lines.length - 2) {
        yield* Effect.logWarning(`tickets: skipped a bad line in ${delegatorChatId}.jsonl`)
      }
    }
    boards.set(delegatorChatId, loaded)
    if (loaded.bytes >= compactionThresholdBytes) yield* enqueueWrite(compactBoard(delegatorChatId))
  })

  yield* fs.makeDirectory(dir, { recursive: true }).pipe(Effect.catchTag("PlatformError", fail("load", dir)))
  const names = (yield* fs.readDirectory(dir).pipe(Effect.catchTag("PlatformError", fail("load", dir))))
    .filter((name) => name.endsWith(".jsonl"))
  for (const name of names) {
    yield* loadBoard(name.slice(0, -".jsonl".length))
  }

  const append = Effect.fn("TicketStore.append")(function* (delegatorChatId: string, events: TicketStoreEventInput[]) {
    if (events.length === 0) return
    yield* Effect.annotateCurrentSpan("delegatorChatId", delegatorChatId)
    const current = board(delegatorChatId)
    const stamped = events.map((event) => ({ v: TICKET_LOG_VERSION, ...event }) as TicketStoreEvent)
    for (const event of stamped) applyTicketEvent(current.tickets, delegatorChatId, event)
    version += 1
    const text = stamped.map((event) => `${JSON.stringify(event)}\n`).join("")
    const target = filePath(delegatorChatId)
    yield* enqueueWrite(fs.makeDirectory(dir, { recursive: true }).pipe(
      Effect.andThen(fs.writeFileString(target, text, { flag: "a" })),
      Effect.catchTag("PlatformError", fail("append", target, delegatorChatId)),
      Effect.andThen(Effect.suspend(() => {
        current.bytes += Buffer.byteLength(text)
        return current.bytes >= compactionThresholdBytes ? compactBoard(delegatorChatId) : Effect.void
      })),
    ))
  })

  return {
    dir,
    version: Effect.sync(() => version),
    append,
    compact: (delegatorChatId: string) => enqueueWrite(compactBoard(delegatorChatId)),
    flush: Effect.suspend(() => tail),
    list: (delegatorChatId: string) => Effect.sync(() => [...(boards.get(delegatorChatId)?.tickets.values() ?? [])]),
    get: (delegatorChatId: string, ticketId: string) =>
      Effect.sync(() => Option.fromUndefinedOr(boards.get(delegatorChatId)?.tickets.get(ticketId))),
    nextNumber: (delegatorChatId: string) => Effect.sync(() => {
      let highest = 0
      for (const ticket of boards.get(delegatorChatId)?.tickets.values() ?? []) highest = Math.max(highest, ticket.number)
      return highest + 1
    }),
    delegatorChatIds: Effect.sync(() => [...boards.keys()]),
  } satisfies TicketStore["Service"]
})
