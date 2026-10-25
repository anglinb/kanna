import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Story } from "foldkit/test"
import { fromString } from "foldkit/url"
import type { AppAction } from "../app/action"
import type { Flags, Model as AppModel } from "../app/model"
import * as Stores from "../app/stores"
import { init as initApp } from "../app/update"
import * as OpenDestination from "../core/stores/openDestination"
import { memoryStorage } from "../core/stores/testing"
import * as ViewerStore from "../core/stores/viewer"
import type { ChatDiffSnapshot } from "../../shared/types"
import * as TranscriptMessageModule from "../transcript/message"
import * as Messages from "../transcript/messages"
import { ClearReviewState, ReadPatch } from "./diff"
import { Message } from "./message"
import { init, type Model } from "./model"
import { update } from "./update"

// The viewer's update: what its card asks of the stores (close, shut, back,
// expand), the review's patches and jumps, a view toggle's panes, the
// table's sort, "Open in…" for a file, and the previewer's session.

const FILES: ChatDiffSnapshot["files"] = [
  { path: "src/lib/units.ts", changeType: "modified", additions: 4, deletions: 1, patchDigest: "d-units", isUntracked: false } as never,
  { path: "src/App.tsx", changeType: "modified", additions: 2, deletions: 2, patchDigest: "d-app", isUntracked: false } as never,
  { path: "README.md", changeType: "added", additions: 10, deletions: 0, patchDigest: "d-readme", isUntracked: true } as never,
]

function boot(): AppModel {
  const flags: Flags = { sidebarCollapsed: false, systemTheme: "dark", initialAppSettings: null, stores: Stores.load(memoryStorage()) }
  return initApp(flags, Option.getOrThrow(fromString("http://localhost/chat/c1"))).model
}

/** The root with the page's viewer on `item`, and the project's changed files. */
function withViewer(item: ViewerStore.ViewerItem | null, floor: ViewerStore.ViewerFloor | null = null): AppModel {
  const base = boot()
  let stores = Stores.update(base.stores, Stores.Message.GotViewerMessage({ message: ViewerStore.Message.ChangedChat({ chatId: "c1" }) })).model
  if (floor) stores = Stores.update(stores, Stores.Message.GotViewerMessage({ message: ViewerStore.Message.ChangedFloor({ floor, openByDefault: false }) })).model
  if (item) stores = Stores.update(stores, Stores.Message.GotViewerMessage({ message: ViewerStore.Message.OpenedItem({ item, expanded: false, byKey: false }) })).model
  return { ...base, stores, projectDiffs: { p1: { status: "ready", files: FILES } as never } }
}

const review = withViewer({ kind: "diff", projectId: "p1", path: "src/lib/units.ts" })

function viewerMessages(action: AppAction | undefined): string[] {
  if (!action) return []
  if (action._tag === "Batch") return (action.actions as AppAction[]).flatMap(viewerMessages)
  if (action._tag === "Store" && action.message._tag === "GotViewerMessage") return [action.message.message._tag]
  return []
}

const names = (result: { commands?: ReadonlyArray<{ name: string }> }) => (result.commands ?? []).map((command) => command.name)

describe("viewer: the card's controls", () => {
  test("Escape steps back as a key; Close as a click", () => {
    const app = withViewer({ kind: "chart", payload: { title: "Swell", type: "bar", data: [] } as never })
    const escaped = update(init(), Message.PressedEscape(), app)
    expect(escaped.outMessage?.action).toEqual(expect.objectContaining({ _tag: "Store" }))
    const pressed = escaped.outMessage!.action
    expect(pressed._tag === "Store" && pressed.message._tag === "GotViewerMessage" ? pressed.message.message : null)
      .toEqual(ViewerStore.Message.ClosedViewer({ byKey: true }))
    expect(viewerMessages(update(init(), Message.ClickedClose(), app).outMessage?.action)).toEqual(["ClosedViewer"])
    expect(viewerMessages(update(init(), Message.ClickedShut(), app).outMessage?.action)).toEqual(["ShutViewer"])
    expect(viewerMessages(update(init(), Message.ClickedBack(), app).outMessage?.action)).toEqual(["SteppedBack"])
    expect(viewerMessages(update(init(), Message.ClickedToggleExpanded(), app).outMessage?.action)).toEqual(["ToggledExpanded"])
  })

  test("a new card starts over: its toggles, its reads and the review it replaced are gone", () => {
    const opened = { ...init(), card: { key: "attachment", cardEnters: true, bodyEnters: false }, toggles: { attachment: "original" } }
    const next = update(opened, Message.MountedCard({ key: "chart", cardEnters: false, bodyEnters: true }), review).model
    expect(next.card).toEqual({ key: "chart", cardEnters: false, bodyEnters: true })
    expect(next.toggles).toEqual({})
  })

  test("a toggle keeps the view it left mounted (ViewerPanes)", () => {
    const chosen = update(init(), Message.ChoseView({ cardKey: "attachment", value: "original", previous: "rendered" }), review).model
    expect(chosen.toggles.attachment).toBe("original")
    expect([...(chosen.panes.attachment ?? [])].sort()).toEqual(["original", "rendered"])
  })

  test("a table header sorts ascending, descending, then back to the file's order", () => {
    const click = (model: Model) => update(model, Message.ClickedSortColumn({ slot: "s", column: 2 }), review).model
    const once = click(init())
    expect(once.tables.s?.sort).toEqual({ column: 2, direction: "asc" })
    const twice = click(once)
    expect(twice.tables.s?.sort).toEqual({ column: 2, direction: "desc" })
    expect(click(twice).tables.s?.sort).toBeNull()
  })
})

describe("viewer: the review", () => {
  const mounted = () => {
    const card = { ...init(), card: { key: "diff", cardEnters: false, bodyEnters: false } }
    return update(card, Message.MountedReview({ projectId: "p1", path: "src/lib/units.ts", openCount: 1, restore: null }), review).model
  }

  test("opens on the file it was opened at, in tree order (folders first: src/lib/units.ts, src/App.tsx, README.md)", () => {
    expect(mounted().diff?.activeIndex).toBe(0)
    expect(mounted().diff?.jump).toEqual({ path: "src/lib/units.ts", seq: 1 })
  })

  test("reads each file it needs once, and keeps what comes back for the digest it asked about", () => {
    Story.story(
      (model: Model, message: Message) => update(model, message, review),
      Story.given(mounted()),
      Story.message(Message.NeededPatches({ loads: [{ path: "src/App.tsx", full: false, digest: "d-app" }] })),
      Story.Command.expectHas(ReadPatch),
      Story.Command.resolve(ReadPatch, Message.ReceivedPatch({ key: "src/App.tsx", digest: "d-app", patch: "@@ -1 +1 @@" })),
      Story.model((model) => expect(model.diff?.patches["src/App.tsx"]).toEqual({ digest: "d-app", patch: "@@ -1 +1 @@", loading: false })),
    )
    const loading = update(mounted(), Message.NeededPatches({ loads: [{ path: "src/App.tsx", full: false, digest: "d-app" }] }), review).model
    // Already on its way: no second read.
    expect(names(update(loading, Message.NeededPatches({ loads: [{ path: "src/App.tsx", full: false, digest: "d-app" }] }), review))).toEqual([])
    // An answer about an older digest is dropped.
    const stale = update(loading, Message.ReceivedPatch({ key: "src/App.tsx", digest: "d-old", patch: "x" }), review).model
    expect(stale.diff?.patches["src/App.tsx"]?.loading).toBe(true)
  })

  test("j steps to the next file: a jump, which lands and lights the Changes card's row", () => {
    const atFirst = { ...mounted(), diff: { ...mounted().diff!, activeIndex: 0, jump: null } }
    const stepped = update(atFirst, Message.PressedNavigationKey({ direction: "next" }), review).model
    expect(stepped.diff?.jump).toEqual({ path: "src/App.tsx", seq: 2 })
    const landed = update(stepped, Message.LandedJump({ seq: 2, index: 1, path: "src/App.tsx", offset: 0 }), review)
    expect(landed.model.diff?.activeIndex).toBe(1)
    expect(landed.model.diff?.jump).toBeNull()
    expect(viewerMessages(landed.outMessage?.action)).toEqual(["ScrolledDiffPath"])
  })

  test("closing the review is done with it: the spot it saved for a reload goes", () => {
    const closed = update(mounted(), Message.RenderedPane({ state: "closed", shownKey: null, chatKey: "c1", viewer: null }), withViewer(null))
    expect(closed.model.diff).toBeNull()
    expect(names(closed)).toContain(ClearReviewState.name)
  })
})

describe("viewer: Open in… for a file", () => {
  test("remembers the choice for files and opens the file there, past the page's rule for file links", () => {
    const app = withViewer({ kind: "file", projectId: "p1", path: "src/App.tsx" })
    const result = update(init(), Message.ChoseOpenDestination({ path: "src/App.tsx", line: 4, value: "editor:cursor" }), app)
    const action = result.outMessage?.action
    expect(action?._tag).toBe("Batch")
    const actions = action?._tag === "Batch" ? action.actions as AppAction[] : []
    expect(actions[0]).toEqual(expect.objectContaining({
      _tag: "Store",
      message: Stores.Message.GotOpenDestinationMessage({ message: OpenDestination.Message.ChoseFileDestination({ value: "editor:cursor" }) }),
    }))
    // Batched, so chat/update's routeLocalLink leaves it alone.
    const open = actions[1]
    expect(open?._tag).toBe("Batch")
    const inner = open?._tag === "Batch" ? (open.actions as AppAction[])[0] : undefined
    expect(inner?._tag).toBe("OpenLocalLink")
    expect(inner?._tag === "OpenLocalLink" ? inner.target.line : null).toBe(4)
  })
})

describe("viewer: the chat previewer", () => {
  const app = withViewer({ kind: "chat", chatId: "c2" })

  test("a previewed chat starts a session of its own, and holds it live", () => {
    const opened = update({ ...init(), card: { key: "chat", cardEnters: true, bodyEnters: false } }, Message.MountedPreviewSession({ chatId: "c2", fadesIn: true }), app)
    expect(opened.model.preview?.chatId).toBe("c2")
    expect(names(opened)).toEqual(["LoadChatCache"])
    expect(viewerMessages(opened.outMessage?.action)).toEqual(["HeldLiveChat"])
  })

  test("its transcript asks its own session, not the page's", () => {
    const opened = update({ ...init(), card: { key: "chat", cardEnters: true, bodyEnters: false } }, Message.MountedPreviewSession({ chatId: "c2", fadesIn: true }), app).model
    const older = update(opened, Message.GotPreviewTranscriptMessage({ chatId: "c2", message: TranscriptMessageModule.Message.RequestedLoadOlder() }), app)
    // Nothing went to the root's chat: the request was this session's, and it is loading.
    expect(older.outMessage).toBeUndefined()
    expect(older.model.preview?.session.isLoadingOlder).toBe(true)
  })

  test("a chat link inside it opens as a click in the previewer, leaving a way back", () => {
    const opened = update({ ...init(), card: { key: "chat", cardEnters: true, bodyEnters: false } }, Message.MountedPreviewSession({ chatId: "c2", fadesIn: true }), app).model
    const linked = update(opened, Message.GotPreviewTranscriptMessage({ chatId: "c2", message: TranscriptMessageModule.Message.GotMessagesMessage({ message: Messages.Message.ClickedChatLink({ chatId: "c3" }) }) }), {
      ...app,
      stores: Stores.update(app.stores, Stores.Message.GotViewerMessage({ message: ViewerStore.Message.MountedChatPreviewHost() })).model,
    })
    const action = linked.outMessage?.action
    const opener = action?._tag === "Store" && action.message._tag === "GotViewerMessage" ? action.message.message : null
    expect(opener?._tag).toBe("OpenedItem")
    expect(opener?._tag === "OpenedItem" ? opener.item : null).toEqual({ kind: "chat", chatId: "c3", back: ["c2"] })
  })

  test("a session's message for a chat it has moved on from is dropped", () => {
    const opened = update({ ...init(), card: { key: "chat", cardEnters: true, bodyEnters: false } }, Message.MountedPreviewSession({ chatId: "c2", fadesIn: true }), app).model
    const stale = update(opened, Message.ResizedPreviewDock({ chatId: "c9", height: 80 }), app)
    expect(stale.model.preview?.dockHeight).toBe(0)
  })
})
