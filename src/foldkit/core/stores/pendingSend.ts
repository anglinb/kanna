import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import type { SidebarProjectGroup } from "../../../shared/types"
import { opaque } from "../schema"

// Port of src/client/stores/pendingSendStore.ts. Not persisted.

/**
 * Chats with a prompt in flight — sent by this browser, not yet acknowledged in
 * a sidebar snapshot.
 *
 * This exists to close a gap the sidebar could otherwise see through. A chat you
 * have typed into is held in the Relevant section by its draft, and a chat that
 * is running is held in In Progress by its status. Pressing send clears the
 * draft immediately (the composer must empty on the keystroke, not on the round
 * trip) while the status is still idle and the chat still has no messages — so
 * for the length of the round trip the chat qualifies for nothing, and the row
 * vanishes and then reappears somewhere else.
 *
 * Recording *when* the send started, rather than a bare flag, does two jobs: it
 * places the row in In Progress at the position it will keep once the server
 * catches up (that section sorts by when you last hit send), and it makes the
 * entry self-expiring — see `isPendingSend`, which ignores an entry the chat's
 * own `lastMessageAt` has already overtaken. A dropped `clearSend` therefore
 * costs a stale map key and nothing else.
 */
export const Model = Schema.Struct({
  /** Chat id → when the send started (`Date.now()`). */
  sentAt: Schema.Record(Schema.String, Schema.Number),
})
export type Model = typeof Model.Type

export const initialModel: Model = { sentAt: {} }

export const Message = defineMessageUnion({
  /** Carries the time: update can't read the clock. `MarkSending` stamps it for a caller without one. */
  StartedSending: { chatId: Schema.String, sentAt: Schema.Number },
  ClearedSending: { chatId: Schema.String },
  /**
   * Every sidebar snapshot, after the sidebar model has it: the snapshot is the
   * moment we learn a send landed, so it is also where the in-flight
   * bookkeeping gets cleaned up (`setSnapshot` called `prunePendingSends`).
   */
  ReceivedSidebarSnapshot: { projectGroups: Schema.Array(opaque<SidebarProjectGroup>("SidebarProjectGroup")) },
})
export type Message = typeof Message.Type

/** `markSending(chatId)` with no time given: stamps now. */
export const MarkSending = Command.define("MarkSending", {
  args: { chatId: Schema.String },
  messages: [Message.StartedSending],
  execute: ({ chatId }) => Effect.sync(() => Message.StartedSending({ chatId, sentAt: Date.now() })),
})

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    StartedSending: ({ chatId, sentAt }) => ({ model: { sentAt: { ...model.sentAt, [chatId]: sentAt } } }),
    ClearedSending: ({ chatId }) => {
      if (!(chatId in model.sentAt)) return { model }
      const { [chatId]: _cleared, ...rest } = model.sentAt
      return { model: { sentAt: rest } }
    },
    ReceivedSidebarSnapshot: ({ projectGroups }) => ({ model: prunePendingSends(model, projectGroups) }),
  })

/**
 * Drop entries the sidebar snapshot has caught up with, and entries for chats it
 * no longer carries at all (deleted while a send was in flight).
 *
 * Housekeeping, not correctness: `isPendingSend` already ignores an overtaken
 * entry. This just stops the map growing for the length of a session.
 */
export function prunePendingSends(model: Model, projectGroups: ReadonlyArray<SidebarProjectGroup>): Model {
  const { sentAt } = model
  const pendingIds = Object.keys(sentAt)
  if (pendingIds.length === 0) return model

  const lastMessageAtByChatId = new Map<string, number>()
  for (const group of projectGroups) {
    for (const chat of group.chats) {
      lastMessageAtByChatId.set(chat.chatId, chat.lastMessageAt ?? 0)
    }
  }

  const settled = pendingIds.filter((chatId) => {
    const lastMessageAt = lastMessageAtByChatId.get(chatId)
    return lastMessageAt === undefined || lastMessageAt >= sentAt[chatId]!
  })
  if (settled.length === 0) return model

  const next = { ...sentAt }
  for (const chatId of settled) delete next[chatId]
  return { sentAt: next }
}

export type PendingSendTimes = ReadonlyMap<string, number>

const pendingSendTimesCache = new WeakMap<object, PendingSendTimes>()

/**
 * The in-flight sends, for the sidebar's section pass. `usePendingSendTimes`
 * memoized on the record; this caches on its identity, which only changes when
 * a send actually starts or lands, so the sections recompute then and only then.
 */
export function pendingSendTimes(model: Model): PendingSendTimes {
  let times = pendingSendTimesCache.get(model.sentAt)
  if (!times) {
    times = new Map(Object.entries(model.sentAt))
    pendingSendTimesCache.set(model.sentAt, times)
  }
  return times
}
