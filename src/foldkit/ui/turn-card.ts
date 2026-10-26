import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import type { Child } from "./attributes"

/**
 * The shared parts of the two cards that describe a turn on hover — the
 * sidebar's chat card and the transcript minimap's.
 *
 * They answer the same question about the same thing ("what was asked here,
 * what came back, and when"), differing only in which turn they found and what
 * else they have room to say, so the pieces that carry that answer live here
 * and both cards assemble them. Keeping them in one place is what stops the two
 * readings of one fact from drifting into two different-looking facts.
 *
 * Copied from src/client/components/ui/turn-card.tsx; see there for why the
 * inset is split between the rows and the card.
 */

/** A card using these rows wants `px-1.5` of its own, not `px-3`. */
export const TURN_CARD_ROW_INSET = "px-1.5 py-0.5"

/** Type and colour for the small-print rows above and below the messages. */
const TURN_CARD_META_TEXT = "text-[12px] tracking-wide text-muted-foreground"

/** Bullet between two facts sharing one side of a meta row. */
export function turnCardMetaSeparator<Message>(h: HtmlBuilder<Message>): Html {
  return h.span([h.AriaHidden(true), h.Class("opacity-60")], ["•"])
}

/** A meta line — the small print a card carries above or below its messages. */
export function turnCardMetaRow<Message>(options: { class?: string }, children: ReadonlyArray<Child>, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class(cn("flex items-center gap-1", TURN_CARD_META_TEXT, TURN_CARD_ROW_INSET, options.class))], children)
}

/**
 * One of a card's message blocks, clickable when the surface it sits on can
 * navigate at all (`onSelect`). Falls back to plain text rather than a
 * disabled button where it cannot: nothing should suggest a click that will
 * not happen.
 *
 *   turnCardMessage({ class: "line-clamp-3", label: "Open this turn", onSelect: SelectedTurn({ index }) }, [prompt], h)
 */
export function turnCardMessage<Message>(
  options: { class: string; label: string; onSelect?: Message },
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<Message>,
): Html {
  // Identical box metrics either way, so a message sits in exactly the same
  // place whether or not it happens to be clickable.
  if (options.onSelect === undefined) return h.div([h.Class(cn(options.class, TURN_CARD_ROW_INSET))], children)

  return h.button(
    [
      h.Type("button"),
      h.AriaLabel(options.label),
      h.OnClick(options.onSelect),
      h.Class(cn(
        TURN_CARD_ROW_INSET,
        "block w-full cursor-pointer rounded text-left transition-colors",
        "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )),
    ],
    // The caller's classes go on an inner span, not the button. A button
    // lays out its text in an anonymous inner box, so `line-clamp-*` on the
    // button itself does not clamp anything and long text runs unclipped.
    [h.span([h.Class(options.class)], children)],
  )
}

/**
 * The footer: how much and when, anchored right; what and by whom on the left.
 * `detail` and `timestamp` share the right edge with a bullet between them
 * because they read as one fact — "two minutes, an hour ago". Renders nothing
 * at all when it has nothing to say.
 *
 *   turnCardTimingRow({ detail: "2m", timestamp: "1h ago" }, h)
 */
export function turnCardTimingRow<Message>(
  options: { detail?: string | null; timestamp?: string | null; leading?: ReadonlyArray<Child> | null },
  h: HtmlBuilder<Message>,
): Html {
  const { detail, timestamp, leading } = options
  const hasLeading = leading !== undefined && leading !== null && leading.length > 0
  if (!detail && !timestamp && !hasLeading) return null

  return turnCardMetaRow({ class: "mt-1" }, [
    hasLeading ? h.span([h.Class("flex min-w-0 items-center gap-1")], leading) : null,
    // `ml-auto` on the group, so the pair holds the right edge together
    // whether or not anything is sitting on the left.
    detail || timestamp
      ? h.span([h.Class("ml-auto flex shrink-0 items-center gap-1 pl-2")], [
        detail ? h.span([], [detail]) : null,
        detail && timestamp ? turnCardMetaSeparator(h) : null,
        timestamp ? h.span([], [timestamp]) : null,
      ])
      : null,
  ], h)
}
