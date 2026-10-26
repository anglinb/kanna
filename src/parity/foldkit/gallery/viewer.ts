// src/foldkit/viewer against the React ViewerLayer (gallery/viewer.tsx), as a
// page without a chat shows it, opened on the item `?item=` names
// (parity/gallery-support/viewer-items.ts). The viewer runs standalone
// (viewer/standalone.ts), as the export viewer runs it: the page holds the
// stores it reads and applies the store changes it asks for.
import type { Document, HtmlBuilder } from "foldkit/html"
import * as ViewerStore from "../../../foldkit/core/stores/viewer"
import * as Standalone from "../../../foldkit/viewer/standalone"
import { VIEWER_GALLERY_CHAT_ID, viewerGalleryItem } from "../../gallery-support/viewer-items"
import { galleryPage } from "../gallery-page"

export default galleryPage<Standalone.Model, Standalone.Message>({
  Model: Standalone.Model,
  init: () => ({
    model: Standalone.open(Standalone.init(VIEWER_GALLERY_CHAT_ID), viewerGalleryItem(window.location.search) as ViewerStore.ViewerItem),
  }),
  update: (model, message) => Standalone.update(model, message),
  view: (model, h: HtmlBuilder<Standalone.Message>): Document => ({
    title: "Kanna",
    body: h.div([h.Class("relative h-full bg-background")], [
      h.submodel({ slotId: "viewer", model, view: Standalone.view, viewInputs: {}, toParentMessage: (message: Standalone.Message) => message }),
    ]),
  }),
  subscriptions: Standalone.subscriptions as never,
})
