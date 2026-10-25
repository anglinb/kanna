import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../../client/lib/utils"
import { classifyAttachmentIcon, classifyAttachmentPreview, type AttachmentIconKind } from "../../../client/components/messages/attachmentPreview"
import type { ChatAttachment } from "../../../shared/types"
import type { Icon } from "../../ui/icon"
import {
  File,
  FileArchive,
  FileAudio,
  FileCode2,
  FileImage,
  FileJson,
  FileSpreadsheet,
  FileText,
  FileVideoCamera,
  ReceiptText,
  ScrollText,
  X,
} from "../../ui/icons"
import type { RowContext } from "./context"
import { Message } from "./model"

/**
 * A prompt's attachments (AttachmentCard.tsx, and UserMessageAttachments in
 * UserMessage.tsx): images as previews, everything else as file cards. The
 * cards are generic in their Message so the composer can show its pending
 * attachments with the same ones (`size: "composer"`, `onRemove`).
 */

export interface AttachmentCardOptions<M> {
  previewUrl?: string
  onClick?: M
  onRemove?: M
  class?: string
}

export function attachmentImageCard<M>(attachment: ChatAttachment, options: AttachmentCardOptions<M> & { size?: "transcript" | "composer" }, h: HtmlBuilder<M>): Html {
  const source = attachment.contentUrl || options.previewUrl
  const isComposer = (options.size ?? "transcript") === "composer"
  return h.div([h.Class(cn("group relative flex flex-row items-end", options.class))], [
    h.button([
      h.Type("button"),
      ...(options.onClick !== undefined ? [h.OnClick(options.onClick)] : []),
      h.Class(cn(
        "group/image relative overflow-hidden rounded-xl border border-border/80 bg-background/85 shadow-sm backdrop-blur-md",
        isComposer ? "min-w-[80px]" : "min-w-[200px]",
      )),
    ], [
      source
        ? h.img([
          h.Src(source),
          h.Alt(attachment.displayName),
          h.Class(cn(
            "rounded-xl object-contain bg-muted",
            isComposer
              ? "min-h-[50px] min-w-[80px] max-h-[120px] max-w-[200px]"
              : "min-h-[100px] min-w-[200px] max-h-[300px] max-w-[300px]",
          )),
        ])
        : h.div([h.Class(cn("flex items-center justify-center rounded-xl bg-muted text-muted-foreground", isComposer ? "min-h-[64px] min-w-[80px]" : "min-h-[160px] min-w-[200px]"))], [
          FileImage({ class: cn(isComposer ? "size-6" : "size-8") }, h),
        ]),
      h.div([h.Class(cn(
        "pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/30 to-black/10 md:to-black/0 text-left opacity-0 transition-opacity duration-200 group-hover/image:opacity-100",
        isComposer ? "px-2.5 pb-2 pt-6" : "px-4 pb-3 pt-10",
      ))], [
        h.div([h.Class(cn("truncate font-medium text-white", isComposer ? "text-xs" : "text-sm"))], [attachment.displayName]),
        h.div([h.Class("truncate text-xs text-white/80")], [`${attachment.mimeType} · ${formatAttachmentSize(attachment.size)}`]),
      ]),
    ]),
    options.onRemove !== undefined ? removeButton(attachment.displayName, options.onRemove, h) : null,
  ])
}

export function attachmentFileCard<M>(attachment: ChatAttachment, options: AttachmentCardOptions<M>, h: HtmlBuilder<M>): Html {
  const icon = getAttachmentIcon(classifyAttachmentIcon(attachment))
  return h.div([h.Class(cn("group relative", options.class))], [
    h.button([
      h.Type("button"),
      ...(options.onClick !== undefined ? [h.OnClick(options.onClick)] : []),
      h.Class("flex w-[200px] items-center gap-2 rounded-xl border border-border bg-muted dark:bg-card p-1 pr-3 text-left transition-colors hover:border-muted-foreground/50"),
    ], [
      h.div([h.Class("flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground")], [
        icon({ class: "size-5" }, h),
      ]),
      h.div([h.Class("min-w-0")], [
        h.div([h.Class("max-w-[150px] truncate text-[13px] font-medium text-foreground")], [attachment.displayName]),
        h.div([h.Class("truncate text-[11px] text-muted-foreground")], [`${attachment.mimeType} · ${formatAttachmentSize(attachment.size)}`]),
      ]),
    ]),
    options.onRemove !== undefined ? removeButton(attachment.displayName, options.onRemove, h) : null,
  ])
}

function removeButton<M>(displayName: string, onRemove: M, h: HtmlBuilder<M>): Html {
  return h.button([
    h.Type("button"),
    h.Class("absolute right-2 top-2 rounded-full bg-background/90 p-1 text-muted-foreground shadow-sm transition hover:bg-muted hover:text-foreground"),
    h.OnClick(onRemove),
    h.AriaLabel(`Remove ${displayName}`),
  ], [X({ class: "h-3.5 w-3.5" }, h)])
}

function getAttachmentIcon(kind: AttachmentIconKind): Icon {
  switch (kind) {
    case "image":
      return FileImage
    case "pdf":
      return ReceiptText
    case "markdown":
      return ScrollText
    case "json":
      return FileJson
    case "table":
      return FileSpreadsheet
    case "code":
      return FileCode2
    case "text":
      return FileText
    case "archive":
      return FileArchive
    case "audio":
      return FileAudio
    case "video":
      return FileVideoCamera
    default:
      return File
  }
}

export function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}

/**
 * What a click on a prompt's attachment does: the viewer, or a new tab for a
 * file it can't show (UserMessageAttachments' handleAttachmentClick).
 */
function openAttachment(attachment: ChatAttachment): Message {
  const target = classifyAttachmentPreview(attachment)
  if (target.openInNewTab) return Message.ClickedAttachment({ target: { url: attachment.contentUrl, viewer: null } })
  return Message.ClickedAttachment({
    target: {
      url: attachment.contentUrl,
      viewer: { url: attachment.contentUrl, name: attachment.displayName, mimeType: attachment.mimeType, size: attachment.size },
    },
  })
}

/**
 * A prompt's attachments: images as previews, everything else as file cards.
 * `align` is the side of the column the prompt sits on: the end for one the
 * user typed, the start for one that was sent to the chat (SourcedMessage).
 */
export function userMessageAttachments(attachments: ReadonlyArray<ChatAttachment>, align: "start" | "end", context: RowContext, h: HtmlBuilder<Message>): ReadonlyArray<Html> {
  const shouldShowImagePlaceholders = context.options.attachmentMode === "metadata"
  const canInteract = !context.options.readonly || context.options.attachmentMode === "bundle"
  const images = attachments.filter((attachment) => attachment.kind === "image" && (attachment.contentUrl || shouldShowImagePlaceholders))
  const files = attachments.filter((attachment) => attachment.kind !== "image" || (!attachment.contentUrl && !shouldShowImagePlaceholders))
  const onClick = (attachment: ChatAttachment) => (canInteract && attachment.contentUrl ? openAttachment(attachment) : undefined)
  // React wires a click whenever interaction is allowed (a click on one
  // without a URL does nothing); the handler's presence draws nothing.
  return [
    images.length > 0
      ? h.div([h.Class(cn("flex max-w-[85%] sm:max-w-[80%] flex-wrap", align === "end" ? "justify-end" : "justify-start", "gap-3"))],
        images.map((attachment) => attachmentImageCard(attachment, { onClick: onClick(attachment) }, h)))
      : null,
    files.length > 0
      ? h.div([h.Class(cn("flex max-w-[85%] sm:max-w-[80%] flex-wrap", align === "end" ? "justify-end" : "justify-start", "gap-2"))],
        files.map((attachment) => attachmentFileCard(attachment, { onClick: onClick(attachment) }, h)))
      : null,
  ]
}
