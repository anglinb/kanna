import { Effect } from "effect"
import { Mount } from "foldkit"
import type { Html } from "foldkit/html"
import type { WidgetAttachment } from "../../client/components/chat-ui/widgets/derive"
import { cn } from "../../client/lib/utils"
import { ArrowUpRight, FileText, Film, Paperclip } from "../ui/icons"
import type { H } from "./context"
import { Message } from "./message"
import { PartsMessage, widgetCard, widgetList, widgetRow, widgetTile, widgetTileGrid } from "./parts"

// AttachmentsWidget (widgets/AttachmentsWidget.tsx): files the agent sent
// this chat, newest first. Images as a thumbnail grid, everything else as
// rows below them. Either opens in the viewer.

/**
 * Fades in once decoded (AttachmentThumbnail): the image starts transparent
 * and the load (or an image already complete) lights it, as React's state
 * did.
 */
const FadeInOnLoad = Mount.define("WidgetFadeInOnLoad", {
  messages: [PartsMessage.CompletedStopPropagation],
  execute: ({ element }) => Effect.gen(function* () {
    const image = element as HTMLImageElement
    const show = () => {
      image.classList.remove("opacity-0")
      image.classList.add("opacity-100")
    }
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        if (image.complete && image.naturalWidth > 0) show()
        image.addEventListener("load", show)
        return show
      }),
      (listener) => Effect.sync(() => image.removeEventListener("load", listener)),
    )
    return PartsMessage.CompletedStopPropagation()
  }),
})

export function attachmentsWidget(attachments: readonly WidgetAttachment[], h: H): Html {
  const images = attachments.filter((attachment) => attachment.kind === "image")
  const others = attachments.filter((attachment) => attachment.kind !== "image")
  return widgetCard({
    icon: Paperclip({}, h),
    title: ["Attachments"],
    count: attachments.length,
    body: [
      // Scrolls inside a cap: a chat that generated dozens of images would
      // otherwise push every widget below it off screen.
      widgetList({ class: "max-h-[40vh] overflow-y-auto" }, [
        images.length > 0
          ? widgetTileGrid(images.map((image) => widgetTile({ key: image.key, tooltip: image.name, onActivate: Message.ClickedAttachment({ key: image.key }) }, [
            h.img([
              h.Src(image.url),
              h.Alt(image.name),
              h.Loading("lazy"),
              h.Class(cn("size-full object-cover transition-opacity duration-200 ease-snappy", "opacity-0")),
              h.OnMount(Mount.mapMessage(FadeInOnLoad(), (message) => Message.GotPartsMessage({ message }))),
            ]),
          ], h)), h)
          : null,
        ...others.map((attachment) => widgetRow({
          key: attachment.key,
          icon: attachment.kind === "video" ? Film({}, h) : FileText({}, h),
          title: attachment.name,
          tooltip: attachment.name,
          meta: [ArrowUpRight({ class: "size-3.5" }, h)],
          onActivate: Message.ClickedAttachment({ key: attachment.key }),
        }, h)),
      ], h),
    ],
  }, h)
}
