import { Schema } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { displayAttachments, type ChartToolPayload, type DisplayAttachment } from "../../../shared/display-tools"
import { readVisualizationArtifact, VISUALIZATION_TOOL_NAME } from "../../../shared/visualization"
import { opaque } from "../../core/schema"
import { viewerAttachmentFromDisplay } from "../../core/stores/viewer"
import { ArrowUpRight, FileText } from "../../ui/icons"
import { domStream } from "../../ui/overlay/stream"
import { chartTool } from "./chart"
import type { RowContext } from "./context"
import { EMPTY_STRIP, Message } from "./model"
import { RequestPayloadsOnMount } from "./mounts"
import type { ToolCall } from "./tool-call"
import { visualization } from "./visualization"

/**
 * DisplayToolMessage.tsx: what a display tool shows in the transcript: a
 * chart, a visualization, or a strip of attachments (images, videos, files).
 */

export function displayToolMessage(message: ToolCall, context: RowContext, h: HtmlBuilder<Message>): Html {
  // Older cached updates can lack the result body even though the server has it.
  const fetchedResult = message.resultTrimmed && message.resultEntryId ? context.model.payloads[message.resultEntryId] : undefined
  const rawResult = fetchedResult?.kind === "tool_result" ? fetchedResult.content : message.rawResult
  const wanted = message.resultTrimmed && message.resultEntryId ? [message.resultEntryId] : []
  const onMount = wanted.length > 0 ? [h.OnMount(RequestPayloadsOnMount({ entryIds: wanted }))] : []
  if (!message.resultEntryId || (message.resultTrimmed && !fetchedResult)) {
    const label = message.toolName === VISUALIZATION_TOOL_NAME
      ? "Preparing visualization"
      : message.toolName === "show_chart"
        ? "Preparing chart"
        : message.toolName === "generate_images" ? "Generating images" : "Preparing attachments"
    return h.p([h.Class("text-sm text-muted-foreground"), ...onMount], [`${label}...`])
  }
  if (message.isError) return h.p([h.Role("alert"), h.Class("text-sm text-destructive")], [errorText(rawResult)])
  if (message.toolKind !== "display") return null
  if (message.toolName === "show_chart") return chartTool(message.id, message.input.payload as unknown as ChartToolPayload, context, h)
  if (message.toolName === VISUALIZATION_TOOL_NAME) {
    const artifact = readVisualizationArtifact(rawResult)
    return artifact
      ? visualization(message.id, artifact, context, h)
      : h.p([h.Role("alert"), h.Class("text-sm text-muted-foreground")], ["Visualization unavailable."])
  }
  return attachmentsCard(message.id, displayAttachments(rawResult), context, h)
}

function errorText(result: unknown): string {
  if (Array.isArray(result)) return result.map((block: { text?: string } | null) => block?.text ?? "").join("\n") || "Could not display this result."
  return "Could not display this result."
}

/**
 * On the card: a plain click on a link opens the attachment in the viewer;
 * a modified or middle click keeps the link's own behaviour (a new tab),
 * which is why these stay links rather than buttons. Foldkit's click
 * attribute can't see modifiers, so the listener here sorts them. Also a
 * preview that fails to load, and the strip's scroll edges (images set the
 * content width when they load, so both elements are watched).
 */
const AttachmentStrip = Mount.defineStream("AttachmentStrip", {
  args: { key: Schema.String, attachments: Schema.Array(opaque<DisplayAttachment>("DisplayAttachment")) },
  messages: [Message.ClickedAttachment, Message.FailedAttachmentPreview, Message.MeasuredStrip],
  execute: ({ element, key, attachments }) =>
    domStream<typeof Message.ClickedAttachment.Type | typeof Message.FailedAttachmentPreview.Type | typeof Message.MeasuredStrip.Type>((emit) => {
      const card = element as HTMLElement
      const onClick = (event: MouseEvent) => {
        const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a") : null
        const figure = link?.closest("figure")
        if (!link || !figure || !card.contains(link)) return
        // Figures are in the attachments' order, one each.
        const attachment = attachments[Array.prototype.indexOf.call(figure.parentElement?.children ?? [], figure)]
        if (!attachment) return
        if (event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return
        event.preventDefault()
        emit(Message.ClickedAttachment({ target: { url: attachment.url, viewer: viewerAttachmentFromDisplay(attachment) } }))
      }
      const onError = (event: Event) => {
        const media = event.target
        if (!(media instanceof HTMLImageElement || media instanceof HTMLVideoElement) || !card.contains(media)) return
        const url = media.getAttribute("src")
        if (url) emit(Message.FailedAttachmentPreview({ key, url }))
      }
      card.addEventListener("click", onClick)
      card.addEventListener("error", onError, true)

      const scroller = card.firstElementChild as HTMLElement | null
      const content = scroller?.firstElementChild as HTMLElement | null
      const measure = () => {
        if (!scroller) return
        emit(Message.MeasuredStrip({
          key,
          strip: {
            moreLeft: scroller.scrollLeft > 1,
            moreRight: scroller.scrollLeft + scroller.clientWidth < scroller.scrollWidth - 1,
            scrollbarHeight: scroller.offsetHeight - scroller.clientHeight,
          },
        }))
      }
      scroller?.addEventListener("scroll", measure)
      const observer = !scroller || !content || typeof ResizeObserver === "undefined" ? null : new ResizeObserver(measure)
      if (scroller && content) {
        observer?.observe(scroller)
        observer?.observe(content)
      }
      return () => {
        card.removeEventListener("click", onClick)
        card.removeEventListener("error", onError, true)
        scroller?.removeEventListener("scroll", measure)
        observer?.disconnect()
      }
    }),
})

/** The attachments a display tool sent, previewed in a strip (AttachmentsCard). */
export function attachmentsCard(key: string, attachments: ReadonlyArray<DisplayAttachment>, context: RowContext, h: HtmlBuilder<Message>): Html {
  const multiple = attachments.length > 1
  const filesOnly = attachments.every((attachment) => attachment.kind === "file")
  const strip = context.model.strips[key] ?? EMPTY_STRIP
  return h.div([h.Class("group relative -m-2 w-[calc(100%+1rem)] min-w-0 overflow-hidden"), h.AriaLabel("Attachments"), h.OnMount(AttachmentStrip({ key, attachments }))], [
    // The scrollbar keeps its space and only its thumb goes transparent.
    h.div([h.Class("attachments-scroller w-full snap-x scroll-px-2 overflow-x-auto")], [
      // Images and videos scroll sideways. A row of only files wraps instead.
      h.div([h.Class(`flex gap-2 p-2 ${filesOnly ? "w-full flex-wrap" : "w-max min-w-full"}`)], attachments.map((attachment) => {
        const failed = Boolean(context.model.broken[`${key}|${attachment.url}`])
        const mediaClass = "block h-56 w-full rounded-[10px] border border-border bg-muted dark:bg-card object-contain"
        const imagePreview = attachment.kind === "image" && !failed
        return h.figure([h.Class(imagePreview
          ? "m-0 flex w-fit shrink-0 snap-start flex-col items-start gap-1"
          : multiple ? "m-0 flex max-w-full shrink-0 snap-start flex-col gap-1" : "m-0 flex max-w-full flex-col gap-1")], [
          imagePreview
            ? h.a([h.Href(attachment.url), h.Target("_blank"), h.Rel("noreferrer noopener"), h.Class("block"), h.AriaLabel(`Open ${attachment.name}`)], [
              // Every image has the same height. Only a panorama wider than the cap is cropped.
              h.img([h.Src(attachment.url), h.Alt(attachment.name), h.Referrerpolicy("no-referrer"), h.Class("block h-56 w-auto max-w-[32rem] rounded-[10px] object-cover shadow-md")]),
            ])
            : attachment.kind === "video" && !failed
              ? h.video([h.Src(attachment.url), h.Controls(true), h.Preload("metadata"), h.Class(mediaClass), h.AriaLabel(attachment.name)], [])
              : h.a([h.Href(attachment.url), h.Target("_blank"), h.Rel("noreferrer noopener"), h.Class("flex max-w-80 items-center gap-3 rounded-[10px] border border-border bg-muted dark:bg-card p-3 text-sm hover:border-muted-foreground/50")], [
                FileText({ class: "size-5 shrink-0 text-muted-foreground" }, h),
                h.span([h.Class("min-w-0 truncate")], [attachment.name]),
                ArrowUpRight({ class: "size-4 shrink-0" }, h),
              ]),
          failed ? h.span([h.Class("text-xs text-muted-foreground")], ["Preview unavailable. Open the file to view it."]) : null,
        ])
      })),
    ]),
    // A line marks each side that has more content past it. The lines are overlays and stop above the scrollbar.
    ...([["left-0", strip.moreLeft], ["right-0", strip.moreRight]] as const).map(([side, visible]) =>
      h.span([h.AriaHidden(true), h.Class(`pointer-events-none absolute top-0 w-px bg-border transition-opacity ${side} ${visible ? "opacity-100" : "opacity-0"}`), h.Style({ bottom: `${strip.scrollbarHeight}px` })], [])),
  ])
}
