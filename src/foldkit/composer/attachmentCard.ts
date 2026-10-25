import type { Html, HtmlBuilder } from "foldkit/html"
import { classifyAttachmentIcon, type AttachmentIconKind } from "../../client/components/messages/attachmentPreview"
import { cn } from "../../client/lib/utils"
import type { ChatAttachment } from "../../shared/types"
import type { Icon } from "../ui/icon"
import * as Icons from "../ui/icons"

// src/client/components/messages/AttachmentCard.tsx: the image and file
// cards, in the composer's staging row and (size "transcript") under a
// sent prompt.

export interface AttachmentCardOptions<Message> {
  attachment: ChatAttachment
  previewUrl?: string
  onClick?: Message
  onRemove?: Message
  className?: string
}

export function attachmentImageCard<Message>(
  options: AttachmentCardOptions<Message> & { size?: "transcript" | "composer" },
  h: HtmlBuilder<Message>,
): Html {
  const { attachment } = options
  const source = attachment.contentUrl || options.previewUrl
  const isComposer = (options.size ?? "transcript") === "composer"
  return h.div([h.Class(cn("group relative flex flex-row items-end", options.className))], [
    h.button(
      [
        h.Type("button"),
        ...(options.onClick ? [h.OnClick(options.onClick)] : []),
        h.Class(cn(
          "group/image relative overflow-hidden rounded-xl border border-border/80 bg-background/85 shadow-sm backdrop-blur-md",
          isComposer ? "min-w-[80px]" : "min-w-[200px]",
        )),
      ],
      [
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
          : h.div(
            [h.Class(cn(
              "flex items-center justify-center rounded-xl bg-muted text-muted-foreground",
              isComposer ? "min-h-[64px] min-w-[80px]" : "min-h-[160px] min-w-[200px]",
            ))],
            [Icons.FileImage({ class: cn(isComposer ? "size-6" : "size-8") }, h)],
          ),
        h.div(
          [h.Class(cn(
            "pointer-events-none absolute inset-x-0 bottom-0 bg-gradient-to-t from-black/75 via-black/30 to-black/10 md:to-black/0 text-left opacity-0 transition-opacity duration-200 group-hover/image:opacity-100",
            isComposer ? "px-2.5 pb-2 pt-6" : "px-4 pb-3 pt-10",
          ))],
          [
            h.div([h.Class(cn("truncate font-medium text-white", isComposer ? "text-xs" : "text-sm"))], [attachment.displayName]),
            h.div([h.Class("truncate text-xs text-white/80")], [`${attachment.mimeType} · ${formatAttachmentSize(attachment.size)}`]),
          ],
        ),
      ],
    ),
    options.onRemove ? removeButton(attachment.displayName, options.onRemove, h) : null,
  ])
}

export function attachmentFileCard<Message>(options: AttachmentCardOptions<Message>, h: HtmlBuilder<Message>): Html {
  const { attachment } = options
  const icon = attachmentIcon(classifyAttachmentIcon(attachment))
  return h.div([h.Class(cn("group relative", options.className))], [
    h.button(
      [
        h.Type("button"),
        ...(options.onClick ? [h.OnClick(options.onClick)] : []),
        h.Class("flex w-[200px] items-center gap-2 rounded-xl border border-border bg-muted dark:bg-card p-1 pr-3 text-left transition-colors hover:border-muted-foreground/50"),
      ],
      [
        h.div([h.Class("flex min-h-10 min-w-10 items-center justify-center rounded-lg border border-border bg-muted text-muted-foreground")], [
          icon({ class: "size-5" }, h),
        ]),
        h.div([h.Class("min-w-0")], [
          h.div([h.Class("max-w-[150px] truncate text-[13px] font-medium text-foreground")], [attachment.displayName]),
          h.div([h.Class("truncate text-[11px] text-muted-foreground")], [`${attachment.mimeType} · ${formatAttachmentSize(attachment.size)}`]),
        ]),
      ],
    ),
    options.onRemove ? removeButton(attachment.displayName, options.onRemove, h) : null,
  ])
}

function removeButton<Message>(displayName: string, onRemove: Message, h: HtmlBuilder<Message>): Html {
  return h.button(
    [
      h.Type("button"),
      h.Class("absolute right-2 top-2 rounded-full bg-background/90 p-1 text-muted-foreground shadow-sm transition hover:bg-muted hover:text-foreground"),
      h.OnClick(onRemove, { defaultAction: "Prevent", propagation: "Stop" }),
      h.AriaLabel(`Remove ${displayName}`),
    ],
    [Icons.X({ class: "h-3.5 w-3.5" }, h)],
  )
}

function attachmentIcon(kind: AttachmentIconKind): Icon {
  switch (kind) {
    case "image":
      return Icons.FileImage
    case "pdf":
      return Icons.ReceiptText
    case "markdown":
      return Icons.ScrollText
    case "json":
      return Icons.FileJson
    case "table":
      return Icons.FileSpreadsheet
    case "code":
      return Icons.FileCode2
    case "text":
      return Icons.FileText
    case "archive":
      return Icons.FileArchive
    case "audio":
      return Icons.FileAudio
    case "video":
      return Icons.FileVideoCamera
    default:
      return Icons.File
  }
}

export function formatAttachmentSize(size: number): string {
  if (size < 1024) return `${size} B`
  if (size < 1024 * 1024) return `${Math.max(1, Math.round(size / 1024))} KB`
  return `${(size / (1024 * 1024)).toFixed(1)} MB`
}
