import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { Scene } from "foldkit/test"
import { fromString } from "foldkit/url"
import { processTranscriptMessages } from "../../client/lib/parseTranscript"
import type { TranscriptEntry } from "../../shared/types"
import type { Flags, Model as AppModel } from "../app/model"
import * as Stores from "../app/stores"
import { init as initApp } from "../app/update"
import * as ChatSession from "../core/chatSession"
import { memoryStorage } from "../core/stores/testing"
import * as Messages from "./messages"
import { Message } from "./message"
import { init, type Model } from "./model"
import { feedOf, pageSource, rowsOf } from "./source"
import { update } from "./update"
import { transcriptView } from "./view"
import { ControlViewport, DriveViewport } from "./viewport"
import { MeasureMinimap } from "./minimap"

// Scenes for the viewport's own controls around the rows: Load More at the
// top of a window, the processing line at the foot, and what the
// controller is handed (the feed: which row is the latest prompt, where the
// stored position lands).

const ENTRIES: TranscriptEntry[] = [
  { _id: "p1", kind: "user_prompt", content: "Add a feet/meters toggle", createdAt: 1_000 },
  { _id: "a1", kind: "assistant_text", text: "Looking at the card first.", createdAt: 2_000 },
  { _id: "p2", kind: "user_prompt", content: "Now the swell arrow", createdAt: 3_000 },
  { _id: "a2", kind: "assistant_text", text: "On it.", createdAt: 4_000 },
]

function app(options: { startIndex?: number; status?: string } = {}): AppModel {
  const flags: Flags = { sidebarCollapsed: false, systemTheme: "dark", initialAppSettings: null, stores: Stores.load(memoryStorage()) }
  const base = initApp(flags, Option.getOrThrow(fromString("http://localhost/chat/c1"))).model
  const session = ChatSession.init("c1", { windowSize: 50, starting: false }).model
  const snapshot = {
    runtime: { chatId: "c1", projectId: "p1", title: "Units", status: options.status ?? "idle", localPath: "/work/tidepool" },
    messages: ENTRIES,
    queuedMessages: [],
    startIndex: options.startIndex ?? 0,
  }
  return {
    ...base,
    chat: {
      ...session,
      snapshot: snapshot as never,
      chatReady: true,
      messages: processTranscriptMessages(ENTRIES),
      readAnchor: { ...session.readAnchor, latch: { chatId: "c1", anchor: null, source: "server" } },
    },
  }
}

/** The two prompts' clamps report they fit (ClampMeasure, the rows' own Mount). */
const promptsMeasured = ["p1", "p2"].map((id) =>
  Scene.Mount.resolve({ name: "ClampMeasure" } as never, Messages.Message.MeasuredClamp({ key: `clamp:${id}:0`, overflows: false })))

const sceneOf = (root: AppModel) => ({
  update: (model: Model, message: Message) => update(model, message, root),
  view: (model: Model, h: HtmlBuilder<Message>) => h.main([], [transcriptView(model, pageSource(root, undefined, model), {}, h)]),
})

describe("transcript viewport", () => {
  test("Scene: the rows in a labelled log, Load More over a window, and the press asks the chat for older messages", () => {
    const root = app({ startIndex: 4 })
    Scene.scene(
      sceneOf(root),
      Scene.given(init()),
      Scene.Mount.resolve(ControlViewport, Message.MountedViewport({ chatId: "c1" })),
      Scene.Mount.resolve(MeasureMinimap, Message.MeasuredMinimap({ height: 600 })),
      ...promptsMeasured,
      Scene.expect(Scene.role("region", { name: "Messages" })).toExist(),
      Scene.expect(Scene.role("log")).toExist(),
      Scene.expect(Scene.text("Now the swell arrow")).toExist(),
      Scene.click(Scene.role("button", { name: "Load More" })),
      Scene.Command.resolve(DriveViewport, Message.CompletedViewportCommand()),
    )
  })

  test("Scene: a running turn draws the processing line at the foot; no Load More at the start of the chat", () => {
    const root = app({ status: "running" })
    Scene.scene(
      sceneOf(root),
      Scene.given(init()),
      Scene.Mount.resolve(ControlViewport, Message.MountedViewport({ chatId: "c1" })),
      Scene.Mount.resolve(MeasureMinimap, Message.MeasuredMinimap({ height: 600 })),
      ...promptsMeasured,
      Scene.expect(Scene.role("button", { name: "Load More" })).toBeAbsent(),
      Scene.expect(Scene.selector("[data-transcript-row-id='p2']")).toExist(),
    )
  })

  test("the feed names the latest prompt and lands an open on it when nothing is stored", () => {
    const root = app()
    const source = pageSource(root, undefined, init())
    const feed = feedOf(source, rowsOf(source), init())
    expect(feed.chatId).toBe("c1")
    expect(feed.prompt?.rowId).toBe("p2")
    expect(feed.reply).toBe("a2")
    expect(feed.restore).toEqual({ kind: "pin", rowId: "p2" })
    expect(feed.readAnchor).toEqual({ resolved: true, confirmed: true })
  })

  test("a stored position lands on its row, with its offset and the width it was taken at", () => {
    const root = app()
    const chat = root.chat!
    const anchored = {
      ...root,
      chat: { ...chat, readAnchor: { ...chat.readAnchor, latch: { chatId: "c1", anchor: { messageId: "a1", atEnd: false, offsetFromMessage: 40, transcriptWidth: 800 }, source: "server" as const } } },
    }
    const source = pageSource(anchored, undefined, init())
    expect(feedOf(source, rowsOf(source), init()).restore).toEqual({ kind: "pin", rowId: "a1", offsetFromMessage: 40, transcriptWidth: 800 })
    const atEnd = { ...anchored, chat: { ...chat, readAnchor: { ...chat.readAnchor, latch: { chatId: "c1", anchor: { messageId: "a1", atEnd: true }, source: "server" as const } } } }
    const endSource = pageSource(atEnd, undefined, init())
    expect(feedOf(endSource, rowsOf(endSource), init()).restore).toEqual({ kind: "end" })
  })
})
