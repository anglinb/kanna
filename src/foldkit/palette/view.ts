import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { FOCUS_FALLBACK_IGNORE_ATTRIBUTE } from "../../client/app/chatFocusPolicy"
import { cn } from "../../client/lib/utils"
import type { AppModel, SliceViewInputs } from "../app/slice"
import { ArrowLeft, Search } from "../ui/icons"
import { block, inputView, listView, rootView } from "./cmdk"
import { CONTENT_ID } from "./commands"
import { derive, type PaletteData } from "./derive"
import { Message } from "./message"
import type { Model } from "./model"
import { BROWSE_FOOTER_ID, COPY_FOOTER_ID, PaletteContent, PaletteList, PaletteRoot } from "./mounts"
import * as Usage from "./usage"

// CommandPalette's markup: ui/command.tsx's CommandDialog (Radix Dialog
// content, no overlay) around cmdk's Command, Input and List, the page's
// rows (derive.ts), and the footer.

const TITLE_ID = `${CONTENT_ID}-title`
const DESCRIPTION_ID = `${CONTENT_ID}-description`

const handlers = {
  hovered: (value: string) => Message.HoveredItem({ value }),
  clicked: (value: string) => Message.ClickedItem({ value }),
}

function footerView(data: PaletteData, h: HtmlBuilder<Message>): Html | null {
  const target = data.footerBrowseTarget
  if (target) {
    // Browse pages: a real (tappable) "Open <highlighted>" button — ⌘↵ is
    // its keyboard twin.
    return h.div([
      h.Id(BROWSE_FOOTER_ID),
      h.Class("absolute inset-x-0 bottom-0 flex h-9 items-center justify-end rounded-b-xl border-t border-border bg-popover px-2"),
    ], [
      h.button([
        h.Type("button"),
        h.Class("flex items-center gap-2 rounded-md px-2 py-1 text-xs text-muted-foreground transition-colors hover:bg-muted hover:text-foreground"),
        h.OnClick(Message.ClickedBrowseFooter()),
      ], [
        h.span([h.Class("tracking-widest")], [data.isMac ? "⌘↵" : "CTRL+↵"]),
        h.span([h.Class("max-w-[260px] truncate text-foreground")], [target.create ? `Create ${target.name}` : `Open ${target.name}`]),
      ]),
    ])
  }
  if (data.footerCopyPath) {
    // Overlays the list bottom (absolute within the dialog) so it never
    // grows the palette; the list gets matching bottom padding.
    return h.div([
      h.Id(COPY_FOOTER_ID),
      h.Class("pointer-events-none absolute inset-x-0 bottom-0 flex h-9 items-center justify-between rounded-b-xl border-t border-border bg-popover px-3.5 text-xs text-muted-foreground"),
    ], [
      h.span([], ["Copy path"]),
      h.span([], [data.isMac ? "⌘C" : "CTRL+C"]),
    ])
  }
  return null
}

function paletteView(model: Model, app: AppModel, h: HtmlBuilder<Message>): Html {
  const data = derive(model, app)
  const state = model.phase === "Open" ? "open" : "closed"
  const footerVisible = Boolean(data.footerCopyPath) || Boolean(data.footerBrowseTarget)
  const nodes = data.page === "usage"
    ? [block<Message>("usage", (builder) => Usage.view(model.usage, (message) => Message.GotUsageMessage({ message }), builder)), ...data.nodes]
    : data.nodes
  return h.keyed("div")("command-palette", [
    h.Role("dialog"),
    h.Id(CONTENT_ID),
    h.AriaDescribedBy(DESCRIPTION_ID),
    h.AriaLabelledBy(TITLE_ID),
    h.DataAttribute("state", state),
    h.Attribute(FOCUS_FALLBACK_IGNORE_ATTRIBUTE, ""),
    h.Class(cn(
      "fixed left-1/2 top-[16%] z-50 w-[calc(100%-2rem)] max-w-xl -translate-x-1/2 overflow-hidden rounded-xl border border-border bg-popover p-0 shadow-2xl",
      "duration-200 data-[state=open]:animate-in data-[state=closed]:animate-out data-[state=closed]:fade-out-0 data-[state=open]:fade-in-0 data-[state=closed]:zoom-out-95 data-[state=open]:zoom-in-95",
    )),
    h.Tabindex(-1),
    h.OnMount(PaletteContent()),
  ], [
    h.h2([h.Id(TITLE_ID), h.Class("sr-only")], ["Command Palette"]),
    h.p([h.Id(DESCRIPTION_ID), h.Class("sr-only")], ["Type a command or search…"]),
    rootView([h.OnMount(PaletteRoot())], [
      inputView({
        value: model.query,
        placeholder: data.placeholder,
        disabled: data.locked,
        selected: data.selected,
        onInput: (value) => Message.ChangedQuery({ value }),
        onBack: data.canPop ? Message.ClickedBack() : null,
        searchIcon: Search({ class: "h-4 w-4 shrink-0 text-muted-foreground" }, h),
        backIcon: ArrowLeft({ class: "h-4 w-4" }, h),
      }, h),
      // When the copy-path footer overlays the list bottom, items need a
      // matching scroll-margin: cmdk scrolls the selected item with
      // block:'nearest', which stops at the scrollport edge.
      listView({
        nodes,
        selected: data.selected,
        empty: data.empty,
        ...(footerVisible ? { className: "pb-[42px] [&_[cmdk-item]]:scroll-mb-[42px]" } : {}),
        handlers,
        attributes: [h.OnMount(PaletteList())],
      }, h),
      footerView(data, h),
    ], h),
  ])
}

export const view = Submodel.defineView<Model, Message, SliceViewInputs>((model, { app }, h) =>
  // `contents`: no box of its own. The palette moves itself to <body>.
  h.div([h.Class("contents")], [
    model.phase === "Closed" ? null : paletteView(model, app, h),
  ]),
)
