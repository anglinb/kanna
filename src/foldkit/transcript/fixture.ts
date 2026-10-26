import type { TranscriptEntry, TranscriptOutlineEntry } from "../../shared/types"

// A chat longer than its window, for the window parity pages
// (src/parity/{react,foldkit}/gallery/transcript-window): eight turns, of
// which the last three are loaded at first, the outline naming them all.
// Load More brings two turns more; a jump to an unloaded turn loads until it.

/** An hour before the runner's frozen clock (2026-06-01T12:00Z), a second apart. */
const BASE_TIME = Date.UTC(2026, 5, 1, 11, 0, 0)

const TOPICS = [
  ["the tide chart's axis labels", "The axis now labels every second hour, so the chart reads at a glance on a phone."],
  ["a sunrise time under the chart", "Sunrise comes from the forecast's daily block and sits under the chart in the muted style."],
  ["the swell direction as an arrow", "The arrow rotates with the swell and points where the waves travel."],
  ["offline caching for the forecast", "The last forecast is kept in IndexedDB and shown with its age while offline."],
  ["a refresh on pull", "Pulling the list down refetches the forecast and shows the spinner the header already has."],
  ["the units toggle in settings", "The toggle moved to settings; the card reads it from the same store."],
  ["a wind gust warning", "Gusts over 25 knots now tint the wind row and say so in its label."],
  ["tests for the formatters", "Every formatter has a test now, and `bun test src/lib` passes."],
] as const

export const WINDOW_CHAT_ID = "chat-window-gallery"
/** Turns loaded when the page opens. */
const INITIAL_TURNS = 3
/** Turns one Load More brings. */
const PAGE_TURNS = 2

export interface WindowFixture {
  entries: TranscriptEntry[]
  outline: TranscriptOutlineEntry[]
  /** Index into `entries` where each turn starts. */
  turnStarts: number[]
  initialStart: number
}

export function windowFixture(): WindowFixture {
  const entries: TranscriptEntry[] = []
  const turnStarts: number[] = []
  const outline: TranscriptOutlineEntry[] = []
  let clock = 0
  const at = () => BASE_TIME + (clock += 1000)
  TOPICS.forEach(([topic, answer], index) => {
    const turn = index + 1
    turnStarts.push(entries.length)
    const promptId = `w-p${turn}`
    const content = `Now add ${topic}.`
    const createdAt = at()
    entries.push({ _id: promptId, kind: "user_prompt", content, createdAt } as TranscriptEntry)
    outline.push({ id: promptId, index: entries.length - 1, preview: content, createdAt })
    entries.push({ _id: `w-a${turn}`, kind: "assistant_text", text: `Looking at where ${topic} would go first.`, createdAt: at() } as TranscriptEntry)
    entries.push({
      _id: `w-c${turn}`,
      kind: "tool_call",
      tool: { kind: "tool", toolKind: "read_file", toolName: "Read", toolId: `t-w-${turn}`, input: { filePath: `/Users/demo/code/tidepool/src/turn${turn}.ts` } },
      createdAt: at(),
    } as TranscriptEntry)
    entries.push({ _id: `w-r${turn}`, kind: "tool_result", toolId: `t-w-${turn}`, content: "1→export {}", createdAt: at() } as TranscriptEntry)
    entries.push({
      _id: `w-b${turn}`,
      kind: "assistant_text",
      text: `${answer}\n\n- It follows the card's spacing.\n- Nothing else on the screen moved.\n\nTell me if you'd like it somewhere else.`,
      createdAt: at(),
    } as TranscriptEntry)
    entries.push({ _id: `w-res${turn}`, kind: "result", subtype: "success", isError: false, durationMs: 12_000 + turn * 1000, result: "", createdAt: at() } as TranscriptEntry)
  })
  return { entries, outline, turnStarts, initialStart: turnStarts[turnStarts.length - INITIAL_TURNS]! }
}

/** Where the window starts once older messages are loaded: two turns more, or back to `untilMessageId`'s turn. */
export function olderStart(fixture: WindowFixture, start: number, untilMessageId: string | null | undefined): number {
  if (untilMessageId) {
    const index = fixture.entries.findIndex((entry) => entry._id === untilMessageId)
    if (index >= 0) return Math.min(start, index)
  }
  const turn = fixture.turnStarts.indexOf(start)
  const from = turn === -1 ? 0 : Math.max(0, turn - PAGE_TURNS)
  return fixture.turnStarts[from] ?? 0
}
