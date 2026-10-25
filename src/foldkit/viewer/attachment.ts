import { Effect, Schema } from "effect"
import { Mount, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import {
  classifyAttachmentPreview,
  fetchTextPreview,
  parseDelimitedPreview,
  prettifyJson,
  TEXT_PREVIEW_LIMIT_BYTES,
  type AttachmentPreviewKind,
  type TablePreviewData,
} from "../../client/components/messages/attachmentPreview"
import { cn } from "../../client/lib/utils"
import type { ViewerAttachment } from "../core/stores/viewer"
import * as Messages from "../transcript/messages"
import { transcriptMarkdownChildren } from "../transcript/messages/context"
import type { Child } from "../ui/attributes"
import { ArrowDown, ArrowUp, ChevronsUpDown, ExternalLink, File, FileImage, FileJson, FileText, FileVideo, Link2, Sheet } from "../ui/icons"
import type { Icon } from "../ui/icon"
import { skeleton } from "../ui/skeleton"
import { domStream } from "../ui/overlay/stream"
import { Message } from "./message"
import { INITIAL_TABLE, type LoadState, type Model, type SortState, type TableState } from "./model"
import { viewerIconButton, viewerPanes, viewerSurface, viewerToggle, type LayerContext } from "./surface"

// AttachmentViewer (components/viewer/AttachmentViewer.tsx): an attachment at
// full size. Images and video fit, PDFs fill, text reads, markdown renders
// and CSV/TSV opens as a sortable table.

type H = HtmlBuilder<Message>

/** Rows and columns the table view reads: the viewer has the room, and a sort wants the rows. */
const VIEWER_TABLE_LIMITS = { rows: 1_000, columns: 50 }
/** A one-line row: text-xs's 16px line, py-1.5, and its 1px rule. */
const FILLER_ROW_HEIGHT = 29
/** An empty column past the data. */
const FILLER_COLUMN_WIDTH = 120

type TextKind = Extract<AttachmentPreviewKind, "markdown" | "text" | "json" | "table">

const KIND_ICONS: Record<AttachmentPreviewKind, Icon> = {
  image: FileImage,
  video: FileVideo,
  pdf: FileText,
  markdown: FileText,
  text: FileText,
  json: FileJson,
  table: Sheet,
  external: File,
}

export function previewKind(attachment: ViewerAttachment) {
  return classifyAttachmentPreview({ mimeType: attachment.mimeType, displayName: attachment.name, size: attachment.size }).kind
}

/** Whether a file reads differently rendered than as its text: markdown, and CSV/TSV as a table. */
export function hasRenderedView(attachment: ViewerAttachment) {
  const kind = previewKind(attachment)
  return kind === "markdown" || kind === "table"
}

function isTextKind(kind: AttachmentPreviewKind): kind is TextKind {
  return kind === "markdown" || kind === "text" || kind === "json" || kind === "table"
}

/** Copied from AttachmentCard.tsx (a React file): formatAttachmentSize. */
function formatAttachmentSize(size: number) {
  return Messages.formatAttachmentSize(size)
}

/**
 * What a preview left out, briefly: "first 1,000 of 1,001 rows". A sort only
 * reorders what's shown, which "first" already says.
 */
export function truncationNotes(content: { truncated: boolean; table?: TablePreviewData }): string[] {
  const table = content.table
  return [
    content.truncated ? "first 1 MB" : null,
    table?.truncatedRows ? `first ${table.rows.length.toLocaleString()} of ${table.rowCount.toLocaleString()} rows` : null,
    table?.truncatedColumns ? `first ${VIEWER_TABLE_LIMITS.columns} of ${table.columnCount} columns` : null,
  ].filter((note): note is string => note !== null)
}

// READING THE FILE

/**
 * Reads a text-shaped file once per showing, with the table parsed for the
 * table view (`useTextContent`). On the element that holds the view, so a
 * view that goes stops its read, as the effect's cleanup did.
 */
export const LoadText = Mount.define("ViewerLoadText", {
  args: { slot: Schema.String, url: Schema.String, kind: Schema.String, tab: Schema.Boolean },
  messages: [Message.LoadedText],
  execute: ({ slot, url, kind, tab }) =>
    Effect.tryPromise(() => fetchTextPreview(url, TEXT_PREVIEW_LIMIT_BYTES)).pipe(
      Effect.map(({ content, truncated }): LoadState => {
        if (kind === "table") return { status: "ready", content, truncated, table: parseDelimitedPreview(content, tab ? "\t" : ",", VIEWER_TABLE_LIMITS) }
        return { status: "ready", content: kind === "json" ? prettifyJson(content) : content, truncated }
      }),
      Effect.catch((error) => Effect.succeed<LoadState>({
        status: "error",
        message: error.cause instanceof Error ? error.cause.message : "Couldn't load this file.",
      })),
      Effect.map((state) => Message.LoadedText({ slot, state })),
    ),
})

/** The slot a card's read of `url` is kept under. */
export function textSlot(cardKey: string, url: string) {
  return `${cardKey}|${url}`
}

function isTab(attachment: ViewerAttachment) {
  return attachment.mimeType === "text/tab-separated-values" || attachment.name.toLowerCase().endsWith(".tsv")
}

/** The read's state as the view sees it: nothing until the card is the one mounted, loading until it lands. */
export function textState(model: Model, cardKey: string, slot: string, kind: AttachmentPreviewKind): LoadState | null {
  if (!isTextKind(kind)) return null
  if (model.card?.key !== cardKey) return { status: "loading" }
  return model.texts[slot] ?? { status: "loading" }
}

/** The element that reads it: hidden, keyed by what it reads. */
export function textLoader(slot: string, attachment: ViewerAttachment, kind: AttachmentPreviewKind, h: H): Html | null {
  if (!isTextKind(kind)) return null
  return h.keyed("span")(`load:${slot}`, [h.Hidden(true), h.OnMount(LoadText({ slot, url: attachment.url, kind, tab: isTab(attachment) }))], [])
}

// THE CARD

export type RenderView = "rendered" | "original"

export const ATTACHMENT_CARD_KEY = "attachment"

export function attachmentViewer(model: Model, context: LayerContext, attachment: ViewerAttachment, h: H): Html {
  const cardKey = ATTACHMENT_CARD_KEY
  const kind = previewKind(attachment)
  const slot = textSlot(cardKey, attachment.url)
  const content = textState(model, cardKey, slot, kind)
  const view = ((model.card?.key === cardKey ? model.toggles[cardKey] : undefined) ?? "rendered") as RenderView
  const icon = KIND_ICONS[kind]
  // What was left out leads the subtitle, before type and size.
  const subtitle = [
    ...(content?.status === "ready" ? truncationNotes(content) : []),
    attachment.mimeType,
    attachment.size !== null ? formatAttachmentSize(attachment.size) : null,
  ].filter(Boolean).join(" · ")
  const rendered = hasRenderedView(attachment)

  return viewerSurface(model, context, {
    cardKey,
    label: `Preview ${attachment.name}`,
    icon: icon({}, h),
    title: attachment.name,
    subtitle,
    center: rendered
      ? viewerToggle(view, [{ value: "rendered", label: "Preview" }, { value: "original", label: "Original" }], (value) => Message.ChoseView({ cardKey, value, previous: view }), h)
      : null,
    toolbar: [
      viewerIconButton(model, { id: "copy-link", label: "Copy link", onClick: Message.ClickedCopyLink({ url: attachment.url }) }, Link2({}, h), h),
      viewerIconButton(model, { id: "open-tab", label: "Open in new tab", onClick: Message.ClickedOpenInNewTab({ url: attachment.url }) }, ExternalLink({}, h), h),
    ],
    ...(kind === "image" || kind === "video" ? { bodyClassName: "bg-muted/30" } : {}),
    body: [
      rendered
        ? viewerPanes(model, cardKey, view, [
          { key: "rendered", render: () => attachmentBody(model, slot, attachment, kind, content, "rendered", h) },
          { key: "original", render: () => attachmentBody(model, slot, attachment, kind, content, "original", h) },
        ], h)
        : attachmentBody(model, slot, attachment, kind, content, view, h),
      textLoader(slot, attachment, kind, h),
    ],
  }, h)
}

/**
 * A file's rendered view on its own, for a viewer body that isn't an
 * attachment's: a changed markdown or CSV file, previewed in the diff list.
 * Markdown flows at its length; a table gets a box of its own to scroll.
 * The reader comes back apart (`loader`), for the caller to put beside it:
 * React's had no element of its own.
 */
export function renderedFilePreview(model: Model, cardKey: string, slotKey: string, attachment: ViewerAttachment, fill: boolean, h: H): { body: Html; loader: Html | null } {
  const kind = previewKind(attachment)
  const slot = textSlot(cardKey, `${slotKey}|${attachment.url}`)
  const content = textState(model, cardKey, slot, kind)
  const body = attachmentBody(model, slot, attachment, kind, content, "rendered", h)
  const loader = textLoader(slot, attachment, kind, h)
  return { body: kind === "table" && !fill ? h.div([h.Class("max-h-[70vh] overflow-auto")], [body]) : body, loader }
}

function attachmentBody(
  model: Model,
  slot: string,
  attachment: ViewerAttachment,
  kind: AttachmentPreviewKind,
  content: LoadState | null,
  view: RenderView,
  h: H,
): Html {
  if (kind === "image") {
    return h.div([h.Class("flex min-h-full items-center justify-center p-6")], [
      h.img([h.Src(attachment.url), h.Alt(attachment.name), h.Class("max-h-full max-w-full rounded-lg object-contain shadow-sm")]),
    ])
  }
  if (kind === "video") {
    return h.div([h.Class("flex min-h-full items-center justify-center p-6")], [
      h.video([h.Src(attachment.url), h.Controls(true), h.Class("max-h-full max-w-full rounded-lg"), h.AriaLabel(attachment.name)], []),
    ])
  }
  if (kind === "pdf") {
    return h.iframe([h.Src(attachment.url), h.Title(attachment.name), h.Class("size-full border-0")])
  }
  if (kind === "external") {
    return h.div([h.Class("flex min-h-full flex-col items-center justify-center gap-3 p-6 text-center")], [
      File({ class: "size-8 text-muted-foreground" }, h),
      h.p([h.Class("text-sm text-muted-foreground")], ["No preview for this kind of file."]),
      h.button([
        h.Type("button"),
        h.OnClick(Message.ClickedOpenInNewTab({ url: attachment.url })),
        h.Class("flex items-center gap-1.5 rounded-lg border border-border px-3 py-1.5 text-sm transition-colors hover:bg-muted"),
      ], [ExternalLink({ class: "size-3.5" }, h), " Open in new tab"]),
    ])
  }
  if (!content || content.status === "loading") return kind === "table" && view === "rendered" ? tableSkeleton(h) : textSkeleton(h)
  if (content.status === "error") {
    return h.div([h.Class("flex min-h-full items-center justify-center p-6 text-sm text-destructive")], [content.message])
  }
  if (kind === "table" && content.table && view === "rendered") {
    return sortableTable(model, slot, content.table, h)
  }
  if (kind === "markdown" && view === "rendered") {
    // A reading measure: ~72 characters a line, centred, however wide the viewer is.
    return h.article([h.Class("mx-auto max-w-[72ch] px-6 py-8")], [
      markdownRows(model, slot, content.content, h),
    ])
  }
  return h.div([h.Class("p-4")], [rowsSlot(model, `file-content:${slot}`, (_context, rowsH) => Messages.fileContentView({ content: content.content }, rowsH), h)])
}

// MARKDOWN AND TEXT, DRAWN WITH THE TRANSCRIPT'S ROWS

/**
 * Markup drawn by the transcript rows' own helpers, in their Model's
 * boundary: the markdown's code copy and local links are theirs, and come
 * back through `GotRowsMessage`.
 */
const RowsSlot = Submodel.defineView<Messages.Model, Messages.Message, { render: (context: Messages.RowContext, h: HtmlBuilder<Messages.Message>) => Html }>(
  (rows, inputs, h) => inputs.render(Messages.rowContext(rows, { interceptLocalLinks: true }), h),
)

export function rowsSlot(model: Model, slotId: string, render: (context: Messages.RowContext, h: HtmlBuilder<Messages.Message>) => Html, h: H): Html {
  return h.submodel({
    slotId,
    model: model.rows,
    view: RowsSlot,
    viewInputs: { render },
    toParentMessage: (message: Messages.Message) => Message.GotRowsMessage({ message }),
  })
}

/** The prose box with `<TranscriptMarkdown text>` in it. */
function markdownRows(model: Model, slot: string, text: string, h: H): Html {
  return rowsSlot(model, `markdown:${slot}`, (context, rowsH) => rowsH.div(
    [rowsH.Class("prose prose-sm max-w-none dark:prose-invert")],
    transcriptMarkdownChildren(text, `viewer:${slot}`, context, rowsH),
  ), h)
}

// SKELETONS

// Uneven widths: text of varying length, not a grid waiting to fill.
const SKELETON_LINES = ["62%", "48%", "71%", "40%", "66%", "55%", "30%", "58%"]

function textSkeleton(h: H): Html {
  return h.div([h.Class("mx-auto max-w-[72ch] space-y-3 px-6 py-8"), h.AriaBusy(true), h.AriaLabel("Loading preview")],
    SKELETON_LINES.map((width) => skeleton({ class: "h-3.5", style: { width } }, h)))
}

// Column widths and, per cell, how full its bar runs: uneven, like data, and the same every time.
const SKELETON_COLUMN_WIDTHS = [72, 148, 112, 188, 96, 136, 120, 164, 104, 140, 128, 176, 92, 152]
const SKELETON_FILLS = [0.72, 0.48, 0.86, 0.58, 0.4, 0.94, 0.64, 0.52, 0.78, 0.44, 0.68, 0.9]
const SKELETON_ROWS = 40

/**
 * A table on its way: the viewer's grid, header and all, in the table's own
 * cell geometry, with a band of light running through it corner to corner.
 */
function tableSkeleton(h: H): Html {
  return h.div([h.Class("h-full overflow-hidden"), h.AriaBusy(true), h.AriaLabel("Loading table")], [
    h.table([h.Class("table-fixed border-collapse text-xs"), h.Style({ width: `${SKELETON_COLUMN_WIDTHS.reduce((sum, width) => sum + width, 0)}px` })], [
      h.colgroup([], SKELETON_COLUMN_WIDTHS.map((width) => h.col([h.Style({ width: `${width}px` })]))),
      h.thead([], [
        h.tr([], SKELETON_COLUMN_WIDTHS.map((_, column) => h.th([h.Class("px-3 py-2 shadow-[inset_0_-1px_0_hsl(var(--border)),inset_-1px_0_0_hsl(var(--border))]")], [
          h.div([h.Class("flex h-4 items-center")], [skeletonBar(column, 0.55 + (column % 3) * 0.12, true, h)]),
        ]))),
      ]),
      h.tbody([], Array.from({ length: SKELETON_ROWS }, (_, row) => h.tr([], SKELETON_COLUMN_WIDTHS.map((_, column) => h.td([h.Class("border-b border-r border-border/60 px-3 py-1.5")], [
        h.div([h.Class("flex h-4 items-center")], [skeletonBar(row + 1 + column, SKELETON_FILLS[(row * 5 + column * 7) % SKELETON_FILLS.length]!, false, h)]),
      ]))))),
    ]),
  ])
}

function skeletonBar(diagonal: number, fill: number, strong: boolean, h: H): Html {
  return h.div([
    h.Class(cn("kanna-table-wave h-2 rounded-full", strong ? "bg-foreground/15" : "bg-foreground/10")),
    h.Style({ width: `${fill * 100}%`, "animation-delay": `${diagonal * 40}ms` }),
  ])
}

// THE TABLE

// Web addresses inside a cell, wherever they sit in its text.
const CELL_URL_PATTERN = /https?:\/\/[^\s<>"']+/gu

/** A cell's text with its web addresses as links, opening in a new tab. */
export function cellText(text: string, h: H): ReadonlyArray<Child> {
  const parts: Child[] = []
  let last = 0
  for (const match of text.matchAll(CELL_URL_PATTERN)) {
    // Trailing punctuation is the sentence's, not the address's.
    const url = match[0].replace(/[.,;:!?)\]]+$/u, "")
    const start = match.index ?? 0
    if (start > last) parts.push(text.slice(last, start))
    parts.push(h.a([
      h.Href(url),
      h.Target("_blank"),
      h.Rel("noreferrer noopener"),
      h.Class("text-foreground underline decoration-muted-foreground/50 underline-offset-2 hover:decoration-foreground"),
    ], [url]))
    last = start + url.length
  }
  if (last < text.length) parts.push(text.slice(last))
  return parts
}

/** A cell as a number when it reads as one: "1,204", "$3.50", "42%", "-7". */
function numericValue(cell: string): number | null {
  const cleaned = cell.trim().replace(/[,$€£%]/gu, "")
  if (cleaned === "" || !/^[-+]?\d*\.?\d+(e[-+]?\d+)?$/iu.test(cleaned)) return null
  return Number(cleaned)
}

const cellCollator = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/**
 * The rows' indices in sorted order, by one column. Numbers as numbers when
 * both cells are numeric, text otherwise. Empty cells always sink to the
 * bottom, whichever direction.
 */
export function sortedRowOrder(rows: readonly string[][], sort: SortState): number[] {
  const order = rows.map((_, index) => index)
  if (!sort) return order
  const keys = rows.map((row) => {
    const text = row[sort.column] ?? ""
    const empty = !text.trim()
    return { text, empty, number: empty ? null : numericValue(text) }
  })
  const factor = sort.direction === "asc" ? 1 : -1
  return order.sort((left, right) => {
    const a = keys[left]!
    const b = keys[right]!
    if (a.empty || b.empty) return (a.empty ? 1 : 0) - (b.empty ? 1 : 0)
    if (a.number !== null && b.number !== null) return (a.number - b.number) * factor
    return cellCollator.compare(a.text, b.text) * factor
  })
}

/** The next sort a header click makes: ascending, descending, then the file's order. */
export function cycleSort(current: SortState, column: number): SortState {
  if (!current || current.column !== column) return { column, direction: "asc" }
  if (current.direction === "asc") return { column, direction: "desc" }
  return null
}

/** Rows in the first paint (a tall screen's worth), then in each chunk after. */
export const FIRST_ROW_CHUNK = 60
export const ROW_CHUNK = 100

/** A column's widest, as a cell: 28rem. Longer text wraps inside it. */
const MAX_COLUMN_WIDTH = 448
const MIN_COLUMN_WIDTH = 48
/** px-3 either side, the rule, and a pixel of slack against rounding into a wrap. */
const CELL_CHROME = 24 + 1 + 2
/** The header's sort arrow and the gap before it. */
const HEADER_ICON = 12 + 4
/** Cells measured per column: the longest by characters. */
const MEASURED_CELLS = 8

let measureContext: CanvasRenderingContext2D | null | undefined

/** Each column's width, from its header and its longest cells, measured in the table's font. */
function measureColumnWidths(header: string[], body: string[][], columnCount: number, numericColumns: boolean[]): number[] {
  measureContext ??= typeof document === "undefined" ? null : document.createElement("canvas").getContext("2d")
  const context = measureContext
  const family = typeof document === "undefined" ? "sans-serif" : getComputedStyle(document.body).fontFamily
  const textWidth = (text: string, weight: number) => {
    if (!context) return text.length * 7
    context.font = `${weight} 12px ${family}`
    return Math.max(...text.split("\n").map((line) => context.measureText(line).width))
  }
  const digitWidth = textWidth("0", 400)
  return Array.from({ length: columnCount }, (_, column) => {
    const longest: string[] = []
    for (const row of body) {
      const cell = row[column]
      if (!cell) continue
      if (longest.length < MEASURED_CELLS) {
        longest.push(cell)
        longest.sort((a, b) => b.length - a.length)
      } else if (cell.length > longest[MEASURED_CELLS - 1]!.length) {
        longest[MEASURED_CELLS - 1] = cell
        longest.sort((a, b) => b.length - a.length)
      }
    }
    const cellWidth = Math.max(0, ...longest.map((cell) => (
      numericColumns[column] ? Math.max(textWidth(cell, 400), cell.length * digitWidth) : textWidth(cell, 400)
    )))
    const headerWidth = textWidth(header[column] || `Column ${column + 1}`, 500) + HEADER_ICON
    return Math.min(MAX_COLUMN_WIDTH, Math.max(MIN_COLUMN_WIDTH, Math.ceil(Math.max(cellWidth, headerWidth) + CELL_CHROME)))
  })
}

interface TableLayout {
  header: string[]
  body: string[][]
  columnCount: number
  numericColumns: boolean[]
  columnWidths: number[]
}

// Derived once per table, as React's memos were: the numeric scan and the
// measuring read every cell.
const layouts = new WeakMap<TablePreviewData, TableLayout>()

function tableLayout(table: TablePreviewData): TableLayout {
  const cached = layouts.get(table)
  if (cached) return cached
  const header = table.rows[0] ?? []
  const body = table.rows.slice(1)
  const columnCount = body.reduce((max, row) => Math.max(max, row.length), header.length)
  const numericColumns = Array.from({ length: columnCount }, (_, column) => {
    // The first column is the row's label, whatever it holds: it reads left.
    if (column === 0) return false
    const cells = body.map((row) => row[column] ?? "").filter((cell) => cell.trim())
    return cells.length > 0 && cells.every((cell) => numericValue(cell) !== null)
  })
  const layout = { header, body, columnCount, numericColumns, columnWidths: measureColumnWidths(header, body, columnCount, numericColumns) }
  layouts.set(table, layout)
  return layout
}

export function tableStateOf(model: Model, slot: string): TableState {
  return model.tables[slot] ?? INITIAL_TABLE
}

/**
 * The empty grid around the table: as many columns and rows as the card has
 * room for. Measured against the scroller the table sits in, again whenever
 * either changes size.
 */
export const MeasureTableFill = Mount.defineStream("ViewerMeasureTableFill", {
  args: { slot: Schema.String, columnCount: Schema.Number },
  messages: [Message.MeasuredTableFill],
  execute: ({ element, slot, columnCount }) =>
    domStream<typeof Message.MeasuredTableFill.Type>((emit) => {
      const wrapper = element as HTMLElement
      const scroller = wrapper.parentElement
      const tableElement = wrapper.querySelector("table")
      if (!scroller || !tableElement) return () => {}
      let last = { columns: 1, rows: 0, clipWidth: 0, height: 0 }
      const measure = () => {
        const lastHeader = tableElement.querySelectorAll(":scope > thead > tr > th")[columnCount - 1] as HTMLElement | undefined
        const tbody = tableElement.querySelector(":scope > tbody")
        if (!lastHeader || !tbody) return
        // Kept but hidden behind "Original": nothing to measure.
        if (tableElement.checkVisibility?.() === false) return
        const top = tableElement.getBoundingClientRect()
        const spareWidth = scroller.clientWidth - (lastHeader.getBoundingClientRect().right - top.left)
        const spareHeight = scroller.clientHeight - (tbody.getBoundingClientRect().bottom - top.top)
        const columns = spareWidth > 0 ? Math.ceil(spareWidth / FILLER_COLUMN_WIDTH) : 1
        const rows = spareHeight > 0 ? Math.ceil(spareHeight / FILLER_ROW_HEIGHT) : 0
        const clipWidth = spareWidth > 0 ? scroller.clientWidth : 0
        const height = scroller.clientHeight
        if (last.columns === columns && last.rows === rows && last.clipWidth === clipWidth && last.height === height) return
        last = { columns, rows, clipWidth, height }
        emit(Message.MeasuredTableFill({ slot, fill: last }))
      }
      measure()
      const observer = new ResizeObserver(measure)
      observer.observe(scroller)
      observer.observe(tableElement)
      return () => observer.disconnect()
    }),
})

/** The next chunk of rows, a frame after this one drew (React's rAF and transition). */
export const DrawRowChunk = Mount.define("ViewerDrawRowChunk", {
  args: { slot: Schema.String, count: Schema.Number },
  messages: [Message.DrewRowChunk],
  execute: ({ slot, count }) => Effect.callback<typeof Message.DrewRowChunk.Type>((resume) => {
    const frame = requestAnimationFrame(() => resume(Effect.succeed(Message.DrewRowChunk({ slot, count: count + ROW_CHUNK }))))
    return Effect.sync(() => cancelAnimationFrame(frame))
  }),
})

function fillerCells(count: number, h: H): Html[] {
  return Array.from({ length: count }, () => h.td([
    h.AriaHidden(true),
    h.Class("border-b border-r border-border/60 p-0"),
    h.Style({ width: `${FILLER_COLUMN_WIDTH}px`, "min-width": `${FILLER_COLUMN_WIDTH}px` }),
  ], []))
}

/**
 * A CSV as a table: sticky header, click a column to sort it (ascending,
 * descending, then back to the file's order), numbers aligned right.
 */
function sortableTable(model: Model, slot: string, table: TablePreviewData, h: H): Html {
  const { header, body, columnCount, numericColumns, columnWidths } = tableLayout(table)
  const state = tableStateOf(model, slot)
  const { sort, fill } = state
  const order = sortedRowOrder(body, sort)
  const renderedCount = state.count
  const pendingRows = Math.max(0, body.length - renderedCount)

  return h.div([
    h.Class(cn(fill.clipWidth > 0 ? "overflow-x-clip" : "min-w-max", fill.rows > 0 && "overflow-y-clip")),
    ...(fill.clipWidth > 0 || fill.rows > 0
      ? [h.Style({
        ...(fill.clipWidth > 0 ? { "max-width": `${fill.clipWidth}px` } : {}),
        ...(fill.rows > 0 ? { "max-height": `${fill.height}px` } : {}),
      })]
      : []),
    h.OnMount(MeasureTableFill({ slot, columnCount })),
  ], [
    h.table([
      h.Class("table-fixed border-collapse text-xs"),
      h.Style({ width: `${columnWidths.reduce((sum, width) => sum + width, 0) + fill.columns * FILLER_COLUMN_WIDTH}px` }),
    ], [
      h.colgroup([], [
        ...columnWidths.map((width) => h.col([h.Style({ width: `${width}px` })])),
        ...Array.from({ length: fill.columns }, () => h.col([h.Style({ width: `${FILLER_COLUMN_WIDTH}px` })])),
      ]),
      h.thead([h.Class("sticky top-0 z-10 bg-background dark:bg-card")], [
        h.tr([], [
          ...Array.from({ length: columnCount }, (_, column) => {
            const active = sort?.column === column
            return h.th([h.Class("p-0 text-left font-medium shadow-[inset_0_-1px_0_hsl(var(--border)),inset_-1px_0_0_hsl(var(--border))]")], [
              h.button([
                h.Type("button"),
                h.OnClick(Message.ClickedSortColumn({ slot, column })),
                h.AriaSort(active ? (sort.direction === "asc" ? "ascending" : "descending") : "none"),
                h.Class(cn(
                  "group/sort flex w-full items-center gap-1 px-3 py-2 transition-colors hover:bg-muted",
                  numericColumns[column] && "justify-end",
                  active ? "text-foreground" : "text-muted-foreground hover:text-foreground",
                )),
              ], [
                h.span([h.Class("truncate")], [header[column] || `Column ${column + 1}`]),
                active
                  ? (sort.direction === "asc" ? ArrowUp({ class: "size-3 shrink-0" }, h) : ArrowDown({ class: "size-3 shrink-0" }, h))
                  : ChevronsUpDown({ class: "size-3 shrink-0 opacity-0 transition-opacity group-hover/sort:opacity-60" }, h),
              ]),
            ])
          }),
          ...Array.from({ length: fill.columns }, () => h.th([
            h.AriaHidden(true),
            h.Class("p-0 shadow-[inset_0_-1px_0_hsl(var(--border)),inset_-1px_0_0_hsl(var(--border))]"),
            h.Style({ width: `${FILLER_COLUMN_WIDTH}px`, "min-width": `${FILLER_COLUMN_WIDTH}px` }),
          ], [])),
        ]),
      ]),
      h.tbody([], [
        // Keyed by its place in the file, so a sort moves the rows' DOM.
        ...order.slice(0, renderedCount).map((index) => {
          const row = body[index]!
          return h.keyed("tr")(`row-${index}`, [h.Class("hover:bg-muted/40")], [
            ...Array.from({ length: columnCount }, (_, column) => h.td([
              h.Class(cn(
                "border-b border-r border-border/60 px-3 py-1.5 align-top text-foreground",
                numericColumns[column] && "text-right tabular-nums",
              )),
            ], [h.div([h.Class("whitespace-pre-wrap break-words")], row[column] ? cellText(row[column]!, h) : [" "])])),
            ...fillerCells(fill.columns, h),
          ])
        }),
        // Holds the rows still to come, so the scrollbar is the table's length from the start.
        pendingRows > 0
          ? h.keyed("tr")("pending", [h.AriaHidden(true)], [
            h.td([h.Colspan(columnCount + fill.columns), h.Class("p-0"), h.Style({ height: `${pendingRows * FILLER_ROW_HEIGHT}px` })], []),
          ])
          : null,
      ]),
      fill.rows > 0
        ? h.tbody([h.AriaHidden(true)], Array.from({ length: fill.rows }, () => h.tr([], [
          ...Array.from({ length: columnCount }, () => h.td([h.Class("border-b border-r border-border/60 px-3 py-1.5")], [h.div([], [" "])])),
          ...fillerCells(fill.columns, h),
        ])))
        : null,
    ]),
    renderedCount < body.length
      ? h.keyed("span")(`chunk:${renderedCount}`, [h.Hidden(true), h.OnMount(DrawRowChunk({ slot, count: renderedCount }))], [])
      : null,
  ])
}

export { FIRST_ROW_CHUNK as INITIAL_ROW_COUNT }
