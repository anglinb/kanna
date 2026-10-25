/**
 * Copied from src/client/components/messages/tool-card.ts, which imports a
 * React hook and so can't be imported here. See there for the reasons.
 */

/**
 * Sized like a user message (UserMessage's bubble): as wide as what it says,
 * up to the same share of the column, from the left edge where the agent's
 * rows sit.
 */
export const TOOL_CARD_WIDTH_CLASS = "w-fit min-w-0 max-w-[85%] sm:max-w-[80%]"
export const TOOL_CARD_CLASS = "flex min-w-0 flex-col gap-0.5 rounded-xl border border-border bg-card px-3 py-2.5 text-left text-sm"
/** The line under a card's title. 26px in: under the title, past the 16px glyph and the row's 10px gap. */
export const TOOL_CARD_CAPTION_CLASS = "truncate pl-[26px] text-xs leading-4 text-muted-foreground"
/** The same card as a quote, over the bubble of a message it is tied to (`ReplyQuoteRow`). */
export const TOOL_QUOTE_CLASS = "not-prose flex min-w-0 flex-col gap-0.5 rounded-xl border border-border/50 bg-transparent px-2.5 py-1.5 text-left text-sm"

/** A quote's measurements across, in px, for what has to line up with it from outside. */
export const QUOTE_GEOMETRY = { borderPx: 1, paddingXPx: 10, markPx: 16, markGapPx: 10 } as const
/** The centre of a quote's leading mark, from the quote's outer left edge. */
export const QUOTE_MARK_CENTER_PX = QUOTE_GEOMETRY.borderPx + QUOTE_GEOMETRY.paddingXPx + QUOTE_GEOMETRY.markPx / 2

/** The slot a card's leading mark is drawn in: one size for every mark, with the mark centred in it. */
export const TOOL_CARD_MARK_SLOT_CLASS = "flex size-4 shrink-0 items-center justify-center"

const TOOL_CARD_LIT_CLASS = "hover:border-muted-foreground/40 data-[hover-card-open]:border-muted-foreground/40"
const TOOL_QUOTE_LIT_CLASS = "hover:border-muted-foreground/20 data-[hover-card-open]:border-muted-foreground/20"

/** The box, the width and the lit border for a card, as itself or as a quote. */
export function toolCardClasses(quote: boolean) {
  return quote
    ? { box: TOOL_QUOTE_CLASS, width: "min-w-0", lit: TOOL_QUOTE_LIT_CLASS }
    : { box: TOOL_CARD_CLASS, width: TOOL_CARD_WIDTH_CLASS, lit: TOOL_CARD_LIT_CLASS }
}

export function asRecord(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object" && !Array.isArray(value) ? value as Record<string, unknown> : null
}

export function text(value: unknown): string | null {
  return typeof value === "string" && value.trim() ? value : null
}

/**
 * A result as an object. It is one already for a call recorded with its own
 * tool kind. An older record kept only what the provider was sent: the same
 * value as JSON, in a text block.
 */
export function resultRecord(result: unknown): Record<string, unknown> | null {
  const direct = asRecord(result)
  if (direct) return direct
  const first = Array.isArray(result) ? text(asRecord(result[0])?.text) : text(result)
  if (!first) return null
  try {
    return asRecord(JSON.parse(first))
  } catch {
    return null
  }
}

/** A failed call's own words, which say what to do next. */
export function toolCardErrorText(result: unknown, fallback: string): string {
  if (Array.isArray(result)) {
    const joined = result.map((block) => asRecord(block)?.text ?? "").join("\n").trim()
    if (joined) return joined
  }
  return fallback
}
