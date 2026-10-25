// src/foldkit/ui/project-icon.ts against the React <ProjectIcon> (gallery/ui-project-icon.tsx).
import { Schema } from "effect"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { projectIcon } from "../../../foldkit/ui/project-icon"
import { PROJECT_NAMES } from "../../react/gallery/support/project-names"
import { galleryPage } from "../gallery-page"

const Model = Schema.Struct({ failedIconUrls: Schema.Array(Schema.String) })
type Model = typeof Model.Type
const Message = defineMessageUnion({ FailedLoadIcon: { url: Schema.String } })
type Message = typeof Message.Type

export default galleryPage<Model, Message>({
  Model,
  init: () => ({ model: { failedIconUrls: [] } }),
  update: (model, message) =>
    Message.match(message, {
      FailedLoadIcon: ({ url }) => ({ model: { failedIconUrls: [...model.failedIconUrls, url] } }),
    }),
  view: (model, h: HtmlBuilder<Message>): Document => {
    const icon = (name: string, iconUrl?: string, className?: string) =>
      projectIcon({
        name,
        iconUrl,
        class: className,
        failedIconUrls: model.failedIconUrls,
        onIconError: (url) => Message.FailedLoadIcon({ url }),
      }, h)
    return {
      title: "Kanna",
      body: h.div([h.Class("flex flex-col gap-3 bg-background p-4 text-foreground")], [
        ...PROJECT_NAMES.map((name) => h.keyed("div")(name, [h.Class("flex items-center gap-2 text-sm")], [icon(name), h.span([], [name])])),
        h.div([h.Class("flex items-center gap-2 text-sm")], [icon("kanna", "/favicon.png"), h.span([], ["With an icon"])]),
        h.div([h.Class("flex items-center gap-2 text-sm")], [
          icon("broken-icon", "/no-such-icon.png", "opacity-50"),
          h.span([], ["Icon that fails to load"]),
        ]),
      ]),
    }
  },
})
