import {
  CHAT_TURN_INDEX_LIMIT,
  CHAT_TURN_SUMMARY_TEXT_LIMIT,
  type ChatTurnSummary,
  type TranscriptEntry,
} from "../shared/types"

/**
 * A compact index of every turn in a chat, for the transcript overview map.
 *
 * The map has to show turns the client has not loaded — a tool-heavy chat can
 * spend hundreds of entries on a single turn, so the recent-messages window
 * routinely holds only one or two of them. Summaries are two orders of
 * magnitude smaller than the entries they stand for, so the whole conversation
 * fits in a payload where even one extra page of transcript would not.
 *
 * Folded entry by entry so the same code serves a cold full scan and the
 * incremental extension on append.
 */

function truncate(value: unknown): string {
  if (typeof value !== "string") return ""
  const trimmed = value.trim()
  return trimmed.length <= CHAT_TURN_SUMMARY_TEXT_LIMIT
    ? trimmed
    : `${trimmed.slice(0, CHAT_TURN_SUMMARY_TEXT_LIMIT - 1)}…`
}

/**
 * Fold one entry into the index, in place.
 *
 * Hidden entries are skipped throughout: they do not render in the transcript,
 * so a tick standing for one would point at nothing.
 */
export function appendTurnEntry(turns: ChatTurnSummary[], entry: TranscriptEntry): void {
  if (entry.hidden) return

  if (entry.kind === "user_prompt") {
    turns.push({
      id: entry._id,
      prompt: truncate(entry.content),
      response: null,
      error: null,
      createdAt: entry.createdAt,
      durationMs: null,
    })
    // Bounded from the front: the map only ever renders the recent tail.
    if (turns.length > CHAT_TURN_INDEX_LIMIT) turns.splice(0, turns.length - CHAT_TURN_INDEX_LIMIT)
    return
  }

  const current = turns[turns.length - 1]
  if (!current) return

  // Later text supersedes earlier, leaving the turn's last word. Blank text
  // never overwrites — a streaming turn emits empty entries before its first
  // token, and those would wipe a summary we already have.
  if (entry.kind === "assistant_text") {
    const text = truncate(entry.text)
    if (text) current.response = text
    return
  }

  if (entry.kind === "result") {
    // Every result carries a duration, including a failed one — how long a
    // turn ran before dying is worth as much as how long a good one took.
    if (typeof entry.durationMs === "number") current.durationMs = entry.durationMs
    // A cancelled turn is a choice, not a failure.
    if (entry.isError && entry.subtype !== "cancelled") {
      current.error = truncate(entry.result) || "Turn failed"
    }
  }
}

export function buildTurnIndex(entries: Iterable<TranscriptEntry>): ChatTurnSummary[] {
  const turns: ChatTurnSummary[] = []
  for (const entry of entries) {
    appendTurnEntry(turns, entry)
  }
  return turns
}

/**
 * The only entry kinds that move the index. Everything else — overwhelmingly
 * tool calls and their results — is inert here.
 */
const TURN_MARKERS = [
  Buffer.from('"kind":"user_prompt"'),
  Buffer.from('"kind":"assistant_text"'),
  Buffer.from('"kind":"result"'),
] as const

const NEWLINE = 0x0a

/**
 * Build the index straight from a transcript's bytes.
 *
 * A chat spends most of its transcript on tool traffic: a 24MB file is ~6000
 * lines of which ~700 can affect the index. Splitting the whole file into
 * lines and parsing each one costs more in string allocation than the read
 * itself, so instead the marker substrings are located with `Buffer.indexOf`
 * (native memmem) and only the enclosing lines are materialized and parsed.
 *
 * A marker can also appear inside a tool result's payload; those lines parse
 * to an inert kind and fold to nothing, so false positives cost one parse and
 * are not worth excluding.
 */
export function buildTurnIndexFromBuffer(buffer: Buffer): ChatTurnSummary[] {
  const lineStarts: number[] = []
  const seen = new Set<number>()

  for (const marker of TURN_MARKERS) {
    let at = buffer.indexOf(marker, 0)
    while (at !== -1) {
      const start = buffer.lastIndexOf(NEWLINE, at) + 1
      if (!seen.has(start)) {
        seen.add(start)
        lineStarts.push(start)
      }
      at = buffer.indexOf(marker, at + marker.length)
    }
  }

  // Entries must fold in file order; markers were found per-kind, not in order.
  lineStarts.sort((left, right) => left - right)

  const turns: ChatTurnSummary[] = []
  for (const start of lineStarts) {
    const newline = buffer.indexOf(NEWLINE, start)
    const end = newline === -1 ? buffer.length : newline
    const line = buffer.toString("utf8", start, end).trim()
    if (!line) continue
    try {
      appendTurnEntry(turns, JSON.parse(line) as TranscriptEntry)
    } catch {
      // One malformed line should cost its own turn, not the whole map.
      continue
    }
  }
  return turns
}
