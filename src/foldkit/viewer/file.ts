import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import type { ViewerAttachment } from "../core/stores/viewer"
import { Code, FileCode, FileDiff, WrapText } from "../ui/icons"
import { skeleton } from "../ui/skeleton"
import { hasRenderedView, previewKind, renderedFilePreview, textLoader, textSlot, textState } from "./attachment"
import { CodeFileMount } from "./diffs"
import { splitDiffPath, type DiffFile } from "./git"
import { Message } from "./message"
import type { Model } from "./model"
import { openFileSelect, selectId, type OpenFileContext } from "./openFileSelect"
import { VIEWER_END_PAD_CLASS, viewerIconButton, viewerPanes, viewerSurface, viewerToggle, type LayerContext } from "./surface"

// FileViewer (components/viewer/FileViewer.tsx): a project file, as it reads
// on disk: what a file link in the chat opens, rather than switching to the
// editor. Code is highlighted, and a link to a line lands on that line,
// marked. Markdown and CSV open as their preview (a link to a line opens the
// text, where the line is). The editor, and the file's diff when it has
// changes, are a button away.

type H = HtmlBuilder<Message>

/** What the file viewer needs from the page (DiffViewerContext's part of it). */
export interface FileContext {
  files: ReadonlyArray<DiffFile>
  editorLabel: string
  wrapLines: boolean
  theme: "light" | "dark"
  open: OpenFileContext
}

/** Keyed so a new file or line starts over: its own view, its own jump. */
export function fileCardKey(path: string, line: number | undefined) {
  return `file:${path}:${line ?? ""}`
}

export function fileViewer(model: Model, context: LayerContext, file: FileContext, item: { projectId: string; path: string; line?: number }, h: H): Html {
  const { projectId, path, line } = item
  const cardKey = fileCardKey(path, line)
  const { name, folder } = splitDiffPath(path)
  const changed = file.files.find((candidate) => candidate.path === path)
  // A changed file's digest rides along, so the agent's next edit reads again.
  const url = `/api/projects/${projectId}/files/${encodeURIComponent(path)}/content${changed ? `?v=${encodeURIComponent(changed.patchDigest)}` : ""}`
  const attachment: ViewerAttachment = { url, name, mimeType: "text/plain", size: null }
  const renderable = hasRenderedView(attachment)
  const held = model.card?.key === cardKey ? model.toggles[cardKey] : undefined
  const view = held ?? (renderable && line === undefined ? "preview" : "original")
  const showPreview = renderable && view === "preview"
  const subtitle = [folder, line !== undefined ? `line ${line}` : null].filter(Boolean).join(" · ")
  const openInEditor = Message.ClickedOpenInEditor({ path, line: line ?? null })
  const fileText = () => fileTextView(model, cardKey, attachment, line, file, openInEditor, h)

  const preview = renderable ? renderedFilePreview(model, cardKey, "preview", attachment, true, h) : null
  return viewerSurface(model, context, {
    cardKey,
    label: `View ${path}`,
    icon: FileCode({}, h),
    title: name,
    // RTL so a long folder loses its start, not its end; <bdi> keeps the path reading left to right.
    subtitle: subtitle ? h.span([h.Class("block truncate text-left [direction:rtl]")], [h.bdi([], [subtitle])]) : null,
    center: renderable
      ? viewerToggle(view, [{ value: "preview", label: "Preview" }, { value: "original", label: "Original" }], (value) => Message.ChoseView({ cardKey, value, previous: view }), h)
      : null,
    toolbar: [
      changed ? viewerIconButton(model, { id: "show-changes", label: "Show changes", onClick: Message.ClickedShowChanges({ projectId, path }) }, FileDiff({}, h), h) : null,
      showPreview
        ? null
        : viewerIconButton(model, {
          id: "wrap",
          label: file.wrapLines ? "Disable word wrap" : "Enable word wrap",
          active: file.wrapLines,
          onClick: Message.ClickedWrapLines(),
        }, WrapText({}, h), h),
      openFileSelect(model, file.open, { id: selectId("file", path, line ?? null), path, line: line ?? null }, h),
    ],
    body: [
      renderable
        ? viewerPanes(model, cardKey, view, [
          { key: "preview", render: () => preview!.body },
          { key: "original", render: fileText },
        ], h)
        : fileText(),
      preview?.loader ?? null,
      // The text is read when it's first shown: a CSV opened as its table may never need it.
      !renderable || view === "original" || (model.card?.key === cardKey && (model.panes[cardKey] ?? []).includes("original"))
        ? textLoader(textSlot(cardKey, url), attachment, "text", h)
        : null,
    ],
  }, h)
}

function fileTextView(model: Model, cardKey: string, attachment: ViewerAttachment, line: number | undefined, file: FileContext, openInEditor: Message, h: H): Html {
  const text = textState(model, cardKey, textSlot(cardKey, attachment.url), "text")!
  if (text.status === "loading") return codeSkeleton(h)
  if (text.status === "error") {
    return h.div([h.Class("flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center")], [
      h.p([h.Class("text-sm text-muted-foreground")], ["Couldn't read this file."]),
      h.button([
        h.Type("button"),
        h.OnClick(openInEditor),
        h.Class("flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"),
      ], [Code({ class: "size-3.5" }, h), ` Open in ${file.editorLabel}`]),
    ])
  }
  if (text.content.length === 0) {
    return h.div([h.Class("flex min-h-full items-center justify-center p-6 text-sm text-muted-foreground")], ["Empty file."])
  }
  // A new renderer for new text or options (see diffs.ts).
  return h.keyed("div")(`code:${attachment.url}:${line ?? ""}:${file.wrapLines}:${file.theme}:${text.content.length}`, [
    h.Class(cn("kanna-diff-patch", VIEWER_END_PAD_CLASS)),
    h.OnMount(CodeFileMount({ name: attachment.name, contents: text.content, line: line ?? null, wrap: file.wrapLines, theme: file.theme })),
  ], [])
}

// Uneven widths, indented like code.
const SKELETON_CODE_LINES = [
  { indent: 0, width: "34%" },
  { indent: 1, width: "58%" },
  { indent: 1, width: "46%" },
  { indent: 2, width: "63%" },
  { indent: 2, width: "40%" },
  { indent: 1, width: "28%" },
  { indent: 0, width: "18%" },
]

function codeSkeleton(h: H): Html {
  return h.div([h.Class("space-y-2 px-4 py-4"), h.AriaBusy(true), h.AriaLabel("Loading file")], SKELETON_CODE_LINES.map((entry) =>
    h.div([h.Class("flex items-center gap-3")], [
      skeleton({ class: "h-3 w-5 shrink-0 bg-foreground/[0.05]" }, h),
      skeleton({ class: "h-3", style: { "margin-left": `${entry.indent * 12}px`, width: entry.width } }, h),
    ])))
}

export { previewKind }
