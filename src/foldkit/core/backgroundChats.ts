import { Effect } from "effect"
import type { KannaSocket } from "../../client/app/socket"
import {
  cachedWindowToMessages,
  persistWindow,
  readMemoryCachedWindow,
  rememberWindow,
} from "../../client/app/chatTranscriptCache"
import { isProcessingStatus } from "../../client/app/derived"
import { applyIncrementalChatSnapshot } from "./snapshotEquality"
import type { SubscriptionTopic } from "../../shared/protocol"
import { trimTranscriptWindow } from "../../shared/transcript-window"
import type { ChatSnapshot } from "../../shared/types"
import { KannaSocketResource } from "./socket"

// Port of useBackgroundChatSubscriptions' followChatInBackground: a running
// chat that isn't open is held on a background subscription so opening it
// paints from a current window. Which chats are followed is decided in the
// root update (Model.backgroundChats); these Commands' effects hold the
// handles, one per chat, for the socket's lifetime.

type TranscriptWindow = Pick<ChatSnapshot, "messages" | "startIndex">

const followed = new Map<string, () => void>()

function spanOf(window: TranscriptWindow | null) {
  const last = window?.messages[window.messages.length - 1]
  return window && last
    ? { start: window.startIndex, end: window.startIndex + window.messages.length, endEntryId: last._id }
    : null
}

/**
 * Follow one chat in the background, keeping its memory window current.
 *
 * Starts from the memory window when there is one, so the server answers with
 * a tail. The window is trimmed as it grows: nothing renders it, and a chat
 * that runs for an hour must not hold every entry it wrote.
 */
function followChatInBackground(socket: KannaSocket, chatId: string, windowSize: number): () => void {
  let held: TranscriptWindow | null = null
  let unsubscribe = () => {}

  const topicFor = (window: TranscriptWindow | null): SubscriptionTopic => {
    const span = spanOf(window)
    return { type: "chat", chatId, background: true, ...(span ? { cachedSpan: span } : {}) }
  }

  const subscribe = (seed: TranscriptWindow | null) => {
    held = seed
    unsubscribe = socket.subscribe<ChatSnapshot | null>(topicFor(seed), (snapshot) => {
      if (!snapshot) return
      const next = applyIncrementalChatSnapshot(held, snapshot)
      if (!next) {
        // A body that doesn't meet what is held. Start over without a span;
        // the full window that answers it is always placeable.
        unsubscribe()
        subscribe(null)
        return
      }
      held = trimTranscriptWindow({ messages: next.messages, startIndex: next.startIndex }, windowSize)
      if (isProcessingStatus(next.runtime.status)) {
        rememberWindow(chatId, held)
      } else {
        // Settled: also worth keeping across a reload.
        persistWindow(chatId, held)
      }
    }, undefined, {
      topicOnReconnect: () => topicFor(held),
    })
  }

  const memory = readMemoryCachedWindow(chatId)
  subscribe(memory ? trimTranscriptWindow(cachedWindowToMessages(memory), windowSize) : null)
  return () => unsubscribe()
}

export function followChat(chatId: string, windowSize: number) {
  return Effect.gen(function* () {
    if (followed.has(chatId)) return
    const socket = yield* KannaSocketResource.get
    followed.set(chatId, followChatInBackground(socket, chatId, windowSize))
  }).pipe(Effect.ignore)
}

export function unfollowChat(chatId: string) {
  return Effect.sync(() => {
    followed.get(chatId)?.()
    followed.delete(chatId)
  })
}

/** On socket release: the socket's own dispose drops the subscriptions. */
export function forgetAllFollowed() {
  return Effect.sync(() => followed.clear())
}
