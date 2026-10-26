import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { openAppMenuEntries, renderOpenAppMenuValue } from "../chat/openExternal"
import * as ContextMenu from "../ui/context-menu"
import { TRANSCRIPT_PADDING_BOTTOM_OFFSET } from "../../client/app/kannaStateHelpers"
import { TRANSCRIPT_ROW_CLASS } from "../../client/components/messages/transcript-row"
import { cn } from "../../client/lib/utils"
import { ArrowDown, Upload } from "../ui/icons"
import * as Messages from "./messages"
import { messageNamingParent } from "./messages"
import { Message } from "./message"
import { chatCardHoverCard, liveChatCard } from "./chatCard"
import * as ScheduleCard from "../widgets/scheduleCard"
import { minimapView } from "./minimap"
import type { Model } from "./model"
import { feedOf, linkMenuItems, rowsOf, turnsOf, type LinkMenuSource, type TranscriptSource } from "./source"
import { ControlViewport, FEED_ATTRIBUTE, VIEWPORT_KEY_ATTRIBUTE } from "./viewport"

// ChatTranscriptViewport's DOM (src/client/app/ChatPage/ChatTranscriptViewport.tsx)
// with the message-scroller parts it is built from
// (src/client/components/ui/message-scroller.tsx and the primitive's own
// attributes): the scroller, its header (the parent chat's link, Load
// More), the rows, its footer (processing, the queue, the error), then the
// minimap, the local-link menu's trigger, the empty state, the drop overlay
// and the scroll-to-bottom button.

type H = HtmlBuilder<Message>

/** The usage-limit resume row's busy key (Messages.settledResume). */
export const RESUME_KEY = "usage-limit"

/**
 * Whether a row lights its own shape rather than the box around it: only a
 * user prompt, a bubble hugging one side of the column.
 */
function rowLightsItself(row: Messages.TranscriptRow): boolean {
  return row.kind === "single" && row.message.kind === "user_prompt"
}

function messagesItem(model: Model, slotId: string, source: TranscriptSource, item: Messages.Item, h: H): Html {
  const references = source.references
  return h.submodel({
    slotId,
    model: model.messages,
    view: Messages.view,
    viewInputs: {
      item,
      options: source.options,
      ...(references
        ? {
          canOpenChats: true,
          sidebarThread: references.sidebarThread,
          sidebarReady: references.sidebarReady,
          currentProjectId: source.currentProjectId,
          schedules: references.schedules,
          renderChatCard: (card: Messages.LiveChatCard) => liveChatCard(model, references.app, card, Date.now(), h),
          renderScheduleCard: (card: Messages.LiveScheduleCard) => h.submodel({
            slotId: `schedule-card-${card.schedule.id}`,
            model: model.scheduleCards[card.schedule.id] ?? ScheduleCard.init(card.schedule.id),
            view: ScheduleCard.view,
            viewInputs: {
              card,
              currentChatId: references.schedules.chatId,
              now: Date.now(),
              chatTitle: (chatId: string) => references.sidebarThread(chatId)?.title,
              canOpenChats: true,
            },
            toParentMessage: (message: ScheduleCard.Message) => Message.GotScheduleCardMessage({ scheduleId: card.schedule.id, message }),
          }),
        }
        : {}),
    },
    toParentMessage: (message: Messages.Message) => Message.GotMessagesMessage({ message }),
  })
}

/**
 * The local link's right-click menu (OpenExternalContextMenuContent): where
 * to open the file. Opened by update at the link, as React re-dispatched the
 * contextmenu event on its trigger.
 */
function linkMenuSubmodel(
  model: Model,
  menu: LinkMenuSource,
  trigger: (attributes: ReadonlyArray<ChildAttribute>, portal: Html | null) => Html,
  h: H,
): Html {
  const items = linkMenuItems(menu)
  return h.submodel({
    slotId: "link-menu",
    model: model.linkMenu,
    view: ContextMenu.view,
    viewInputs: {
      items: model.linkMenuTarget ? openAppMenuEntries(items) : [],
      className: "rounded-lg p-1",
      renderItem: (value: string) => renderOpenAppMenuValue(value, items, menu.isMac, h) ?? [],
      toView: ({ trigger: attributes, portal }: ContextMenu.RenderInfo) => trigger(attributes, model.linkMenuTarget ? portal : null),
    },
    toParentMessage: (message: ContextMenu.Message) => Message.GotLinkMenuMessage({ message }),
  })
}

export interface ViewOptions {
  /** The new chat page's empty state, drawn by the chat page (`page.showEmptyState`). */
  emptyState?: () => Html
}

export function transcriptView(model: Model, source: TranscriptSource, options: ViewOptions, h: H): Html {
  const rows = rowsOf(source)
  const feed = feedOf(source, rows, model)
  const header = source.headerOffsetPx
  const flashRowId = model.flash?.raised ? model.flash.rowId : null

  // A sub-chat's way back to its parent is the quote on its opening message;
  // where that message is not loaded, the same quote stands alone first.
  const showsParentLink = source.parentChatId !== null && messageNamingParent(source.messages as never, source.parentChatId, source.hasOlder) === null

  const listHeader = h.keyed("div")("list-header", [h.Style({ "padding-top": `${header}px` })], [
    source.parentChatId && showsParentLink
      ? h.div([h.Class("mx-auto flex w-full max-w-[816px] justify-start px-2 pb-3 pt-1")], [
        messagesItem(model, "parent-chat-link", source, { kind: "parent-chat-link", parentChatId: source.parentChatId }, h),
      ])
      : null,
    h.div([h.Class("mx-auto w-full max-w-[800px]")], [
      source.hasOlder
        ? h.div([h.Class("flex justify-center px-2 pb-3 pt-1")], [
          h.button([
            h.Type("button"),
            h.OnClick(Message.ClickedLoadMore()),
            h.Disabled(source.isLoadingOlder),
            h.Class("rounded-full border border-border bg-surface px-3 py-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:opacity-60"),
          ], [source.isLoadingOlder ? "Loading…" : "Load More"]),
        ])
        : null,
    ]),
  ])

  const rowItems = rows.map((row) => {
    const lit = flashRowId === row.id
    return h.keyed("div")(row.id, [
      h.DataAttribute("message-id", row.id),
      h.DataAttribute("scroll-anchor", "false"),
      h.DataAttribute("slot", "message-scroller-item"),
      h.Class("min-w-0 shrink-0"),
    ], [
      h.div([h.Class(cn(TRANSCRIPT_ROW_CLASS, lit && !rowLightsItself(row) && "kanna-jump-flash")), h.DataAttribute("transcript-row-id", row.id)], [
        messagesItem(model, row.id, source, { kind: "row", row, flash: lit && rowLightsItself(row) }, h),
      ]),
    ])
  })

  const listFooter = h.keyed("div")("list-footer", [h.Class("mx-auto w-full max-w-[816px] px-2")], [
    // A chat waiting on a subagent is not processing, nor finished; this
    // line says so. A draining stream says it with its own, below.
    source.isProcessing || (source.runtimeStatus === "waiting_on_subagent" && !source.isDraining)
      ? messagesItem(model, "processing", source, { kind: "processing", ...(source.runtimeStatus ? { status: source.runtimeStatus } : {}), ...(source.waitingOn ? { waitingOn: source.waitingOn } : {}) }, h)
      : null,
    // Goes before the queue it holds: the "carry on" is sent first.
    source.usageLimitResume && source.canResume
      ? messagesItem(model, "usage-limit", source, { kind: "usage-limit", resume: source.usageLimitResume, key: RESUME_KEY }, h)
      : null,
    ...source.queued.map((message) => messagesItem(model, `queued:${message.id}`, source, { kind: "queued", message }, h)),
    !source.isProcessing && source.isDraining ? messagesItem(model, "draining", source, { kind: "draining" }, h) : null,
    source.commandError
      ? h.div([h.Class("rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive")], [source.commandError])
      : null,
  ])

  const scroller = h.div([
    h.DataAttribute("slot", "message-scroller"),
    h.Class(cn("group/message-scroller relative flex size-full min-h-0 flex-col overflow-hidden", "h-full flex-1")),
    h.OnMount(ControlViewport()),
  ], [
    h.div([
      h.DataAttribute("slot", "message-scroller-viewport"),
      h.Role("region"),
      h.AriaLabel("Messages"),
      h.Tabindex(0),
      h.DataAttribute("navbar-scroller", ""),
      h.Attribute(VIEWPORT_KEY_ATTRIBUTE, source.viewportKey),
      h.Attribute(FEED_ATTRIBUTE, JSON.stringify(feed)),
      h.Class(cn("size-full min-h-0 min-w-0 overflow-y-auto overscroll-contain", "h-full overflow-x-hidden overscroll-y-contain px-3 scrollbar-hide")),
      h.Style({ "scroll-padding-top": `${header}px` }),
    ], [
      h.div([
        h.DataAttribute("slot", "message-scroller-content"),
        h.Role("log"),
        h.AriaRelevant("additions"),
        h.Class(cn("flex h-max flex-col")),
        h.Style({ "padding-bottom": `${source.transcriptPaddingBottom + 10}px` }),
      ], [
        listHeader,
        ...rowItems,
        listFooter,
        // The registry's trailing spacer, held at zero height (`hidden`).
        h.keyed("div")("spacer", [h.AriaHidden(true), h.DataAttribute("message-scroller-spacer", ""), h.Hidden(true), h.Class("hidden")], []),
      ]),
    ]),
  ])

  const insetBottom = Math.max(0, source.transcriptPaddingBottom - TRANSCRIPT_PADDING_BOTTOM_OFFSET)

  const minimap = source.showEmptyState ? null : minimapView(model.minimap, {
    turns: turnsOf(source, rows),
    visibleStart: model.visibleRange?.start ?? -1,
    visibleEnd: model.visibleRange?.end ?? -1,
    transcriptOverflows: model.overflows,
    topPx: header,
    // Match the empty state: the padding carries clearance overlays should not.
    bottomPx: insetBottom,
    containerWidthPx: model.viewportWidth,
  }, h)

  // The local-link menu's trigger: a 1px point the menu opens at.
  const linkMenuTrigger = (trigger: ReadonlyArray<ChildAttribute>, portal: Html | null) => h.span([
    ...trigger,
    h.AriaHidden(true),
    h.Class("pointer-events-none fixed size-px opacity-0"),
    h.Style({ left: `${model.linkMenuTarget?.clientX ?? 0}px`, top: `${model.linkMenuTarget?.clientY ?? 0}px` }),
  ], portal ? [portal] : [])
  const linkMenu = source.linkMenu
  const linkMenuView = linkMenu
    ? linkMenuSubmodel(model, linkMenu, linkMenuTrigger, h)
    : linkMenuTrigger([], null)

  const dropOverlay = source.isPageFileDragActive
    ? h.div([h.Class("pointer-events-none absolute inset-0 z-30")], [
      h.div([h.Class("absolute inset-0 backdrop-blur-sm")], []),
      h.div([h.Class("absolute inset-6 ")], [
        h.div([h.Class("flex h-full items-center justify-center")], [
          h.div([h.Class("flex flex-col items-center justify-center gap-3 text-center")], [
            Upload({ class: "mx-auto size-14 text-foreground", strokeWidth: 1.75 }, h),
            h.div([h.Class("text-xl font-medium text-foreground")], ["Drop up to 10 files"]),
          ]),
        ]),
      ]),
    ])
    : null

  const scrollButton = h.div([
    h.Style({ bottom: `${source.transcriptPaddingBottom - 20}px` }),
    h.Class(cn(
      "absolute left-1/2 z-10 -translate-x-1/2 transition-all",
      source.showScrollButton
        ? "scale-100 duration-300 ease-[cubic-bezier(0.34,1.56,0.64,1)]"
        : "pointer-events-none scale-60 opacity-0 blur-sm duration-300 ease-out",
    )),
  ], [
    h.button([
      h.OnClick(Message.ClickedScrollToBottom()),
      h.Class("flex aspect-square cursor-pointer items-center gap-1.5 rounded-full border border-border bg-white px-2 text-sm text-primary transition-colors hover:bg-muted hover:text-foreground dark:border-slate-600 dark:bg-slate-700 dark:text-slate-100 dark:hover:bg-slate-600"),
    ], [ArrowDown({ class: "h-5 w-5" }, h)]),
  ])

  // React drew these as a fragment in CardContent; `contents` keeps them its
  // children for layout. Keyed by chat, as React keyed the viewport: a switch
  // replaces the whole list, and its scroll state starts over.
  return h.keyed("div")(`transcript:${source.chatId ?? "none"}`, [h.Class("contents")], [
    scroller,
    minimap,
    linkMenuView,
    source.showEmptyState && options.emptyState ? options.emptyState() : null,
    dropOverlay,
    scrollButton,
    // Beneath the live chat card the pointer is on; moves itself to <body>.
    source.references ? chatCardHoverCard(model, source.references.app, Date.now(), h) : null,
  ])
}
