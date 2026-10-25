import { describe, expect, test } from "bun:test"
import { Story } from "foldkit/test"
import * as RightSidebar from "./rightSidebar"
import { persistedChatViewers, persistedRightSidebarState } from "./rightSidebar"
import { run } from "./testing"
import {
  chatViewer,
  initialModel,
  JumpInPreviewedChat,
  Message,
  reviewedPath,
  update,
  type State,
  type ViewerItem,
} from "./viewer"

const FILE = { kind: "file", projectId: "p1", path: "README.md" } as const
const DIFF = { kind: "diff", projectId: "p1", path: "src/a.ts" } as const
const CHAT = { kind: "chat", chatId: "sub-1" } as const
const VISUALIZATION = { kind: "visualization", artifact: { type: "visualization", version: 1, title: "Signups", height: 360, url: "/api/chats/chat-1/media/visualization-abc.html" } } as const
const IMAGE = { kind: "attachment", attachment: { url: "/media/a.png", name: "a.png", mimeType: "image/png", size: 1 } } as const

const opened = (item: ViewerItem, expanded = false) => Message.OpenedItem({ item, expanded, byKey: false })
const close = Message.ClosedViewer({ byKey: false })
const closeAll = Message.ClosedAllViewer()
const shut = Message.ShutViewer({ byKey: false })
const stepBack = Message.SteppedBack({ byKey: false })
const toggleExpanded = Message.ToggledExpanded()
const setChat = (chatId: string | null) => Message.ChangedChat({ chatId })

/** On chat-1, nothing open anywhere. */
const START: State = run(update, { viewer: initialModel, rightSidebar: RightSidebar.initialModel }, setChat("chat-1"))

const go = (state: State, ...messages: Message[]) => run(update, state, ...messages)

describe("viewer", () => {
  test("opening writes the chat's viewer into the right sidebar, which saves it", () => {
    const rightSidebar = { ...RightSidebar.initialModel, chatViewers: { "chat-1": { item: FILE, expanded: false } } }
    Story.story(
      update,
      Story.given(START),
      Story.message(opened(FILE)),
      Story.Command.expectExact(RightSidebar.Save({ state: rightSidebar })),
      Story.Command.resolve(RightSidebar.Save, RightSidebar.Message.CompletedSave()),
      Story.model((state) => {
        expect(state.rightSidebar).toEqual(rightSidebar)
        expect(state.viewer.openCount).toBe(1)
      }),
    )
  })

  test("each chat keeps its own viewer and expanded state", () => {
    let state = go(START, opened(FILE), toggleExpanded, setChat("chat-2"))
    expect(chatViewer(state)).toBeNull()

    state = go(state, setChat("chat-1"))
    expect(chatViewer(state)).toEqual({ item: FILE, expanded: true })
  })

  test("a width dragged in one chat is the width in every chat, and stays when the pane is shut", () => {
    let state = go(START, opened(FILE), Message.ChangedWidth({ widthPx: 700 }), setChat("chat-2"), opened(DIFF))
    expect(state.rightSidebar.viewerWidthPx).toBe(700)
    state = go(state, Message.ChangedWidth({ widthPx: 560 }), close, setChat("chat-1"))
    expect(state.rightSidebar.viewerWidthPx).toBe(560)
    expect(chatViewer(state)).toEqual({ item: FILE, expanded: false })
  })

  test("the width is kept across a reload, with the viewers", () => {
    const state = go(START, Message.ChangedWidth({ widthPx: 640 }))
    expect(persistedRightSidebarState(state.rightSidebar)).toMatchObject({ viewerWidthPx: 640 })
  })

  test("a review left for another chat reopens at the file it was scrolled to", () => {
    let state = go(START, opened(DIFF), Message.ScrolledDiffPath({ path: "src/b.ts" }))
    expect(chatViewer(state)?.item).toEqual(DIFF)
    expect(reviewedPath(state, "p1")).toBe("src/b.ts")
    expect(reviewedPath(state, "p2")).toBeNull()

    state = go(state, setChat("chat-2"), setChat("chat-1"))
    expect(chatViewer(state)?.item).toEqual({ ...DIFF, path: "src/b.ts" })
  })

  test("closing clears only this chat's viewer", () => {
    let state = go(START, opened(FILE), setChat("chat-2"), opened(DIFF), close)
    expect(chatViewer(state)).toBeNull()
    state = go(state, setChat("chat-1"))
    expect(chatViewer(state)?.item).toEqual(FILE)
  })

  test("keeps across a reload what can come back, a review at its scrolled file", () => {
    expect(persistedChatViewers({
      "chat-1": { item: DIFF, expanded: false, reviewPath: "src/b.ts" },
      "chat-2": { item: { kind: "chart", payload: { title: "x", type: "bar", data: [] } }, expanded: false },
      "chat-3": { item: { kind: "attachment", attachment: { url: "blob:abc", name: "a.png", mimeType: "image/png", size: 1 } }, expanded: false },
      "": { item: FILE, expanded: false },
      "chat-4": { item: FILE, expanded: true },
    })).toEqual({
      "chat-1": { item: { ...DIFF, path: "src/b.ts" }, expanded: false },
      "chat-4": { item: FILE, expanded: true },
    })
  })

  test("a chat opened over a file arrives in the pane as it stands", () => {
    expect(chatViewer(go(START, opened(FILE), opened(CHAT)))).toEqual({ item: CHAT, expanded: false })
  })

  test("closing what opened over a chat preview goes back to the chat", () => {
    let state = go(START, opened(CHAT), opened(IMAGE), opened(FILE))
    expect(chatViewer(state)?.item).toEqual(FILE)

    state = go(state, close)
    expect(chatViewer(state)).toEqual({ item: CHAT, expanded: false })
    state = go(state, close)
    expect(chatViewer(state)).toBeNull()
  })

  test("another chat replaces a preview outright, and closeAll shuts the pane", () => {
    let state = go(START, opened(CHAT), opened({ kind: "chat", chatId: "sub-2" }), close)
    expect(chatViewer(state)).toBeNull()

    state = go(state, opened(CHAT), opened(IMAGE), closeAll)
    expect(chatViewer(state)).toBeNull()
  })

  test("a chat preview comes back after a reload, also from under a chart", () => {
    expect(persistedChatViewers({
      "chat-1": { item: { kind: "chat", chatId: "sub-2", back: ["sub-1"] }, expanded: false },
      "chat-2": {
        item: { kind: "chart", payload: { title: "x", type: "bar", data: [] } },
        expanded: true,
        returnTo: { item: CHAT },
      },
    })).toEqual({
      "chat-1": { item: { kind: "chat", chatId: "sub-2", back: ["sub-1"] }, expanded: false },
      "chat-2": { item: CHAT, expanded: true },
    })
  })

  test("a visualization opens expanded and gives the pane back as it was", () => {
    // From a closed pane: expanded, and closing leaves nothing behind.
    let state = go(START, opened(VISUALIZATION, true))
    expect(chatViewer(state)).toEqual({ item: VISUALIZATION, expanded: true, expandedBefore: false })
    state = go(state, close, opened(FILE))
    expect(chatViewer(state)).toEqual({ item: FILE, expanded: false })
    state = go(state, closeAll)

    // Over a docked chat preview: closing goes back to the chat, docked.
    state = go(state, opened(CHAT), opened(VISUALIZATION, true))
    expect(chatViewer(state)?.expanded).toBe(true)
    state = go(state, close)
    expect(chatViewer(state)).toEqual({ item: CHAT, expanded: false })

    // Something else opened in its place is not left over the chat either.
    state = go(state, opened(VISUALIZATION, true), opened(IMAGE))
    expect(chatViewer(state)).toMatchObject({ item: IMAGE, expanded: false })
  })

  test("collapsing or expanding a visualization yourself is the pane's setting from then on", () => {
    let state = go(START, opened(CHAT), opened(VISUALIZATION, true), toggleExpanded)
    expect(chatViewer(state)).toMatchObject({ item: VISUALIZATION, expanded: false })
    expect(chatViewer(state)).not.toHaveProperty("expandedBefore")
    state = go(state, toggleExpanded, close)
    expect(chatViewer(state)).toMatchObject({ item: CHAT, expanded: true })
  })

  test("a pane already expanded stays so under a visualization, and it survives a reload", () => {
    const state = go(START, opened(FILE), toggleExpanded, opened(VISUALIZATION, true))
    expect(chatViewer(state)).toEqual({ item: VISUALIZATION, expanded: true })
    expect(persistedChatViewers({ "chat-1": { item: VISUALIZATION, expanded: true, expandedBefore: false } }))
      .toEqual({ "chat-1": { item: VISUALIZATION, expanded: true, expandedBefore: false } })
    // A chart does not come back, and the chat under it comes back docked.
    expect(persistedChatViewers({
      "chat-1": { item: { kind: "chart", payload: { title: "x", type: "bar", data: [] } }, expanded: true, expandedBefore: false, returnTo: { item: CHAT } },
    })).toEqual({ "chat-1": { item: CHAT, expanded: false } })
  })

  test("a jump for the previewed chat is one-shot and dropped with the page's chat", () => {
    Story.story(
      update,
      Story.given(START),
      // What `setChatJump` did: a fresh request id, stamped by a Command.
      Story.message(Message.ChangedChatJump({ chatId: "sub-1", target: "reply", requestId: "r1" })),
      Story.Command.expectNone(),
    )
    expect(JumpInPreviewedChat({ chatId: "sub-1", target: "reply" }).name).toBe("JumpInPreviewedChat")

    let state = go(START, Message.ChangedChatJump({ chatId: "sub-1", target: "reply", requestId: "r1" }))
    const jump = state.viewer.chatJump
    expect(jump).toMatchObject({ chatId: "sub-1", target: "reply" })
    state = go(state, Message.SpentChatJump({ requestId: "another-request" }))
    expect(state.viewer.chatJump).toBe(jump)
    state = go(state, Message.SpentChatJump({ requestId: "r1" }))
    expect(state.viewer.chatJump).toBeNull()

    state = go(state, Message.ChangedChatJump({ chatId: "sub-1", target: "prompt", requestId: "r2" }), setChat("chat-2"))
    expect(state.viewer.chatJump).toBeNull()
  })

  test("a change from the keyboard is marked as one", () => {
    expect(go(START, Message.OpenedItem({ item: FILE, expanded: false, byKey: true })).viewer.changedByKey).toBe(true)
    expect(go(START, opened(FILE), Message.ShutViewer({ byKey: true })).viewer.changedByKey).toBe(true)
    expect(go(START, Message.OpenedItem({ item: FILE, expanded: false, byKey: true }), opened(DIFF)).viewer.changedByKey).toBe(false)
  })

  test("previewers and the live chat are counted while mounted", () => {
    let state = go(START, Message.MountedChatPreviewHost(), Message.MountedChatPreviewHost(), Message.UnmountedChatPreviewHost())
    expect(state.viewer.chatPreviewHosts).toBe(1)
    state = go(state, Message.UnmountedChatPreviewHost(), Message.UnmountedChatPreviewHost())
    expect(state.viewer.chatPreviewHosts).toBe(0)

    state = go(state, Message.HeldLiveChat({ chatId: "a" }), Message.HeldLiveChat({ chatId: "b" }), Message.ReleasedLiveChat({ chatId: "a" }))
    expect(state.viewer.liveChatId).toBe("b")
    state = go(state, Message.ReleasedLiveChat({ chatId: "b" }))
    expect(state.viewer.liveChatId).toBeNull()
  })

  describe("on a delegator, whose pane has a floor", () => {
    const LIST = { kind: "delegated", chatId: "chat-1" } as const
    const openOnList = Message.ChangedFloor({ floor: LIST, openByDefault: true })
    const setFloor = Message.ChangedFloor({ floor: LIST, openByDefault: false })

    test("the list is put in an empty pane only when asked to open by default", () => {
      let state = go(START, setFloor)
      expect(chatViewer(state)).toBeNull()

      state = go(state, openOnList)
      expect(chatViewer(state)).toEqual({ item: LIST, expanded: false })
    })

    test("a pane already showing something is left alone", () => {
      expect(chatViewer(go(START, opened(FILE), openOnList))?.item).toEqual(FILE)
    })

    test("Escape steps down one level at a time: to the list, then shut", () => {
      let state = go(START, openOnList, opened(CHAT), opened({ kind: "chat", chatId: "sub-2", back: ["sub-1"] }), opened(IMAGE))

      state = go(state, close)
      expect(chatViewer(state)?.item).toEqual({ kind: "chat", chatId: "sub-2", back: ["sub-1"] })
      state = go(state, close)
      expect(chatViewer(state)?.item).toEqual(CHAT)
      state = go(state, close)
      expect(chatViewer(state)?.item).toEqual(LIST)
      state = go(state, close)
      expect(chatViewer(state)).toBeNull()
    })

    test("the Close button shuts the pane from any level", () => {
      expect(chatViewer(go(START, openOnList, opened(CHAT), opened(IMAGE), shut))).toBeNull()
    })

    test("something opened while the pane is shut still has the list under it", () => {
      expect(chatViewer(go(START, setFloor, opened(CHAT), stepBack))?.item).toEqual(LIST)
    })

    test("a shut pane stays shut when the page sets its floor again", () => {
      expect(chatViewer(go(START, openOnList, shut, setFloor))).toBeNull()
    })

    test("a file opened over the list goes back to the list", () => {
      expect(chatViewer(go(START, openOnList, opened(FILE), close))).toEqual({ item: LIST, expanded: false })
    })

    test("a chat picked from the list goes back to it", () => {
      expect(chatViewer(go(START, openOnList, opened({ kind: "chat", chatId: "sub-1", delegated: "chat-1" }), stepBack)))
        .toEqual({ item: LIST, expanded: false })
    })

    test("content that is gone leaves the list, not a shut pane", () => {
      expect(chatViewer(go(START, openOnList, opened(CHAT), opened(IMAGE), closeAll))?.item).toEqual(LIST)
    })

    test("taking the floor away shuts a pane that held only it, and leaves anything else", () => {
      const noFloor = Message.ChangedFloor({ floor: null, openByDefault: false })
      expect(chatViewer(go(START, openOnList, noFloor))).toBeNull()

      let state = go(START, openOnList, opened(CHAT), noFloor)
      expect(chatViewer(state)?.item).toEqual(CHAT)
      // And with no floor, close shuts the pane.
      state = go(state, close)
      expect(chatViewer(state)).toBeNull()
    })
  })

  describe("stepping back with no floor", () => {
    test("goes back along a chat's trail and then shuts the pane", () => {
      let state = go(START, opened({ kind: "chat", chatId: "sub-2", back: ["sub-1"] }), stepBack)
      expect(chatViewer(state)?.item).toEqual(CHAT)
      state = go(state, stepBack)
      expect(chatViewer(state)).toBeNull()
    })

    test("a chat picked from a delegator's list on a phone goes back to the list, which closes", () => {
      let state = go(START, opened({ kind: "delegated", chatId: "chat-1" }), opened({ kind: "chat", chatId: "sub-1", delegated: "chat-1" }), stepBack)
      expect(chatViewer(state)?.item).toEqual({ kind: "delegated", chatId: "chat-1" })
      state = go(state, close)
      expect(chatViewer(state)).toBeNull()
    })
  })
})
