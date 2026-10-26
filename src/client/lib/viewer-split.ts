import type { ViewerWidthClass } from "../../foldkit/core/stores/viewer"

/**
 * How the chat page's split, the chat column beside the viewer's pane,
 * follows the viewer.
 *
 * The split is the chat's width, so moving it is layout: every step re-wraps
 * the transcript and re-measures the frames and tables in it. That is worth
 * showing when the chat is making room for a pane beside it. Under a pane
 * that covers the chat it is work nobody sees, and it leaves the transcript
 * somewhere other than where it was. So:
 *
 *   - Expanded, the split is left alone. A viewer opened straight to
 *     expanded never narrows the chat, and one expanded from its pane keeps
 *     the chat as narrow as it was, so collapsing finds it ready.
 *   - Out of expanded, the split is set in one step, to the pane's width or
 *     to nothing, while the viewer still covers the chat. One reflow, behind
 *     the card, instead of one per frame beside it.
 *   - Between closed and docked it slides, as it always has.
 *   - Docked and staying docked, it holds. The pane takes a width when it
 *     opens, from what it opens on, and keeps it for as long as it is open
 *     (or until it is dragged): a file opened over a chat, a chat picked
 *     from a list, a review after a preview all arrive in the pane as it
 *     stands. A surface that is the same before and after has no business
 *     moving, and each move re-wrapped the chat beside it for nothing.
 *
 * The same reasoning decides when the viewer's card plays its entrance
 * (`viewerCardEnters`): when the pane opens, and never when what is in an
 * open pane changes.
 */
export type ViewerPaneState = "closed" | "docked" | "expanded"

export function viewerPaneState(open: boolean, expanded: boolean): ViewerPaneState {
  if (!open) return "closed"
  return expanded ? "expanded" : "docked"
}

export interface ViewerSplitMove {
  /** Where the split goes: nowhere, shut, or to the docked width of what is open. */
  to: "hold" | "closed" | "docked"
  /** Slide there, rather than take it in one step. */
  animate: boolean
}

/**
 * `samePane` is false when what is being laid out is not the pane that was
 * there a moment ago: the page is on another chat, or the split is new
 * (another project, a phone turned desktop). Such a pane takes its own
 * layout, in one step. So does any move under reduced motion.
 */
export function resolveViewerSplitMove(
  previous: ViewerPaneState,
  next: ViewerPaneState,
  pane: { samePane: boolean; reducedMotion: boolean },
): ViewerSplitMove {
  if (next === "expanded") return { to: "hold", animate: false }
  if (previous === "docked" && next === "docked" && pane.samePane) return { to: "hold", animate: false }
  const continuous = pane.samePane && !pane.reducedMotion
  return { to: next, animate: continuous && previous !== "expanded" && (previous === "docked" || next === "docked") }
}

/**
 * Whether the viewer's card plays its entrance: only when the pane goes from
 * shut to open. A card mounted into a pane that was already open, because
 * what the pane shows changed (a chat picked from a list, a file over a
 * chat, Back), is the same surface in the same place, and stays still: only
 * its title and its body are new. Expanding and collapsing are not openings
 * either; the card slides between the two on its own.
 */
export function viewerCardEnters(previous: ViewerPaneState, next: ViewerPaneState): boolean {
  return previous === "closed" && next !== "closed"
}

/**
 * The viewer's pane for anything but a review of changes (a file, an
 * attachment, a chart): room for the markdown preview's 72ch measure with
 * air either side, or about 100 columns of code, and no wider, so the chat
 * keeps the rest of the room.
 */
const VIEWER_PREVIEW_PANE_WIDTH_PX = 800
/**
 * The viewer's pane for a sub-chat: half the room, so the chat it reports to
 * keeps the other half, between a width its composer still fits in and the
 * transcript column's own.
 */
const VIEWER_CHAT_PANE_MIN_WIDTH_PX = 420
const VIEWER_CHAT_PANE_MAX_WIDTH_PX = 800

/**
 * How wide a docked viewer is: the width you dragged it to, in this chat or
 * any other (`viewerWidthPx`), else the one for what's open. Never so wide
 * the chat goes under its minimum. The narrowing is only here, where it is
 * laid out: the dragged width stays as it was, and a wider window gets it
 * back.
 */
export function dockedViewerPaneWidthPx({ splitWidthPx, chatMinPx, draggedWidthPx, widthClass }: {
  splitWidthPx: number
  chatMinPx: number
  draggedWidthPx: number | null
  widthClass: ViewerWidthClass | null
}): number {
  const wanted = draggedWidthPx ?? (
    widthClass === "review"
      ? Infinity
      : widthClass === "chat"
        ? Math.min(VIEWER_CHAT_PANE_MAX_WIDTH_PX, Math.max(VIEWER_CHAT_PANE_MIN_WIDTH_PX, splitWidthPx / 2))
        : VIEWER_PREVIEW_PANE_WIDTH_PX
  )
  return Math.max(0, Math.min(splitWidthPx - chatMinPx, wanted))
}
