import type { ReactNode } from "react"
import { cn } from "../../lib/utils"

/**
 * The shared parts of the two cards that describe a turn on hover — the
 * sidebar's chat card and the transcript minimap's.
 *
 * They answer the same question about the same thing ("what was asked here,
 * what came back, and when"), differing only in which turn they found and what
 * else they have room to say, so the pieces that carry that answer live here
 * and both cards assemble them. Keeping them in one place is what stops the two
 * readings of one fact from drifting into two different-looking facts.
 */

/**
 * The horizontal inset every row of a card carries, paired with a card whose
 * own padding is the other half.
 *
 * Split that way because one row — the message blocks — has a hover fill, and a
 * fill that stops where the text starts reads as a box bolted onto the line
 * rather than a band you can hit. Paying for it with negative margins on a
 * `w-full` element does not work: the width resolves against the parent's
 * content box and the margins then push both edges outward, so the fill
 * overhangs the card. Giving the padding to the rows and taking it off the card
 * puts every line at the same optical inset with nothing overhanging.
 *
 * A card using these rows therefore wants `px-1.5` of its own, not `px-3`.
 */
export const TURN_CARD_ROW_INSET = "px-1.5 py-0.5"

/** Type and colour for the small-print rows above and below the messages. */
const TURN_CARD_META_TEXT = "text-[12px] tracking-wide text-muted-foreground"

/** Bullet between two facts sharing one side of a meta row. */
export function TurnCardMetaSeparator() {
  return <span aria-hidden className="opacity-60">•</span>
}

/** A meta line — the small print a card carries above or below its messages. */
export function TurnCardMetaRow({ children, className }: { children: ReactNode, className?: string }) {
  return (
    <div className={cn("flex items-center gap-1", TURN_CARD_META_TEXT, TURN_CARD_ROW_INSET, className)}>
      {children}
    </div>
  )
}

/**
 * One of a card's message blocks, clickable when the surface it sits on can
 * navigate at all.
 *
 * Falls back to plain text rather than a disabled button where it cannot — the
 * sidebar's archived list, which has no chat to open in place. Nothing should
 * suggest a click that will not happen.
 */
export function TurnCardMessage({
  children,
  className,
  onSelect,
  label,
}: {
  children: ReactNode
  className: string
  onSelect?: () => void
  label: string
}) {
  // Identical box metrics either way, so a message sits in exactly the same
  // place whether or not it happens to be clickable.
  if (!onSelect) return <div className={cn(className, TURN_CARD_ROW_INSET)}>{children}</div>

  return (
    <button
      type="button"
      aria-label={label}
      onClick={onSelect}
      // Deliberately no display utility here: `line-clamp-*` works by setting
      // `display: -webkit-box`, so adding `block` would race it in the
      // stylesheet and could unclamp the text.
      className={cn(
        className,
        TURN_CARD_ROW_INSET,
        "w-full cursor-pointer rounded text-left transition-colors",
        "hover:bg-muted/60 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring",
      )}
    >
      {children}
    </button>
  )
}

/**
 * The footer: how long the turn ran on the left, when it happened on the right.
 *
 * Split to the two edges rather than run together, because down a stack of
 * cards these are read as columns — a duration you compare against the one
 * above it, a time you scan for — and a pair of values sharing one end of the
 * line makes both of them something you hunt along the row for instead.
 *
 * `leading` is whatever else the card knows and the other doesn't (the
 * sidebar's harness), which joins the duration on the left since both describe
 * *how* the turn ran rather than when.
 *
 * Renders nothing at all when it has nothing to say, so a card with no timing
 * doesn't carry an empty line.
 */
export function TurnCardTimingRow({
  duration,
  timestamp,
  leading,
}: {
  duration?: string | null
  timestamp?: string | null
  leading?: ReactNode
}) {
  if (!duration && !timestamp && !leading) return null

  return (
    <TurnCardMetaRow className="mt-1">
      {leading ? <span className="flex min-w-0 shrink-0 items-center gap-1">{leading}</span> : null}
      {leading && duration ? <TurnCardMetaSeparator /> : null}
      {duration ? <span className="shrink-0">{duration}</span> : null}
      {/* `ml-auto` on the timestamp alone, so it holds the right edge whether or
          not anything is sitting on the left. */}
      {timestamp ? <span className="ml-auto shrink-0 pl-2">{timestamp}</span> : null}
    </TurnCardMetaRow>
  )
}
