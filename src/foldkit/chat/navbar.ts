import { Effect, Option } from "effect"
import { Mount } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { FOCUS_FALLBACK_IGNORE_ATTRIBUTE } from "../../client/app/chatFocusPolicy"
import { getProjectSidebarLabel } from "../../client/lib/project-label"
import { flattenSidebarThreads, type SidebarThread } from "../../client/lib/thread-sections"
import { cn } from "../../client/lib/utils"
import { getRepoUrlLabel } from "../../shared/git-url"
import type { SidebarProjectGroup } from "../../shared/types"
import type { AppModel } from "../app/slice"
import * as ChatInput from "../core/stores/chatInput"
import { button, buttonClass } from "../ui/button"
import * as ContextMenu from "../ui/context-menu"
import { ArrowLeft, Check, ChevronDown, Flower, GitBranch, Loader2, MoreHorizontal, PanelLeft, PanelRight, Search, Terminal, UserRoundPlus } from "../ui/icons"
import { projectIcon } from "../ui/project-icon"
import * as Select from "../ui/select"
import * as Tooltip from "../ui/tooltip"
import { delegatedAttentionCount } from "../../client/lib/delegators"
import { chatRowMenuEntries, DelegatorIcon, renderChatRowMenuItem, type ChatRowMenuContext } from "./chatRowMenu"
import { ObserveNavbar, WatchWash } from "./effects"
import { Message, type TooltipId, type WashId } from "./message"
import type { Model } from "./model"
import {
  getOpenAppItems,
  getOpenAppLabel,
  normalizeOpenAppValue,
  openAppIcon,
  openAppMenuEntries,
  openAppMenuItemContent,
  openSelectFallbackValue,
  OPEN_APP_MENU_ITEM_CLASS_NAME,
  renderOpenAppMenuValue,
  type OpenAppValue,
} from "./openExternal"
import type { PageFacts } from "./page"

// ChatNavbar (components/chat-ui/ChatNavbar.tsx), ChatNavbarWash and
// ChatNavbarTitle: the bar over the chat, the viewer's pane and the widget
// column, and the fade what scrolls under it goes into.

type H = HtmlBuilder<Message>

/** Marks the buttons that open a context menu, for `MeasureMenuButton`. */
export const MENU_BUTTON_ATTRIBUTE = "data-chat-menu-button"

function tooltip(model: Model, id: TooltipId, inputs: Omit<Tooltip.ViewInputs, "variant">, h: H): Html {
  return h.submodel({
    slotId: `tooltip-${id}`,
    model: model.tooltips[id],
    view: Tooltip.view,
    viewInputs: { variant: "hotkey", ...inputs },
    toParentMessage: (message) => Message.GotTooltipMessage({ id, message }),
  })
}

// WASH

/**
 * The fade what scrolls under the navbar goes into: the transcript and the
 * widget column each draw their own. It lives with them, not the navbar,
 * because the navbar runs on over the viewer, which starts below it and has
 * nothing to fade. It's as tall as the navbar (`--chat-navbar-h`, measured by
 * the chat page).
 *
 * In the transcript both washes stop at its scrollbar gutter instead of
 * running to the card edge, so the scrollbar isn't dimmed by them — a native
 * scrollbar paints under any later positioned sibling and no z-index can lift
 * it. The widget column hides its scrollbar, so it runs edge to edge.
 *
 * It shows only once something is under it: scrolled to the top, there's
 * nothing to fade and it would only dim the first thing.
 */
export function washView(
  model: Model,
  options: { wash: WashId; resetKey: string | null; stopAtTranscriptScrollbar: boolean; opaqueBar: boolean },
  h: H,
): Html {
  const state = model.washes[options.wash]
  const settling = state.settling
  const scrolled = state.scrolled
  return h.keyed("div")(`wash-${options.wash}-${options.resetKey ?? ""}`, [
    h.Class(cn(
      "absolute top-0 left-0 z-10 h-[100px] pointer-events-none",
      settling ? "transition-none" : "transition-opacity duration-200 ease-out",
      options.stopAtTranscriptScrollbar ? "right-[var(--transcript-scrollbar-w,0px)]" : "right-0",
      // Behind the tabs it is always there: only its fade comes and goes
      // with the scroll (below).
      options.opaqueBar || scrolled ? "opacity-100" : "opacity-0",
    )),
    h.OnMount(WatchWashMount(options.wash, model.washTokens)),
  ], options.opaqueBar
    ? [
      // Solid down to the tabs' bottom edge and no further, then a short fade.
      h.div([h.Class("absolute inset-x-0 top-0 h-[51px] bg-background mac-app:md:h-[calc(var(--mac-traffic-lights-center)+15px)]")], []),
      h.div([h.Class(cn(
        "absolute inset-x-0 top-[51px] h-4 bg-gradient-to-b from-background to-background/0 mac-app:md:top-[calc(var(--mac-traffic-lights-center)+15px)]",
        settling ? "transition-none" : "transition-opacity duration-200 ease-out",
        scrolled ? "opacity-100" : "opacity-0",
      ))], []),
    ]
    : [
      h.div([h.Class("absolute inset-x-0 top-0 h-[var(--chat-navbar-h,53px)] bg-gradient-to-b from-background lg:from-background/0")], []),
      h.div([h.Class("absolute inset-0 bg-gradient-to-b from-background via-background/50 to-background/10 md:to-background/0")], []),
    ])
}

const WatchWashMount = (wash: WashId, token: number) => WatchWash({ wash, token })

// TITLE

/** A clickable part of the title: only its text colour answers the pointer. */
const TITLE_LINK = "min-w-0 truncate transition-colors hover:text-foreground"

/** The sidebar group holding a chat, archived ones included. */
export function groupForChat(app: AppModel, chatId: string): SidebarProjectGroup | undefined {
  return app.stores.sidebar.data.projectGroups.find((item) => (
    item.chats.some((chat) => chat.chatId === chatId)
    || (item.archivedChats ?? []).some((chat) => chat.chatId === chatId)
  ))
}

export function threadForChat(app: AppModel, chatId: string): SidebarThread | undefined {
  const group = groupForChat(app, chatId)
  return group ? flattenSidebarThreads({ projectGroups: [group] }).find((item) => item.chatId === chatId) : undefined
}

export function titleMenuContext(app: AppModel, facts: PageFacts): ChatRowMenuContext | null {
  if (!facts.chatId) return null
  const thread = threadForChat(app, facts.chatId)
  if (!thread) return null
  return {
    thread,
    archived: thread.archived,
    editorLabel: facts.editorLabel,
    hasDraft: ChatInput.chatHasDraft(app.stores.chatInput, thread.chatId),
  }
}

/** The title as shown: the name typed here until the server's catches up. */
export function shownTitle(model: Model, serverTitle: string) {
  return model.title.submitted !== null && model.title.submittedOver === serverTitle ? model.title.submitted : serverTitle
}

/**
 * On the title's field while renaming: takes focus and selects the text on
 * entering it, and keeps its keys and presses to itself (the page's
 * shortcuts are not for a title being typed; selecting text in it is not
 * dragging what holds it).
 */
export const TitleInputMount = Mount.define("ChatTitleInput", {
  messages: [Message.CompletedSideEffect],
  execute: ({ element }) => Effect.gen(function* () {
    const input = element as HTMLInputElement
    const stop = (event: Event) => event.stopPropagation()
    yield* Effect.acquireRelease(
      Effect.sync(() => {
        input.addEventListener("keydown", stop)
        input.addEventListener("pointerdown", stop)
        input.focus()
        input.select()
      }),
      () => Effect.sync(() => {
        input.removeEventListener("keydown", stop)
        input.removeEventListener("pointerdown", stop)
      }),
    )
    return Message.CompletedSideEffect()
  }),
})

/**
 * The chat's title, renamed where it stands: click it and it is a text field
 * in the same type at the same place, so nothing around it moves. Enter or
 * clicking away keeps the new name, Escape drops it.
 */
export function editableTitleView(model: Model, title: string, h: H): Html {
  const draft = model.title.draft
  if (draft === null) {
    return h.span([
      h.Role("button"),
      h.Tabindex(0),
      h.Title("Rename"),
      h.OnClick(Message.ClickedTitle()),
      h.OnKeyDownPreventDefault((key) => (key === "Enter" || key === " " ? Option.some(Message.PressedTitleKey({ key })) : Option.none())),
      h.Class("min-w-0 cursor-text truncate rounded-sm text-sm font-medium outline-none focus-visible:ring-2 focus-visible:ring-ring"),
    ], [shownTitle(model, title)])
  }
  // The hidden copy of the text is what sizes the field, so it is exactly
  // as wide as what's typed and the project beside it follows along.
  return h.span([h.Class("relative inline-grid min-w-[2ch] max-w-full")], [
    h.span([h.AriaHidden(true), h.Class("invisible truncate whitespace-pre text-sm font-medium")], [draft || " "]),
    h.input([
      // The chat's focus keeper sends a stray Escape back to the composer,
      // which would blur this and save what Escape was pressed to drop.
      h.Attribute(FOCUS_FALLBACK_IGNORE_ATTRIBUTE, ""),
      h.Value(draft),
      h.AriaLabel("Chat title"),
      h.OnInput((value) => Message.ChangedTitleDraft({ value })),
      h.OnBlur(Message.BlurredTitle()),
      h.OnKeyDownPreventDefault((key) => (key === "Enter" || key === "Escape" ? Option.some(Message.PressedTitleInputKey({ key })) : Option.none())),
      // The underline is the one sign it is a field: no box, so the title
      // doesn't jump or change size going in and out.
      h.Class("absolute inset-0 w-full min-w-0 bg-transparent text-sm font-medium underline decoration-muted-foreground/50 decoration-1 underline-offset-4 outline-none"),
      h.OnMount(TitleInputMount()),
    ]),
  ])
}

/**
 * The open chat's title, at the left end of the chat navbar: its project's
 * icon, its title, then its project and branch. It stands in for the chat's
 * sidebar row, and so carries that row's right-click menu, which the icon
 * also opens on a click. The block never takes the pointer beyond its own
 * contents, so the rest of the bar still drags the window in the Mac app.
 */
export function navbarTitleView(model: Model, app: AppModel, facts: PageFacts, title: string, branchName: string | undefined, h: H): Html {
  const chatId = facts.chatId!
  const group = groupForChat(app, chatId)
  const repoUrl = group?.repoUrl
  const projectName = group ? getProjectSidebarLabel(group).name : undefined
  const menuContext = titleMenuContext(app, facts)

  const content = (trigger: ReadonlyArray<ChildAttribute>, portal: Html | null) => h.div([
    ...trigger,
    h.Class("pointer-events-auto flex min-w-0 items-center gap-2"),
  ], [
    h.span([h.Class("flex min-w-0 shrink items-center gap-2")], [
      group
        ? h.button([
          h.Type("button"),
          h.Title("Chat actions"),
          h.AriaLabel("Chat actions"),
          h.Attribute(MENU_BUTTON_ATTRIBUTE, "title"),
          h.OnClick(Message.ClickedMenuButton({ id: "title", selector: `[${MENU_BUTTON_ATTRIBUTE}=title]` })),
          h.Class("relative flex shrink-0 rounded-[4px] outline-none transition-transform duration-150 ease-snappy before:absolute before:-inset-1 before:rounded-md before:bg-foreground/10 before:opacity-0 before:transition-opacity before:duration-150 hover:before:opacity-100 focus-visible:before:opacity-100 active:scale-[0.94] motion-reduce:transition-none"),
        ], [projectIcon({ name: group.title, iconUrl: group.iconUrl, class: "relative" }, h)])
        : null,
      editableTitleView(model, title, h),
    ]),
    projectName || branchName
      ? h.span([h.Class("flex min-w-0 shrink-[4] items-center gap-1.5 text-xs text-muted-foreground")], [
        projectName
          ? h.button([h.Type("button"), h.Class(TITLE_LINK), h.Title("Show in Finder"), h.OnClick(Message.ClickedProjectName())], [projectName])
          : null,
        branchName
          ? repoUrl
            ? h.button([
              h.Type("button"),
              h.Class(`${TITLE_LINK} flex items-center gap-0.5`),
              h.Title(`Open on ${getRepoUrlLabel(repoUrl)}`),
              h.OnClick(Message.ClickedBranch({ url: repoUrl })),
            ], [
              GitBranch({ class: "size-3 shrink-0", strokeWidth: 2.25 }, h),
              h.span([h.Class("min-w-0 truncate")], [branchName]),
            ])
            : h.span([h.Class("flex min-w-0 items-center gap-0.5")], [
              GitBranch({ class: "size-3 shrink-0", strokeWidth: 2.25 }, h),
              h.span([h.Class("min-w-0 truncate")], [branchName]),
            ])
          : null,
      ])
      : null,
    portal,
  ])

  return h.div([
    h.Class("pointer-events-none hidden min-w-0 flex-1 translate-y-[9px] items-center md:flex mac-app:md:translate-y-0 transition-[translate] duration-300 ease-glide motion-reduce:transition-none group-data-[sidebar-collapsed]/navbar:translate-y-0"),
  ], [
    menuContext
      ? h.submodel({
        slotId: "title-menu",
        model: model.menus.title,
        view: ContextMenu.view,
        viewInputs: {
          items: chatRowMenuEntries(menuContext),
          renderItem: (value: string) => renderChatRowMenuItem(value, menuContext, h) ?? [],
          toView: ({ trigger, portal }) => content(trigger, portal),
        },
        toParentMessage: (message) => Message.GotMenuMessage({ id: "title", message }),
      })
      : content([], null),
  ])
}

// OPEN IN…

export function openSelectItems(facts: PageFacts) {
  return getOpenAppItems({
    editorPreset: facts.editorPreset,
    isMac: facts.isMac,
    installedEditors: facts.installedEditors,
    installedTerminals: facts.installedTerminals,
    includeFinder: true,
    includeTerminal: true,
    repoUrl: facts.repoUrl,
    menuKind: "navbar",
  })
}

/** What the split button's icon opens: the remembered destination, if still usable. */
export function openSelectLastValue(facts: PageFacts): OpenAppValue {
  const items = openSelectItems(facts)
  const fallback = openSelectFallbackValue(facts.editorPreset, facts.installedEditors, items)
  return normalizeOpenAppValue(facts.rememberedDestination, fallback, facts.installedEditors, facts.installedTerminals)
}

/**
 * OpenExternalSelect: the icon opens where you last opened; the chevron
 * lists the rest.
 */
function openExternalSelectView(model: Model, facts: PageFacts, h: H): Html {
  const items = openSelectItems(facts)
  const lastValue = openSelectLastValue(facts)
  const bindings = facts.keybindings.bindings
  const shortcut = lastValue === "finder" ? bindings.openInFinder : lastValue === `editor:${facts.editorPreset}` ? bindings.openInEditor : undefined
  return h.div([h.Class("grid grid-cols-[1fr_auto]")], [
    tooltip(model, "openIn", {
      side: "bottom",
      content: Tooltip.hotkeyContent({ shortcut }, h),
      toView: ({ trigger, portal }) => button({
        variant: "ghost",
        size: "none",
        class: "border-0 p-1 py-[3px] pr-0 hover:!border-border/0 hover:!bg-transparent",
        attributes: [
          h.OnClick(Message.ClickedOpenPrimary({ value: lastValue })),
          h.Title(`Open in ${getOpenAppLabel(lastValue, facts.isMac)}`),
          ...trigger,
        ],
      }, [openAppIcon(lastValue, facts.isMac, "size-5.5", h), portal], h),
    }, h),
    h.submodel({
      slotId: "open-destination",
      model: model.openSelect,
      view: Select.view,
      viewInputs: {
        value: undefined,
        items: items.map((item) => ({ value: item.value, disabled: !item.installed, className: OPEN_APP_MENU_ITEM_CLASS_NAME, textValue: item.label })),
        renderItem: (value: string) => {
          const item = items.find((candidate) => candidate.value === value)
          return item ? [openAppMenuItemContent(item, facts.isMac, h)] : []
        },
        grouped: true,
        align: "end",
        toView: ({ trigger, portal }) => Select.selectTrigger({
          class: "!h-auto !py-0 !pl-0.5 !pr-1 border-0 bg-transparent hover:bg-transparent focus:ring-0 focus:ring-offset-0 [&>svg]:hidden",
          attributes: [...trigger, h.AriaLabel("Choose open destination")],
        }, [
          h.div([h.Class("flex items-center justify-center size-5")], [ChevronDown({ class: "h-4 w-4 opacity-60" }, h)]),
        ], portal, h),
      },
      toParentMessage: (message) => Message.GotOpenSelectMessage({ message }),
    }),
  ])
}

// OVERFLOW MENU

function overflowMenuEntries(facts: PageFacts): ContextMenu.MenuEntry[] {
  const canExport = Boolean(facts.chatId) && !facts.isExportingStandalone
  return [
    // Below `md` the split button is hidden for want of room, so its
    // destinations ride along here instead of being unreachable. Above it
    // they would be a duplicate of the button sitting alongside.
    ...openAppMenuEntries(openSelectItems(facts), "md:hidden"),
    ContextMenu.separator({ className: "md:hidden" }),
    ...(facts.projectId ? [ContextMenu.item({ value: "toggle-terminal" })] : []),
    ...(facts.chatId ? [ContextMenu.item({ value: "share", disabled: !canExport || facts.isExportingStandalone })] : []),
  ]
}

function renderOverflowItem(value: string, facts: PageFacts, h: H): ReadonlyArray<Html | string> {
  const openApp = renderOpenAppMenuValue(value, openSelectItems(facts), facts.isMac, h)
  if (openApp) return openApp
  if (value === "toggle-terminal") {
    return [Terminal({ class: "h-3.5 w-3.5", strokeWidth: 2 }, h), h.span([h.Class("text-xs font-medium")], ["Toggle Terminal"])]
  }
  return [
    facts.isExportingStandalone
      ? Loader2({ class: "h-3.5 w-3.5 animate-spin" }, h)
      : facts.standaloneShareComplete
        ? Check({ class: "h-3.5 w-3.5 text-emerald-400" }, h)
        : UserRoundPlus({ class: "h-3.5 w-3.5", strokeWidth: 2 }, h),
    h.span([h.Class("text-xs font-medium")], ["Share Chat"]),
  ]
}

function overflowMenuView(model: Model, facts: PageFacts, showOnDesktop: boolean, h: H): Html {
  return h.submodel({
    slotId: "overflow-menu",
    model: model.menus.overflow,
    view: ContextMenu.view,
    viewInputs: {
      items: overflowMenuEntries(facts),
      renderItem: (value: string) => renderOverflowItem(value, facts, h),
      toView: ({ trigger, portal }) => button({
        variant: "ghost",
        size: "none",
        class: cn(
          "border border-border/0 hover:!border-border/0 px-1.5 h-9 max-md:h-[45px] max-md:w-[42px] max-md:px-0 hover:!bg-transparent",
          showOnDesktop ? "flex" : "flex md:hidden",
        ),
        attributes: [
          h.Title("More actions"),
          h.Attribute(MENU_BUTTON_ATTRIBUTE, "overflow"),
          h.OnClick(Message.ClickedMenuButton({ id: "overflow", selector: `[${MENU_BUTTON_ATTRIBUTE}=overflow]` })),
          ...trigger,
        ],
      }, [MoreHorizontal({ strokeWidth: 2, class: "h-4.5 max-md:h-5.5" }, h), portal], h),
    },
    toParentMessage: (message) => Message.GotMenuMessage({ id: "overflow", message }),
  })
}

// A DELEGATOR'S LIST

/**
 * DelegatedListButton: a delegator's way to its pane, the list of the chats
 * under it, just left of the widgets toggle. It opens the pane and shuts it
 * again, and counts the chats under the delegator that want the user. On a
 * phone (`overlay`) there is no pane: the list opens over the transcript,
 * and the button is in the brand colour, as the mark of what the page is.
 */
export function delegatedListButtonView(model: Model, app: AppModel, chatId: string, overlay: boolean, h: H): Html {
  let count = 0
  for (const group of app.stores.sidebar.data.projectGroups) count += delegatedAttentionCount(group.chats, chatId)
  const open = Boolean(app.stores.rightSidebar.chatViewers[chatId])
  const pressed = open && !overlay
  const action = pressed ? "Hide delegated chats" : "Show delegated chats"
  const label = count > 0 ? `${action}, ${count} ${count === 1 ? "wants" : "want"} you` : action
  return h.submodel({
    slotId: "tooltip-delegated",
    model: model.tooltips.delegated,
    view: Tooltip.view,
    viewInputs: {
      side: "bottom",
      content: () => [action],
      toView: ({ trigger, portal }) => button({
        variant: "ghost",
        size: "none",
        class: cn(
          // The box of the buttons beside it (see the terminal and widgets toggles).
          "flex h-9 items-center justify-center gap-1 border border-border/0 px-1.5 hover:!border-border/0 hover:!bg-transparent max-md:h-[45px] max-md:min-w-[42px]",
          overlay ? "text-logo hover:text-logo" : pressed && "text-foreground",
        ),
        attributes: [
          h.AriaLabel(label),
          ...(overlay ? [] : [h.AriaPressed(pressed ? "true" : "false")]),
          h.OnClick(Message.ClickedDelegatedList({ chatId, overlay })),
          ...trigger,
        ],
      }, [
        DelegatorIcon({ strokeWidth: 2, class: "h-4 shrink-0 max-md:h-5 max-md:w-5" }, h),
        count > 0
          ? h.span([h.Class("flex h-[18px] min-w-[18px] items-center justify-center rounded-[5px] bg-foreground/10 px-1 text-xs font-bold leading-none text-foreground tabular-nums")], [String(count)])
          : null,
        portal,
      ], h),
    },
    toParentMessage: (message) => Message.GotTooltipMessage({ id: "delegated", message }),
  })
}

// THE BAR

export interface NavbarSlots {
  /** The bar's left end beside the sidebar: the chat's title, or the open chats as tabs. */
  title: Html | null
  /** Immediately left of the widgets toggle: a delegator's list button. */
  actions: Html | null
}

export function navbarView(model: Model, app: AppModel, facts: PageFacts, slots: NavbarSlots, h: H): Html {
  // New Sidebar mode surfaces search in the sidebar, so the chat navbar only
  // keeps its search button on mobile (where the sidebar is hidden).
  const newSidebar = app.stores.appSettings.settings?.newSidebarEnabled !== false
  const diffs = facts.diffs
  const hasGitRepo = diffs?.status !== "no_repo"
  const gitStatus = diffs?.status ?? "unknown"
  const branchLabel = !hasGitRepo
    ? "Setup Git"
    : gitStatus === "unknown"
      ? null
      : (diffs?.branchName ?? "Detached HEAD")
  const hideBranchLabel = facts.chatTabsEnabled
  const showBranchLabel = Boolean(branchLabel) && !hideBranchLabel
  const widgetsOpen = facts.showRightSidebar
  const rightPanelVisible = widgetsOpen
  const sidebarCollapsed = facts.sidebarCollapsed
  const canExportTranscript = Boolean(facts.chatId) && !facts.isExportingStandalone
  const bindings = facts.keybindings.bindings
  const inert = facts.isMobile && facts.viewerOpen
  const hasProject = Boolean(facts.projectId)

  return h.div([
    // In the Mac app the navbar's bare background drags the window.
    h.DataAttribute("window-drag", "true"),
    ...(inert ? [h.Inert(true)] : []),
    // Read by the title slot, which sits lower while there is a sidebar bar
    // to line up with (ChatTabs, ChatNavbarTitle).
    ...(sidebarCollapsed ? [h.DataAttribute("sidebar-collapsed", "true")] : []),
    h.Class(cn(
      "flex flex-col space-y-1.5 p-2",
      cn(
        "group/navbar absolute top-0 left-0 right-0 z-10 md:pt-[9px] max-md:px-2 md:pl-1 md:pr-2 border-border/0 flex items-center justify-center mac-app:md:pt-0 mac-app:md:pb-0",
        facts.isMobile ? undefined : "z-40",
      ),
    )),
    h.OnMount(ObserveNavbar()),
  ], [
    h.div([h.Class("relative flex items-center gap-2 w-full mac-app:md:h-[calc(var(--mac-traffic-lights-center)*2)]")], [
      h.div([h.Class(cn(
        "md:h-[30px] flex items-center gap-0 flex-shrink-0 border border-border/0 rounded-[9px] md:px-[2px]",
        // Unbordered: the flower and expand button stand on their own. The
        // app pins its sidebar toggle beside the traffic lights and
        // back/forward (KannaSidebar); clear them.
        sidebarCollapsed && "px-1.5 mac-app:md:ml-[calc(var(--mac-traffic-lights-inset)+88px)]",
      ))], [
        button({
          variant: "ghost",
          size: "icon",
          class: "md:hidden h-[45px] w-[42px] hover:!border-border/0 hover:!bg-transparent",
          attributes: [h.OnClick(Message.ClickedBack()), h.Title("Back")],
        }, [ArrowLeft({ class: "size-5" }, h)], h),
        ...(sidebarCollapsed
          ? [
            // Both fade in as the sidebar slides away (KannaSidebar).
            h.div([h.Class("hidden md:flex items-center justify-center w-[36px] h-[36px] mac-app:md:hidden transition-opacity duration-200 ease-out starting:opacity-0")], [
              Flower({ class: "h-4 w-4 sm:h-5 sm:w-5 text-logo ml-1 hidden md:block" }, h),
            ]),
            button({
              variant: "ghost",
              size: "icon",
              class: "hidden md:flex  hover:!border-border/0 hover:!bg-transparent mac-app:md:hidden transition-opacity duration-200 ease-out starting:opacity-0",
              attributes: [h.OnClick(Message.ClickedExpandSidebar()), h.Title("Expand sidebar")],
            }, [PanelLeft({ class: "size-4" }, h)], h),
          ]
          : []),
        button({
          variant: "ghost",
          size: "icon",
          class: cn("max-md:h-[45px] max-md:w-[42px] hover:!border-border/0 hover:!bg-transparent", newSidebar && "md:hidden"),
          attributes: [h.OnClick(Message.ClickedSearch()), h.Title("Search")],
        }, [Search({ class: "size-4 max-md:size-5" }, h)], h),
      ]),

      // In the row's flow, so it starts after whatever the left group is
      // holding. It is the row's flexible middle, taking what the buttons
      // leave. Desktop only (it hides itself under `md`), so the spacer
      // stays for a phone, and for a page with no chat to title.
      slots.title,
      h.div([h.Class(cn("min-w-0 flex-1", slots.title ? "md:hidden" : null))], []),

      facts.navbarLocalPath
        ? h.div([h.Class("flex items-center gap-2 flex-shrink-0")], [
          h.div([h.Class("hidden md:block border border-border/70 rounded-[9px] backdrop-blur-lg")], [
            openExternalSelectView(model, facts, h),
          ]),
          h.div([h.Class("flex items-center  rounded-[9px] h-[30px]")], [
            overflowMenuView(model, facts, rightPanelVisible, h),
            hasProject
              ? tooltip(model, "terminal", {
                side: "bottom",
                content: Tooltip.hotkeyContent({ shortcut: bindings.toggleEmbeddedTerminal }, h),
                toView: ({ trigger, portal }) => button({
                  variant: "ghost",
                  size: "none",
                  class: cn(
                    rightPanelVisible ? "hidden" : "hidden md:flex",
                    "border border-border/0 hover:!border-border/0 px-1.5 h-9 hover:!bg-transparent",
                    facts.showTerminalPane && "text-foreground",
                  ),
                  attributes: [h.OnClick(Message.ClickedToggleTerminal()), ...trigger],
                }, [Terminal({ strokeWidth: 2, class: "h-4" }, h), portal], h),
              }, h)
              : null,
            facts.chatId
              ? button({
                variant: "ghost",
                size: "none",
                disabled: !canExportTranscript || facts.isExportingStandalone,
                class: cn(
                  rightPanelVisible ? "hidden" : "hidden md:flex",
                  "border border-border/0 hover:!border-border/0 px-1.5 h-9 hover:!bg-transparent disabled:opacity-50",
                ),
                attributes: [h.OnClick(Message.ClickedShareChat()), h.Title("Share chat"), h.AriaLabel("Share chat")],
              }, [
                facts.isExportingStandalone
                  ? Loader2({ class: "h-4 animate-spin" }, h)
                  : facts.standaloneShareComplete
                    ? Check({ class: "h-4 text-emerald-400" }, h)
                    : UserRoundPlus({ strokeWidth: 2, class: "h-4" }, h),
              ], h)
              : null,
            slots.actions,
            hasProject
              ? tooltip(model, "widgets", {
                side: "bottom",
                content: Tooltip.hotkeyContent({ shortcut: bindings.toggleRightSidebar }, h),
                toView: ({ trigger, portal }) => button({
                  variant: "ghost",
                  size: "none",
                  class: cn(
                    // Open, the padding centers the icon (24px wide: only
                    // its height is set) in 38px. It moves with the branch
                    // label below, on the label's timing, so the button
                    // shrinks and grows as one.
                    "border flex flex-row items-center justify-center h-9 max-md:h-[45px] max-md:w-[42px] max-md:px-0 border-border/0 hover:!border-border/0 hover:!bg-transparent",
                    "transition-[color,background-color,border-color,padding] ease-snappy motion-reduce:transition-colors",
                    widgetsOpen ? "min-w-[38px] px-1.5 text-foreground duration-150" : "pl-1.5 pr-2 duration-200",
                  ),
                  attributes: [
                    h.OnClick(Message.ClickedToggleWidgets()),
                    h.AriaLabel(widgetsOpen ? "Hide widgets" : "Show widgets"),
                    h.AriaPressed(widgetsOpen ? "true" : "false"),
                    ...trigger,
                  ],
                }, [
                  PanelRight({ strokeWidth: 2.25, class: "h-4 shrink-0 max-md:h-5 max-md:w-5" }, h),
                  // The branch rides on the closed button so it stays visible
                  // at a glance; open, the Changes widget shows it. It folds
                  // away as the column opens and unfolds as it closes.
                  showBranchLabel
                    ? h.span([
                      ...(widgetsOpen ? [h.AriaHidden(true)] : []),
                      h.Class(cn(
                        "hidden md:grid transition-[grid-template-columns,opacity] ease-snappy motion-reduce:transition-opacity",
                        widgetsOpen ? "grid-cols-[0fr] opacity-0 duration-150" : "grid-cols-[1fr] opacity-100 duration-200",
                      )),
                    ], [
                      h.span([h.Class("min-w-0 overflow-hidden")], [
                        h.span([h.Class("block w-max max-w-[140px] truncate pl-1.5 font-[13px]")], [branchLabel ?? ""]),
                      ]),
                    ])
                    : null,
                  portal,
                ], h),
              }, h)
              : null,
          ]),
        ])
        : null,
    ]),
  ])
}

export { buttonClass }
