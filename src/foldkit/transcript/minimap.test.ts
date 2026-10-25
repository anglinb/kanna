import { describe, expect, test } from "bun:test"
import type { HtmlBuilder } from "foldkit/html"
import { Scene } from "foldkit/test"
import type { TranscriptTurn } from "../../client/app/ChatPage/transcriptTurns"
import { Message } from "./message"
import { MeasureMinimap, minimapResetKey, minimapView, type MinimapInputs, type MinimapState } from "./minimap"

// The minimap: a tick per turn once there is something to scroll, room
// beside the column and a fine pointer; the card for the turn the cursor
// holds; its jumps.

const TURNS: TranscriptTurn[] = [
  { id: "p1", rowIndex: 0, endRowIndex: 3, replyRowId: "a1", prompt: "Add a feet/meters toggle", response: "Done: the card switches units.", agentMessageCount: 4, error: null, timestamp: "2026-06-01T11:00:00.000Z", durationMs: 19_000 },
  { id: "p2", rowIndex: 4, endRowIndex: 6, replyRowId: "r2", prompt: "Now the swell arrow", response: null, agentMessageCount: 1, error: "Rate limited", timestamp: null, durationMs: null },
]

const INPUTS: MinimapInputs = { turns: TURNS, visibleStart: 4, visibleEnd: 6, transcriptOverflows: true, topPx: 72, bottomPx: 120, containerWidthPx: 1157 }
const STATE: MinimapState = { height: 600, pointerY: null, heldTurnId: null, finePointer: true }

function scene(state: MinimapState, inputs: MinimapInputs = INPUTS) {
  return {
    update: (model: MinimapState, message: Message) => ({ model: message._tag === "LeftMinimapCard" ? { ...model, heldTurnId: null } : model }),
    view: (model: MinimapState, h: HtmlBuilder<Message>) => h.main([], [minimapView(model, inputs, h)]),
    given: state,
  }
}

describe("minimap", () => {
  test("Scene: a tick per turn, named for its prompt", () => {
    const { given, ...program } = scene(STATE)
    Scene.scene(
      program,
      Scene.given(given),
      Scene.Mount.resolve(MeasureMinimap, Message.MeasuredMinimap({ height: 600 })),
      Scene.Mount.resolve({ name: "TrackTranscriptMinimapPointer" } as never, Message.MovedOverMinimap({ y: 0 })),
      Scene.expect(Scene.role("button", { name: "Jump to: Add a feet/meters toggle" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Jump to: Now the swell arrow" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Jump to this prompt" })).toBeAbsent(),
    )
  })

  test("Scene: nothing to map without a fine pointer, room, or anything to scroll", () => {
    for (const [state, inputs] of [
      [{ ...STATE, finePointer: false }, INPUTS],
      [STATE, { ...INPUTS, containerWidthPx: 800 }],
      [STATE, { ...INPUTS, transcriptOverflows: false }],
    ] as const) {
      const { given, ...program } = scene(state, inputs)
      Scene.scene(
        program,
        Scene.given(given),
        Scene.Mount.resolve(MeasureMinimap, Message.MeasuredMinimap({ height: 600 })),
        Scene.expect(Scene.role("button", { name: "Jump to: Add a feet/meters toggle" })).toBeAbsent(),
      )
    }
  })

  test("Scene: the held turn's card says what was asked, how it ended, and jumps to either", () => {
    const { given, ...program } = scene({ ...STATE, heldTurnId: "p2" })
    Scene.scene(
      program,
      Scene.given(given),
      Scene.Mount.resolve(MeasureMinimap, Message.MeasuredMinimap({ height: 600 })),
      Scene.Mount.resolve({ name: "TrackTranscriptMinimapPointer" } as never, Message.MovedOverMinimap({ y: 0 })),
      Scene.expect(Scene.role("button", { name: "Jump to this prompt" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Jump to this failure" })).toExist(),
      Scene.expect(Scene.text("1 message")).toExist(),
    )
  })

  test("the cursor and the hold reset when the strip's capacity, room or overflow changes", () => {
    expect(minimapResetKey(600, 1157, true)).toBe(minimapResetKey(601, 1157, true))
    expect(minimapResetKey(600, 1157, true)).not.toBe(minimapResetKey(600, 800, true))
    expect(minimapResetKey(600, 1157, true)).not.toBe(minimapResetKey(600, 1157, false))
  })
})
