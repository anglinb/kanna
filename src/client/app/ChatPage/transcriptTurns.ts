import type { ResolvedTranscriptRow } from "../KannaTranscript"

/**
 * Pure helpers backing the transcript overview minimap. Kept out of the
 * component so the turn-slicing and dock-magnification math stay unit testable.
 */

/** One conversational turn: a user prompt plus everything until the next one. */
export interface TranscriptTurn {
  /** Message id of the user prompt that opens the turn. */
  id: string
  /** Row index of the user prompt, used as the scroll target. */
  rowIndex: number
  /** Last row belonging to this turn, inclusive. */
  endRowIndex: number
  /** The user's question. */
  prompt: string
  /** The turn's final assistant message, if it has produced one yet. */
  response: string | null
  /**
   * Failure text, when the turn ended in an error result.
   *
   * A failed turn usually emits no assistant text at all — the provider dies
   * before it can say anything — so without this the turn would read as blank.
   */
  error: string | null
}

/**
 * Coerce a transcript text field to a trimmed string.
 *
 * The entry types declare these as required strings, but the transcript log is
 * append-only and replays entries written by older versions — a `result` or
 * `content` that was never written comes back undefined and would throw here,
 * taking the whole viewport render with it. Normalise once at the boundary so
 * everything downstream can trust the type.
 */
function asText(value: unknown): string {
  return typeof value === "string" ? value.trim() : ""
}

/**
 * Slice the flat row list into turns.
 *
 * Rows before the first user prompt (system init, account info, a restored
 * session's tail) belong to no turn and are simply dropped — the map is a map
 * of things you asked for.
 */
export function buildTranscriptTurns(rows: ResolvedTranscriptRow[]): TranscriptTurn[] {
  const turns: TranscriptTurn[] = []

  for (let index = 0; index < rows.length; index += 1) {
    const row = rows[index]
    if (row?.kind !== "single") continue

    if (row.message.kind === "user_prompt") {
      const previous = turns[turns.length - 1]
      if (previous) previous.endRowIndex = index - 1
      turns.push({
        id: row.message.id,
        rowIndex: index,
        endRowIndex: index,
        prompt: asText(row.message.content),
        response: null,
        error: null,
      })
      continue
    }

    const current = turns[turns.length - 1]
    if (!current) continue

    // Later assistant text overwrites earlier text, leaving the turn's last
    // word — which is the summary you actually want when scanning back. Blank
    // text never overwrites: a streaming turn emits empty entries before its
    // first token, and those would wipe a summary we already have.
    if (row.message.kind === "assistant_text") {
      const text = asText(row.message.text)
      if (text) current.response = text
      continue
    }

    // A cancelled turn is a choice, not a failure, so it stays unmarked and
    // keeps whatever text it managed to produce.
    if (row.message.kind === "result" && !row.message.success && !row.message.cancelled) {
      current.error = asText(row.message.result) || "Turn failed"
    }
  }

  const last = turns[turns.length - 1]
  if (last) last.endRowIndex = Math.max(last.rowIndex, rows.length - 1)

  return turns
}

/**
 * Whether a turn has any part of itself on screen.
 *
 * `visibleStart`/`visibleEnd` are LegendList's rendered row range, so this is
 * an interval overlap rather than a point test — a single long turn can span
 * the whole viewport with neither of its edges inside it.
 */
export function isTurnInView(turn: TranscriptTurn, visibleStart: number, visibleEnd: number): boolean {
  return turn.rowIndex <= visibleEnd && turn.endRowIndex >= visibleStart
}

/**
 * How many ticks fit at a comfortable pitch, clamped so the strip never runs
 * the full height of a tall window.
 */
export function getMinimapCapacity(availableHeightPx: number, pitchPx: number, maxTicks: number): number {
  if (!Number.isFinite(availableHeightPx) || availableHeightPx <= 0 || pitchPx <= 0) return 0
  return Math.max(0, Math.min(maxTicks, Math.floor(availableHeightPx / pitchPx)))
}

/** The most recent `capacity` turns — the map covers where you are, not all history. */
export function selectVisibleTurns(turns: TranscriptTurn[], capacity: number): TranscriptTurn[] {
  if (capacity <= 0) return []
  if (turns.length <= capacity) return turns
  return turns.slice(turns.length - capacity)
}

/**
 * macOS-dock falloff: 1 at the cursor, 0 at `radiusPx` and beyond, smoothstepped
 * in between so neighbours swell rather than stepping.
 */
export function getMagnifyFalloff(distancePx: number, radiusPx: number): number {
  if (radiusPx <= 0) return 0
  const t = 1 - Math.min(1, Math.abs(distancePx) / radiusPx)
  if (t <= 0) return 0
  return t * t * (3 - 2 * t)
}

/**
 * Horizontal gutter available on each side of the centred transcript column.
 *
 * The column is `min(maxColumnWidth, width - padding)` wide and centred, so
 * everything left over splits evenly. Returns 0 once the column fills the pane.
 */
export function getTranscriptGutterWidth(
  containerWidthPx: number,
  maxColumnWidthPx: number,
  horizontalPaddingPx: number,
): number {
  const usable = containerWidthPx - horizontalPaddingPx
  if (!Number.isFinite(usable) || usable <= 0) return 0
  return Math.max(0, (usable - maxColumnWidthPx) / 2)
}
