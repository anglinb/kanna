import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Story } from "foldkit/test"
import { fromString } from "foldkit/url"
import type { Flags, Model as AppModel } from "../app/model"
import * as Stores from "../app/stores"
import { init as initApp } from "../app/update"
import { memoryStorage } from "../core/stores/testing"
import * as Messages from "./messages"
import { Message } from "./message"
import { init, type Model } from "./model"
import { DelayScrollButton, update } from "./update"
import { DriveViewport, JumpViewportToRow } from "./viewport"

// The viewport's update: the scroll-to-bottom button's delay, the jump
// flash, the minimap's jumps (loaded and not), a spent jump, a chat switch,
// and the rows' asks routed to the page's chat.

function boot(path: string): AppModel {
  const flags: Flags = { sidebarCollapsed: false, systemTheme: "dark", initialAppSettings: null, stores: Stores.load(memoryStorage()) }
  return initApp(flags, Option.getOrThrow(fromString(`http://localhost${path}`))).model
}

const app = boot("/chat/c1")
const run = (model: Model, message: Message) => update(model, message, app)
const names = (result: { commands?: ReadonlyArray<{ name: string }> }) => (result.commands ?? []).map((command) => command.name)
/** Commands by name and args (their Effects aren't comparable). */
const calls = (result: { commands?: ReadonlyArray<{ name: string; args?: unknown }> }) => (result.commands ?? []).map((command) => [command.name, command.args])
const call = (command: { name: string; args?: unknown }) => [command.name, command.args]

/** The ChatSession Message a result asks the page's chat for, by tag. */
function chatMessageTag(result: ReturnType<typeof run>): string | null {
  const action = result.outMessage?.action
  return action?._tag === "Chat" ? action.message._tag : null
}

describe("transcript viewport: the scroll-to-bottom button", () => {
  test("shows 150ms after the reader leaves the end, and goes at once on the way back", () => {
    Story.story(
      run,
      Story.given(init()),
      Story.message(Message.ChangedAtEnd({ isAtEnd: false })),
      Story.model((model) => {
        expect(model.isAtEnd).toBe(false)
        expect(model.showScrollToBottom).toBe(false)
      }),
      Story.Command.resolve(DelayScrollButton, Message.ElapsedScrollButtonDelay({ token: 1 })),
      Story.model((model) => expect(model.showScrollToBottom).toBe(true)),
      Story.message(Message.ChangedAtEnd({ isAtEnd: true })),
      Story.model((model) => expect(model.showScrollToBottom).toBe(false)),
    )
  })

  test("a delay that lapses after the reader came back shows nothing", () => {
    const away = run(init(), Message.ChangedAtEnd({ isAtEnd: false })).model
    const back = run(away, Message.ChangedAtEnd({ isAtEnd: true })).model
    expect(run(back, Message.ElapsedScrollButtonDelay({ token: 1 })).model.showScrollToBottom).toBe(false)
  })

  test("the same report twice starts no second delay", () => {
    const away = run(init(), Message.ChangedAtEnd({ isAtEnd: false })).model
    expect(names(run(away, Message.ChangedAtEnd({ isAtEnd: false })))).toEqual([])
  })

  test("pressing it is at the end at once, and drives the viewport there", () => {
    const shown = { ...init(), isAtEnd: false, showScrollToBottom: true }
    const pressed = run(shown, Message.ClickedScrollToBottom())
    expect(pressed.model.isAtEnd).toBe(true)
    expect(pressed.model.showScrollToBottom).toBe(false)
    expect(calls(pressed)).toEqual([call(DriveViewport({ key: "page:c1", action: "scroll-to-bottom" }))])
  })
})

describe("transcript viewport: jumps", () => {
  test("a jump lights its row a frame later, and puts it out once the flash has played", () => {
    const jumped = run(init(), Message.JumpedToRow({ rowId: "r1" }))
    expect(jumped.model.flash).toEqual({ rowId: "r1", token: 1, raised: false })
    expect(names(jumped)).toEqual(["RaiseTranscriptJumpFlash", "ClearTranscriptJumpFlash"])
    const raised = run(jumped.model, Message.RaisedFlash({ token: 1 })).model
    expect(raised.flash?.raised).toBe(true)
    expect(run(raised, Message.ElapsedFlash({ token: 1 })).model.flash).toBeNull()
  })

  test("a second jump's flash outlives the first one's timer", () => {
    const first = run(init(), Message.JumpedToRow({ rowId: "r1" })).model
    const second = run(first, Message.JumpedToRow({ rowId: "r2" })).model
    const raised = run(second, Message.RaisedFlash({ token: 2 })).model
    expect(run(raised, Message.ElapsedFlash({ token: 1 })).model.flash?.rowId).toBe("r2")
    expect(run(raised, Message.RaisedFlash({ token: 1 })).model.flash).toEqual({ rowId: "r2", token: 2, raised: true })
  })

  test("a spent jump is told to the root, and kept for the server's later answer", () => {
    const spent = run(init(), Message.SpentJump({ requestId: 3, target: "reply" }))
    expect(spent.model.lastJump).toEqual({ requestId: 3, target: "reply" })
    expect(spent.outMessage?.action).toEqual({ _tag: "SpentChatJump", requestId: 3 })
  })

  test("a minimap jump to a loaded turn drives the viewport to its row", () => {
    const hovered = { ...init(), minimap: { height: 600, pointerY: 120, heldTurnId: null, finePointer: true } }
    const selected = run(hovered, Message.SelectedTurn({ turnId: "p1", rowId: "a1", loaded: true }))
    expect(calls(selected)).toEqual([call(JumpViewportToRow({ key: "page:c1", rowId: "a1" }))])
    expect(selected.model.minimap.pointerY).toBeNull()
  })

  test("a minimap jump to a turn before the window loads until it, and waits for its row", () => {
    const selected = run(init(), Message.SelectedTurn({ turnId: "p0", rowId: null, loaded: false }))
    expect(selected.model.unloadedJump).toEqual({ messageId: "p0", seq: 1 })
    expect(chatMessageTag(selected)).toBe("ClickedLoadOlder")
    expect(calls(selected)).toEqual([call(DriveViewport({ key: "page:c1", action: "mark-user-scrolled" }))])
    expect(run(selected.model, Message.AppliedUnloadedJump({ seq: 1 })).model.unloadedJump).toBeNull()
  })
})

describe("transcript viewport: what goes to the page's chat", () => {
  test("Load More takes the first row's place before asking for older messages", () => {
    const pressed = run(init(), Message.ClickedLoadMore())
    expect(calls(pressed)).toEqual([call(DriveViewport({ key: "page:c1", action: "capture-first-row" }))])
    expect(chatMessageTag(pressed)).toBe("ClickedLoadOlder")
  })

  test("a read position goes to the chat with its time", () => {
    const reported = run(init(), Message.ReportedReadAnchor({ messageId: "m1", atEnd: false, layout: { transcriptWidth: 800, offsetFromMessage: 12 }, at: 5 }))
    const action = reported.outMessage?.action
    expect(action?._tag === "Chat" ? action.message : null).toEqual({ _tag: "ReportedReadAnchor", messageId: "m1", atEnd: false, layout: { transcriptWidth: 800, offsetFromMessage: 12 }, at: 5 })
  })

  test("a question's answers and a plan's decision are the chat's tool responses", () => {
    const answered = run(init(), Message.GotMessagesMessage({ message: Messages.Message.SubmittedAnswers({ toolId: "t1", questions: [], answers: { q: ["a"] } }) }))
    expect(chatMessageTag(answered)).toBe("AnsweredQuestion")
    const confirmed = run(init(), Message.GotMessagesMessage({ message: Messages.Message.ConfirmedPlan({ toolId: "t2", confirmed: true }) }))
    const action = confirmed.outMessage?.action
    expect(action?._tag === "Chat" ? action.message : null).toEqual({ _tag: "AnsweredExitPlanMode", toolUseId: "t2", confirmed: true, clearContext: false, message: null })
  })

  test("tool payloads are fetched for the page's chat, and an answer for another chat is dropped", () => {
    const asked = run({ ...init(), chatId: "c1" }, Message.GotMessagesMessage({ message: Messages.Message.WantedPayloads({ entryIds: ["e1"] }) }))
    const flushed = run(asked.model, Message.GotMessagesMessage({ message: Messages.Message.FlushedPayloadRequests() }))
    expect(calls(flushed)).toEqual([["FetchTranscriptToolEntries", { chatId: "c1", entryIds: ["e1"] }]])
    const entry = { _id: "e1", kind: "tool_result", toolId: "t1", content: "ok", createdAt: 1 } as const
    const received = run(flushed.model, Message.ReceivedToolEntries({ chatId: "c1", entryIds: ["e1"], entries: [entry] })).model
    expect(received.messages.payloads.e1).toEqual(entry)
    expect(received.messages.inFlight.e1).toBeUndefined()
    const stale = run({ ...flushed.model, chatId: "c2" }, Message.ReceivedToolEntries({ chatId: "c1", entryIds: ["e1"], entries: [entry] })).model
    expect(stale.messages.payloads.e1).toBeUndefined()
  })
})

describe("transcript viewport: a chat switch", () => {
  test("a viewport mounting drops the rows' state and what was aimed at the last showing", () => {
    const opened = { ...init(), chatId: "c1", messages: { ...Messages.init(), open: { "tool:x": true } }, unloadedJump: { messageId: "p0", seq: 1 }, lastJump: { requestId: 1, target: "prompt" as const } }
    const switched = run(opened, Message.MountedViewport({ chatId: "c2" })).model
    expect(switched.chatId).toBe("c2")
    expect(switched.messages.open).toEqual({})
    expect(switched.unloadedJump).toBeNull()
    expect(switched.lastJump).toBeNull()
    // The same chat shown afresh (the page left and come back to) starts over too, as a remount did.
    expect(run(opened, Message.MountedViewport({ chatId: "c1" })).model.messages.open).toEqual({})
  })

  test("the minimap's cursor goes when the strip's room changes", () => {
    const hovered = { ...init(), viewportWidth: 1157, overflows: true, minimap: { height: 600, pointerY: 100, heldTurnId: "p1", finePointer: true } }
    const narrowed = run(hovered, Message.ResizedViewport({ width: 700 })).model
    expect(narrowed.minimap.pointerY).toBeNull()
    expect(narrowed.minimap.heldTurnId).toBeNull()
    expect(run(hovered, Message.ResizedViewport({ width: 1160 })).model.minimap.pointerY).toBe(100)
  })
})
