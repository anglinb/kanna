import type { ViewerItem } from "../../foldkit/core/stores/viewer"

/**
 * What is under what in the viewer's pane, and so where Back goes.
 *
 * The pane holds one thing at a time, but things are opened from other
 * things, and each remembers where it came from: a file opened over a chat
 * (`returnTo`), a chat stepped to from another (`back`), a chat picked from
 * a delegator's pane (`delegated`). Read together those are a stack, and
 * this is its one reading.
 *
 * Under all of it, on a delegator's page, is the pane's floor: the list of
 * the chats under the delegator. Whatever is opened there, from the list or
 * from the transcript, has the list under it, and Back returns to it. Under
 * the list is the pane shut, as it is under everything on an ordinary chat:
 * the floor is the last thing in the pane, not something that holds it open.
 *
 * Kept free of the store, for tests.
 */

/** As much of a chat's viewer as says what is under it. */
export interface ViewerLevel {
  item: ViewerItem
  returnTo?: { item: ViewerItem }
}

export type ViewerLevelBelow =
  /** What Back shows. */
  | { item: ViewerItem }
  /** Nothing is under it: one more step shuts the pane. */
  | "closed"

function sameItem(left: ViewerItem, right: ViewerItem) {
  return left.kind === "delegated" && right.kind === "delegated" && left.chatId === right.chatId
}

export function viewerLevelBelow(level: ViewerLevel, floor: ViewerItem | null): ViewerLevelBelow {
  const { item } = level
  // Something opened over a chat or the delegator's pane goes back to it.
  if (level.returnTo) return { item: level.returnTo.item }

  if (item.kind === "chat") {
    const origin = item.delegated ? { delegated: item.delegated } : {}
    const previous = item.back?.[item.back.length - 1]
    if (previous) {
      const back = item.back!.slice(0, -1)
      return { item: { kind: "chat", chatId: previous, ...(back.length > 0 ? { back } : {}), ...origin } }
    }
    // The first chat of a trail goes back to what it was picked from.
    if (item.delegated) return { item: { kind: "delegated", chatId: item.delegated } }
  }

  if (!floor || sameItem(item, floor)) return "closed"
  return { item: floor }
}

/** Whether Back has somewhere to go: a level under this one that is not the pane shut. */
export function hasViewerLevelBelow(level: ViewerLevel, floor: ViewerItem | null): boolean {
  return viewerLevelBelow(level, floor) !== "closed"
}
