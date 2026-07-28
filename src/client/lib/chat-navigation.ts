/**
 * The router-state contract for opening a chat *at a message*.
 *
 * The URL stays `/chat/:chatId` — a jump is not a location, it's an instruction
 * carried alongside one. Putting it in history state rather than the path keeps
 * chat identity the single thing the URL means, and keeps a shared or reloaded
 * link landing wherever the reader left off rather than replaying someone
 * else's jump.
 *
 * `requestId` is what makes a repeat click work: navigating to the chat you are
 * already in produces the same pathname, so the message id alone can't say
 * "again". The chat page spends the id and clears the state.
 */
export interface ChatJumpLocationState {
  jumpToMessageId: string
  jumpRequestId: string
}

export function buildChatJumpLocationState(messageId: string): ChatJumpLocationState {
  return { jumpToMessageId: messageId, jumpRequestId: crypto.randomUUID() }
}

/** Reads the jump out of an opaque `useLocation().state`, or null if absent. */
export function readChatJumpLocationState(state: unknown): ChatJumpLocationState | null {
  if (!state || typeof state !== "object") return null
  const { jumpToMessageId, jumpRequestId } = state as Partial<ChatJumpLocationState>
  if (typeof jumpToMessageId !== "string" || typeof jumpRequestId !== "string") return null
  if (!jumpToMessageId || !jumpRequestId) return null
  return { jumpToMessageId, jumpRequestId }
}
