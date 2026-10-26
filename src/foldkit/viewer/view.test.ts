import { describe, test } from "bun:test"
import { Option } from "effect"
import type { HtmlBuilder } from "foldkit/html"
import { Scene } from "foldkit/test"
import { fromString } from "foldkit/url"
import type { Flags, Model as AppModel } from "../app/model"
import * as Stores from "../app/stores"
import { init as initApp } from "../app/update"
import { memoryStorage } from "../core/stores/testing"
import * as ViewerStore from "../core/stores/viewer"
import { Message } from "./message"
import { init, type Model } from "./model"
import { ViewerSurfaceMount } from "./surface"
import { update } from "./update"
import { layerView, ReportPane } from "./view"

// Scenes for the layer: a card in its frame (named region, title, subtitle,
// its controls, Close), and nothing at all while nothing is open.

function app(item: ViewerStore.ViewerItem | null): AppModel {
  const flags: Flags = { sidebarCollapsed: false, systemTheme: "dark", initialAppSettings: null, stores: Stores.load(memoryStorage()) }
  const base = initApp(flags, Option.getOrThrow(fromString("http://localhost/chat/c1"))).model
  let stores = Stores.update(base.stores, Stores.Message.GotViewerMessage({ message: ViewerStore.Message.ChangedChat({ chatId: "c1" }) })).model
  if (item) stores = Stores.update(stores, Stores.Message.GotViewerMessage({ message: ViewerStore.Message.OpenedItem({ item, expanded: false, byKey: false }) })).model
  return { ...base, stores }
}

const sceneOf = (root: AppModel) => ({
  update: (model: Model, message: Message) => update(model, message, root),
  view: (model: Model, h: HtmlBuilder<Message>) => h.main([], [layerView(model, { app: root, className: "fixed" }, h)]),
})

const IMAGE = { url: "/shot.png", name: "shot.png", mimeType: "image/png", size: 2048 }

describe("viewer layer", () => {
  test("Scene: an image in the card, named for what it previews, with its controls and Close", () => {
    Scene.scene(
      sceneOf(app({ kind: "attachment", attachment: IMAGE })),
      Scene.given(init()),
      Scene.Mount.resolve(ViewerSurfaceMount, Message.MountedCard({ key: "attachment", cardEnters: true, bodyEnters: false })),
      Scene.Mount.resolve(ReportPane, Message.RenderedPane({ state: "expanded", shownKey: "x", chatKey: "c1", viewer: null })),
      Scene.expect(Scene.role("region", { name: "Preview shot.png" })).toExist(),
      Scene.expect(Scene.text("image/png · 2 KB")).toExist(),
      Scene.expect(Scene.role("img", { name: "shot.png" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Copy link" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Open in new tab" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Close (Esc)" })).toExist(),
      // No pane on a page without one: no Expand.
      Scene.expect(Scene.role("button", { name: "Expand" })).not.toExist(),
    )
  })

  test("Scene: nothing open, no card", () => {
    Scene.scene(
      sceneOf(app(null)),
      Scene.given(init()),
      Scene.Mount.resolve(ReportPane, Message.RenderedPane({ state: "closed", shownKey: null, chatKey: "c1", viewer: null })),
      Scene.expect(Scene.role("region")).not.toExist(),
    )
  })
})
