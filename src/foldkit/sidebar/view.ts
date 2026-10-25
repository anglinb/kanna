import { Option } from "effect"
import { Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { getSidebarNumberJumpHint } from "../../client/app/sidebarNumberJump"
import { formatActionShortcut } from "../../client/lib/keybindings"
import { cn } from "../../client/lib/utils"
import { APP_NAME } from "../../shared/branding"
import { isNightlyVersion, type UpdateSnapshot } from "../../shared/types"
import type { SliceViewInputs } from "../app/slice"
import * as SidebarView from "../core/stores/sidebarView"
import { buttonClass } from "../ui/button"
import {
  ArrowLeft,
  ArrowRight,
  ChevronLeft,
  Flower,
  Folder,
  Hash,
  House,
  ListFilter,
  Loader2,
  MessageCircle,
  PanelLeft,
  Plus,
  Search,
  Settings,
  Settings2,
  SquarePen,
  Terminal,
  Archive,
} from "../ui/icons"
import { kbd } from "../ui/kbd"
import * as Popover from "../ui/popover"
import {
  activeChatId,
  appSettings,
  currentProjectId,

  focusedProjectGroup,
  isConnecting,
  isLocalProjectsActive,
  isRootActive,
  isSettingsActive,
  newSidebarEnabled,
  resolvedKeybindings,
  sidebarData,
  threads,
  visibleChats,
  visibleProjectGroups,
} from "./derived"
import { archivedChatsDialog } from "./dialogs"
import { inputPopoverTriggerClass, popoverMenuItem } from "./view-parts"
import { channelList } from "./channels"
import { chatHoverCard, LIST_HOVER_ATTRIBUTE, ListHoverTracker } from "./hoverCard"
import { connectionLoadNeeded, machineSwitcher, pairSessionEnabled } from "./machine"
import { rowMenu } from "./menus"
import { Message } from "./message"
import type { Model } from "./model"
import { localProjectsSection } from "./projects"
import { archivedSection, threadSections } from "./sections"
import { FocusMotion, SIDEBAR_PAGE_ATTRIBUTE } from "./motion"
import { SidebarCard } from "./mounts"

type H = HtmlBuilder<Message>

// KannaSidebar.tsx: the card, its header, the list under it, the footer and
// the resize handle; the collapsed sidebar's expand button; the Mac app's
// window buttons; the project's archived chats dialog.

/** Header pill words: trimmed to the cap height so the caps center in the pill. */
const PILL_WORD = "block leading-none -mr-[0.05em] [text-box:trim-both_cap_alphabetic]"

const VERSION_PILL_TONES = {
  dev: "border-border bg-muted text-muted-foreground",
  update: "bg-logo/20 border-logo/20 text-logo hover:bg-logo hover:text-foreground",
  nightly: "bg-blue-500/15 border-blue-500/25 text-blue-600 hover:bg-blue-500 hover:text-white hover:border-blue-500 dark:text-blue-400 dark:hover:text-white",
} as const

/** The DEV / UPDATE / NIGHTLY pill: one shape, the tone sets text and color. */
function versionPill(options: { tone: keyof typeof VERSION_PILL_TONES; label: string; busy?: boolean; title?: string; onClick?: Message }, h: H): Html {
  const className = cn(
    "inline-flex h-5 shrink-0 items-center justify-center whitespace-nowrap rounded-full border px-2 text-[11px] font-bold uppercase tracking-wider transition-colors",
    VERSION_PILL_TONES[options.tone],
  )
  const content = [
    options.busy ? Loader2({ class: "mr-1.5 h-3 w-3 animate-spin" }, h) : null,
    h.span([h.Class(PILL_WORD)], [options.label]),
  ]
  // Without an action it is a label, not a button.
  if (!options.onClick) return h.span([h.Class(className), ...(options.title !== undefined ? [h.Title(options.title)] : [])], content)
  return h.button([
    h.Type("button"),
    ...(options.busy ? [h.Disabled(true)] : []),
    h.OnClick(options.onClick),
    ...(options.title !== undefined ? [h.Title(options.title)] : []),
    h.Class(cn(className, "cursor-pointer focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 ring-offset-background disabled:pointer-events-none")),
  ], content)
}

function versionBadge(updateSnapshot: UpdateSnapshot | null, h: H): Html | null {
  const showNightlyUpdate = isNightlyVersion(updateSnapshot?.currentVersion ?? "")
    && updateSnapshot?.nightly?.status === "available"
  const showUpdateButton = showNightlyUpdate || updateSnapshot?.updateAvailable === true
  const showDevBadge = updateSnapshot ? updateSnapshot.latestVersion === `${updateSnapshot.currentVersion}-dev` : false
  const isUpdating = updateSnapshot?.status === "updating" || updateSnapshot?.status === "restart_pending"
  if (showDevBadge) return versionPill({ tone: "dev", label: "Dev", title: "Development build" }, h)
  if (showNightlyUpdate) {
    return versionPill({
      tone: "nightly",
      label: "Nightly",
      busy: isUpdating,
      onClick: Message.ClickedLink({ path: "/settings/labs#nightlyBuilds" }),
      title: "New nightly available. Open Labs to build latest main.",
    }, h)
  }
  if (showUpdateButton) {
    return versionPill({
      tone: "update",
      label: "Update",
      busy: isUpdating,
      onClick: Message.ClickedLink({ path: "/settings/changelog" }),
      title: updateSnapshot?.latestVersion ? `Update to ${updateSnapshot.latestVersion}` : "Update Kanna",
    }, h)
  }
  return null
}

/** `<Button variant="ghost" size="icon">`. */
function ghostIconButton(options: { key?: string; class: string; title?: string; ariaLabel?: string; onClick: Message; disabled?: boolean }, children: ReadonlyArray<Html>, h: H): Html {
  const attributes = [
    h.Class(buttonClass({ variant: "ghost", size: "icon", class: options.class })),
    ...(options.disabled ? [h.Disabled(true)] : []),
    h.OnClick(options.onClick),
    ...(options.title !== undefined ? [h.Title(options.title)] : []),
    ...(options.ariaLabel !== undefined ? [h.AriaLabel(options.ariaLabel)] : []),
  ]
  return options.key ? h.keyed("button")(options.key, attributes, children) : h.button(attributes, children)
}

/** FocusModePill: the focused project in the logo's place, with a back chevron. */
function focusModePill(options: { projectTitle: string; shortcutHint: string | null; class: string }, h: H): Html {
  return h.button([
    h.Type("button"),
    h.OnClick(Message.ClickedExitFocus()),
    h.Title(options.shortcutHint ? `Exit focus mode (${options.shortcutHint})` : "Exit focus mode"),
    h.AriaLabel(`Exit focus mode: ${options.projectTitle}`),
    h.Class(cn(
      "flex min-w-0 items-center gap-1.5 text-sm max-md:text-base font-medium text-foreground transition-colors hover:text-muted-foreground",
      options.class,
    )),
  ], [
    ChevronLeft({ class: "size-5 shrink-0" }, h),
    h.span([h.Class("min-w-0 truncate")], [options.projectTitle]),
  ])
}

const VIEW_OPTIONS: ReadonlyArray<{ view: SidebarView.SidebarView; label: string; icon: typeof MessageCircle }> = [
  { view: "recents", label: "Chats", icon: MessageCircle },
  { view: "projects", label: "Projects", icon: Folder },
  { view: "channels", label: "Channels", icon: Hash },
  { view: "archived", label: "Archived", icon: Archive },
]

/** SidebarViewSwitcher: the Chats / Projects / Channels / Archived filter at the New Chat row's end. */
function viewSwitcher(model: Model, view: SidebarView.SidebarView, h: H): Html {
  return h.submodel({
    slotId: "sidebar-view-switcher",
    model: model.viewSwitcher,
    view: Popover.view,
    viewInputs: {
      align: "end",
      className: "w-64 overflow-hidden p-0",
      content: () => [
        h.div([h.Class("max-h-80 overflow-y-auto divide-y divide-border/60")], VIEW_OPTIONS.map((option) =>
          popoverMenuItem({
            onClick: Message.ChoseSidebarView({ view: option.view }),
            selected: view === option.view,
            icon: option.icon({ class: "h-4 w-4" }, h),
            label: [option.label],
          }, h))),
      ],
      toView: ({ trigger, portal }) => h.button([
        ...trigger,
        h.Class(inputPopoverTriggerClass(cn(
          buttonClass({ variant: "ghost", size: "icon" }),
          "-mr-[3px] h-8 w-auto rounded-lg py-0 pl-1.5 pr-3 hover:!border-border/0 hover:!bg-transparent mac-app:md:pr-1.5",
        ))),
      ], [ListFilter({ class: "size-4 shrink-0" }, h), portal]),
    },
    toParentMessage: (message) => Message.GotViewSwitcherMessage({ message }),
  })
}

function skeleton(h: H): Html {
  return h.keyed("div")("skeleton", [h.Class("space-y-5 px-1 pt-3")], [0, 1, 2].map((section) =>
    h.keyed("div")(String(section), [h.Class("space-y-2 animate-pulse")], [
      h.div([h.Class("h-4 w-28 rounded bg-muted")]),
      h.div([h.Class("space-y-1")], [0, 1, 2].map((row) =>
        h.keyed("div")(String(row), [h.Class("flex items-center gap-2 rounded-md px-3 py-2")], [
          h.div([h.Class("h-3.5 w-3.5 rounded-full bg-muted")]),
          h.div([h.Class(cn("h-3.5 rounded bg-muted", row === 0 ? "w-32" : row === 1 ? "w-40" : "w-28"))]),
        ]))),
    ])))
}

export const view = Submodel.defineView<Model, Message, SliceViewInputs>((model, { app }, h) => {
  const collapsed = app.sidebarCollapsed
  const peeking = collapsed && model.peeking
  const focused = focusedProjectGroup(app)
  const data = sidebarData(app)
  const allProjectsData = app.stores.sidebar.data

  const currentProject = currentProjectId(app)
  const keybindings = resolvedKeybindings(app)
  const focusShortcutHint = formatActionShortcut(keybindings, "toggleFocusMode")
  const sidebarView = app.stores.sidebarView.view
  const settings = appSettings(app)
  const newSidebar = newSidebarEnabled(app)
  const devbox = settings?.devbox === true
  const projectIconsInChats = settings?.projectIconsInChats !== false
  const newSidebarProjectsView = newSidebar && sidebarView === "projects"
  const settingsActive = isSettingsActive(app)
  const localProjectsActive = isLocalProjectsActive(app)
  const rootActive = isRootActive(app)
  const utilityPageActive = localProjectsActive || settingsActive
  const connecting = isConnecting(app)
  const statusLabel = connecting ? "Connecting" : app.connectionStatus === "connected" ? "Connected" : "Disconnected"
  const statusDotClass = app.connectionStatus === "connected" ? "bg-emerald-500" : "bg-amber-500"
  const visible = visibleChats(app, model)
  const hasVisibleChats = visible.length > 0
  const visibleIndexByChatId = new Map(visible.map((entry) => [entry.chat.chatId, entry.visibleIndex]))
  const chatId = activeChatId(app)
  const everyListed = threads(app)
  const badge = versionBadge(app.updateSnapshot, h)
  const channelsOpenAsPages = !model.hasFinePointer || model.isPhoneLayout
  const showMobileBackButton = app.route._tag === "Home" || app.route._tag === "Terminal"

  const numberJumpKeycap = (rowChatId: string): Html | undefined => {
    if (!model.showNumberJumpHints) return undefined
    const visibleIndex = visibleIndexByChatId.get(rowChatId)
    const hint = visibleIndex ? getSidebarNumberJumpHint(keybindings, visibleIndex) : null
    return hint ? kbd({ class: "h-4 min-w-4 rounded-sm border-border/50 bg-transparent px-1 text-[10px]" }, [hint], h) : undefined
  }

  const header = h.div([
    h.DataAttribute("window-drag", ""),
    h.Class("px-2.5 h-[64px] md:h-auto md:py-1 border-b grid grid-cols-[84px_minmax(0,1fr)_84px] items-center md:pl-3 md:pr-1 md:flex md:justify-between mac-app:md:h-[calc(var(--mac-traffic-lights-center)*2-18px)] mac-app:md:border-b-0 mac-app:md:py-0 mac-app:md:pl-[calc(var(--mac-traffic-lights-inset)+83px)]"),
  ], [
    // A phone's bar is a navigation bar: Back leads it in focus mode, Settings otherwise.
    h.div([h.Class("md:hidden flex")], [
      focused
        ? ghostIconButton({
          class: "w-[42px] rounded-lg hover:!border-border/0 hover:!bg-transparent !border-0",
          onClick: Message.ClickedExitFocus(),
          title: "Back",
          ariaLabel: `Back from ${focused.title}`,
        }, [ChevronLeft({ class: "size-6" }, h)], h)
        : ghostIconButton({
          class: cn("w-[42px] rounded-lg hover:!border-border/0 hover:!bg-transparent !border-0", settingsActive ? "text-foreground" : "text-muted-foreground"),
          onClick: Message.ClickedLink({ path: "/settings/general" }),
          title: "Settings",
        }, [Settings({ class: "h-5 w-5" }, h)], h),
    ]),
    ...(focused
      ? [
        h.span([h.Class("min-w-0 justify-self-center truncate text-base font-medium md:hidden")], [focused.title]),
        focusModePill({ projectTitle: focused.title, shortcutHint: focusShortcutHint, class: "hidden md:ml-[2px] md:flex mac-app:md:hidden" }, h),
      ]
      : [
        h.div([h.Class("flex items-center justify-self-center gap-2 md:justify-self-auto mac-app:md:hidden")], [
          h.button([
            h.Type("button"),
            h.OnClick(collapsed ? Message.ClickedExpandSidebar() : Message.ClickedCollapseSidebar()),
            h.Title(collapsed ? "Keep sidebar open" : "Collapse sidebar"),
            h.Class("hidden md:flex group/sidebar-collapse relative items-center justify-center h-5 w-5 sm:h-6 sm:w-6"),
          ], [
            Flower({ class: "absolute inset-0.5 h-4 w-4 sm:h-5 sm:w-5 text-logo transition-all duration-200 ease-out opacity-100 scale-100 group-hover/sidebar-collapse:opacity-0 group-hover/sidebar-collapse:scale-0" }, h),
            PanelLeft({ class: "absolute inset-0 h-4 w-4 sm:h-6 sm:w-6 text-slate-500 dark:text-slate-400 transition-all duration-200 ease-out opacity-0 scale-0 group-hover/sidebar-collapse:opacity-100 group-hover/sidebar-collapse:scale-80 hover:opacity-50" }, h),
          ]),
          Flower({ class: "h-5 w-5 sm:h-6 sm:w-6 text-logo md:hidden" }, h),
          h.button([
            h.Type("button"),
            h.OnClick(Message.ClickedLink({ path: "/home" })),
            h.Title("Projects"),
            h.Class("font-logo text-base uppercase sm:text-md text-slate-600 dark:text-slate-100"),
          ], [APP_NAME]),
        ]),
      ]),
    h.div([h.Class("flex items-center justify-self-end md:justify-self-auto mac-app:md:ml-auto")], [
      !newSidebar
        ? ghostIconButton({ class: "size-10 rounded-lg hover:!border-border/0 hover:!bg-transparent md:hidden", onClick: Message.ClickedSearch(), title: "Search" }, [Search({ class: "h-5 w-5" }, h)], h)
        : null,
      ghostIconButton({
        class: "size-10 rounded-lg hover:!border-border/0 hover:!bg-transparent md:hidden",
        onClick: newSidebar ? Message.ClickedSearch() : Message.ClickedLink({ path: "/home" }),
        title: newSidebar ? "Search" : "New project",
      }, [newSidebar ? Search({ class: "h-5 w-5" }, h) : Plus({ class: "h-5 w-5" }, h)], h),
      newSidebar
        ? ghostIconButton({
          class: cn("size-10 rounded-lg hover:!border-border/0 hover:!bg-transparent md:hidden", localProjectsActive ? "text-foreground" : "text-muted-foreground"),
          onClick: Message.ClickedLink({ path: "/home" }),
          title: "Projects",
        }, [House({ class: "h-5 w-5" }, h)], h)
        : null,
      h.div([h.Class("hidden md:flex mr-1 mac-app:md:hidden")], [badge]),
      newSidebar
        ? ghostIconButton({
          class: "hidden md:inline-flex h-10 w-auto rounded-lg px-1.5 pl-2 hover:!border-border/0 hover:!bg-transparent mac-app:md:h-8",
          onClick: Message.ClickedAddProject(),
          title: "Add project",
        }, [Plus({ class: "size-4" }, h)], h)
        : null,
      ghostIconButton({
        class: cn(
          "hidden md:inline-flex h-10 w-auto rounded-lg pl-1.5 pr-3 hover:!border-border/0 hover:!bg-transparent mac-app:md:h-8 mac-app:md:pr-1.5",
          !newSidebar && "pl-2 mac-app:md:pr-2",
        ),
        onClick: newSidebar ? Message.ClickedSearch() : Message.ClickedLink({ path: "/home" }),
        title: newSidebar ? "Search" : "New project",
      }, [newSidebar ? Search({ class: "size-4" }, h) : Plus({ class: "size-4" }, h)], h),
    ].filter((child): child is Html => child !== null)),
  ])

  const showEmpty = !connecting && sidebarView !== "archived" && !(sidebarView === "channels" && !focused) && (
    (!hasVisibleChats && data.projectGroups.length === 0)
    || focused?.chats.length === 0
  )

  const list = h.div([], [
    !hasVisibleChats && connecting ? skeleton(h) : null,
    showEmpty ? h.keyed("p")("empty", [h.Class("text-sm text-slate-400 p-2 mt-6 text-center")], ["No conversations yet"]) : null,
    newSidebar && (sidebarView === "recents" || (sidebarView === "channels" && focused))
      ? threadSections({
        expandScope: sidebarView === "channels" && focused ? `channel:${focused.groupKey}` : undefined,
        showProjectIcons: projectIconsInChats && sidebarView === "recents",
        threads: everyListed,
        activeChatId: chatId,
        nowMs: model.nowMs,
      }, app, model, h)
      : null,
    newSidebar && sidebarView === "archived" ? archivedSection(everyListed, chatId, model.nowMs, app, model, h) : null,
    newSidebar && sidebarView === "channels" && !focused
      ? channelList({ projectGroups: allProjectsData.projectGroups, activeProjectId: currentProject, activeChatId: chatId, opensAsPage: channelsOpenAsPages }, app, model, h)
      : null,
    !newSidebar || sidebarView === "projects"
      ? localProjectsSection({
        projectGroups: visibleProjectGroups(app, newSidebarProjectsView),
        isConnected: app.connectionStatus === "connected",
        newSidebar: newSidebarProjectsView,
        numberJumpKeycap,
      }, app, model, h)
      : null,
  ])

  const scroller = h.div([
    h.Id("kanna-sidebar-scroller"),
    h.DataAttribute("sidebar-scroller", ""),
    h.Attribute(LIST_HOVER_ATTRIBUTE, "chats"),
    h.OnMount(ListHoverTracker({ list: "chats" })),
    h.Class("flex-1 min-h-0 overflow-y-auto overflow-x-hidden scrollbar-hide"),
    h.Style({ "touch-action": "pan-y" }),
  ], [
    h.div([h.Class("p-[7px] mac-app:md:pt-[3px]")], [
      h.div([h.Class("hidden mac-app:md:flex items-center justify-between gap-2 pt-1 pb-2")], [
        focused
          ? focusModePill({ projectTitle: focused.title, shortcutHint: focusShortcutHint, class: "pl-[7px] pr-[9px]" }, h)
          : h.button([
            h.Type("button"),
            h.OnClick(Message.ClickedLink({ path: "/home" })),
            h.Title("Projects"),
            h.Class("flex items-center gap-2 pl-[7px] pr-[9px]"),
          ], [
            Flower({ class: "size-5 text-logo" }, h),
            h.span([h.Class("font-logo text-base uppercase text-slate-600 dark:text-slate-100")], [APP_NAME]),
          ]),
        h.div([h.Class("flex mr-1")], [badge]),
      ]),
      newSidebar
        ? h.div([h.Class("flex flex-col gap-[1px] pb-2 mac-app:md:pb-0")], [
          h.div([h.Class("relative")], [
            h.button([
              h.Type("button"),
              h.OnClick(Message.ClickedNewChat()),
              h.Class("flex w-full items-center gap-2 rounded-lg border border-border/0 px-2 py-1.5 max-md:py-2 text-sm max-md:text-base text-muted-foreground transition-colors hover:text-accent-foreground"),
            ], [
              SquarePen({ class: "h-4 w-4 shrink-0" }, h),
              h.span([], ["New Chat"]),
            ]),
            h.div([h.Class("absolute inset-y-0 right-0 flex items-center")], [viewSwitcher(model, sidebarView, h)]),
          ]),
          devbox
            ? h.button([
              h.Type("button"),
              h.OnClick(Message.ClickedLink({ path: "/terminal" })),
              h.Class("flex w-full items-center gap-2 rounded-lg border border-border/0 px-2 py-1.5 max-md:py-2 text-sm max-md:text-base text-muted-foreground transition-colors hover:border-border hover:bg-muted"),
            ], [
              Terminal({ class: "h-4 w-4 shrink-0" }, h),
              h.span([], ["Terminal"]),
            ])
            : null,
        ])
        : null,
      list,
    ]),
  ])

  const card = h.keyed("div")("sidebar-card", [
    h.Id("kanna-sidebar"),
    h.DataAttribute("sidebar", "open"),
    // Read by the sidebar's subscriptions (keyboard, peek) when an event comes.
    h.DataAttribute("sidebar-collapsed", collapsed ? "true" : "false"),
    h.DataAttribute("sidebar-focused", focused ? "true" : "false"),
    h.DataAttribute("sidebar-current-project", currentProject ?? ""),
    h.DataAttribute("sidebar-focus-enabled", app.stores.focusMode.enabled ? "true" : "false"),
    h.DataAttribute("sidebar-jump-chats", visible.map((entry) => entry.chat.chatId).join(" ")),
    h.DataAttribute("sidebar-keybindings", JSON.stringify({
      jumpToSidebarChat: keybindings.bindings.jumpToSidebarChat,
      createChatInCurrentProject: keybindings.bindings.createChatInCurrentProject,
      openAddProject: keybindings.bindings.openAddProject,
      toggleFocusMode: keybindings.bindings.toggleFocusMode,
    })),
    h.DataAttribute("sidebar-active-chat", chatId ?? ""),
    h.DataAttribute("sidebar-connection-load", connectionLoadNeeded(app) ? "1" : "0"),
    h.DataAttribute("sidebar-pair-enabled", pairSessionEnabled(app) ? "1" : "0"),
    // Sends come from the composer; heard only while the Archived view is up.
    h.DataAttribute("sidebar-sends", sidebarView === "archived" ? JSON.stringify(app.stores.pendingSend.sentAt) : ""),
    h.Class(cn(
      "fixed inset-0 z-50 bg-background dark:bg-card flex flex-col h-[100dvh] select-none",
      "md:relative md:inset-auto md:w-[var(--sidebar-width)] md:mr-0 md:h-[calc(100dvh-16px)] md:my-2 md:ml-2 md:border md:border-border md:rounded-2xl",
      "mac-app:md:rounded-[calc(var(--mac-window-radius)-8px)]",
      rootActive ? "flex" : "hidden md:flex",
      "md:transition-[margin-left,translate,box-shadow,visibility] md:duration-300 md:ease-glide motion-reduce:transition-none",
      collapsed && "md:!ml-[calc(var(--sidebar-width)*-1)]",
      collapsed && !peeking && "md:!duration-[240ms] md:invisible",
      peeking && "md:translate-x-[calc(var(--sidebar-width)+8px)] md:shadow-2xl",
    )),
    ...(collapsed && !peeking ? [h.Inert(true)] : []),
    h.Style({ "--sidebar-width": `${model.sidebarWidth}px` }),
    h.OnMount(SidebarCard()),
  ], [
    h.div([h.Class("relative flex min-h-0 flex-1 flex-col overflow-hidden md:rounded-t-[15px] mac-app:md:rounded-t-[calc(var(--mac-window-radius)-9px)]")], [
      h.div([
        h.Attribute(SIDEBAR_PAGE_ATTRIBUTE, focused ? "focused" : "all"),
        h.OnMount(FocusMotion()),
        h.Class("relative flex min-h-0 flex-1 flex-col"),
      ], [header, scroller]),
    ]),
    chatHoverCard({ list: "chats" }, app, model, h),
    machineSwitcher(app, model, h),
    h.div([h.Class(cn("hidden md:block border-t border-border p-2", model.isStandalone && "pb-[55px]"))], [
      h.button([
        h.Type("button"),
        h.OnClick(Message.ClickedLink({ path: "/settings/general" })),
        h.Class(cn(
          "w-full rounded-xl rounded-t-md border px-3 py-2 text-left transition-colors",
          settingsActive ? "bg-muted border-border" : "border-border/0 hover:bg-muted hover:border-border active:bg-muted/80",
        )),
      ], [
        h.div([h.Class("flex items-center justify-between gap-2")], [
          h.div([h.Class("flex items-center gap-2")], [
            Settings2({ class: "h-4 w-4 text-muted-foreground" }, h),
            h.span([h.Class("text-sm")], ["Settings"]),
          ]),
          h.div([h.Class("flex items-center gap-2 text-xs text-muted-foreground")], [
            h.span([], [statusLabel]),
            connecting ? Loader2({ class: "h-2 w-2 animate-spin" }, h) : h.span([h.Class(cn("h-2 w-2 rounded-full", statusDotClass))]),
          ]),
        ]),
      ]),
    ]),
    h.div([
      h.Role("separator"),
      h.AriaOrientation("vertical"),
      h.AriaLabel("Resize sidebar"),
      h.Tabindex(0),
      h.Title("Resize sidebar"),
      h.Class(cn("hidden md:block absolute -right-1 top-3 bottom-3 z-20 w-2 cursor-col-resize rounded-full", "focus-visible:outline-none")),
      h.OnPointerDown((_pointerType, _button, _screenX, _screenY, _timeStamp, clientX) => Option.some(Message.PressedResizeHandle({ pointerX: clientX }))),
      h.OnDoubleClick(Message.DoubleClickedResizeHandle()),
      h.OnKeyDownPreventDefault((key) =>
        ["ArrowLeft", "ArrowRight", "Home", "End", "Enter"].includes(key) ? Option.some(Message.PressedResizeKey({ key })) : Option.none()),
    ]),
  ])

  const historyButtonClass = cn(
    "size-7 rounded-lg text-muted-foreground hover:!border-border/0 hover:!bg-transparent",
    "disabled:!text-[color-mix(in_srgb,hsl(var(--muted-foreground))_50%,var(--history-surface))]",
    "[--history-surface:hsl(var(--background))]",
    (!collapsed || peeking) && "dark:[--history-surface:hsl(var(--card))]",
  )

  return h.div([h.Class("contents")], [
    showMobileBackButton
      ? ghostIconButton({ key: "sidebar-mobile-back", class: "fixed top-3 left-3 z-50 md:hidden", onClick: Message.ClickedLink({ path: "/" }), title: "Back" }, [ArrowLeft({ class: "h-5 w-5" }, h)], h)
      : null,
    collapsed && utilityPageActive
      ? h.keyed("div")("sidebar-expand", [h.Class("hidden md:flex fixed left-0 top-0 h-full z-40 items-start pt-4 pl-5 border-l border-border/0 mac-app:!hidden transition-opacity duration-200 ease-out starting:opacity-0")], [
        h.div([h.Class("flex items-center gap-1")], [
          Flower({ class: "size-6 text-logo" }, h),
          ghostIconButton({ class: "hover:!border-border/0 hover:!bg-transparent", onClick: Message.ClickedExpandSidebar(), title: "Expand sidebar" }, [PanelLeft({ class: "h-5 w-5" }, h)], h),
        ]),
      ])
      : null,
    card,
    h.keyed("div")("sidebar-mac-buttons", [h.Class("hidden mac-app:md:flex fixed z-50 items-center left-[var(--mac-traffic-lights-inset)] top-[calc(var(--mac-traffic-lights-center)-14px)]")], [
      ghostIconButton({
        class: "size-7 rounded-lg text-muted-foreground hover:!border-border/0 hover:!bg-transparent",
        onClick: collapsed ? Message.ClickedExpandSidebar() : Message.ClickedCollapseSidebar(),
        title: collapsed ? "Expand sidebar" : "Collapse sidebar",
      }, [PanelLeft({ class: "size-4" }, h)], h),
      // React read React Router's history index to disable these; Foldkit's
      // navigation keeps none, so both stay live (the browser ignores a
      // step it can't take). Mac app only.
      ghostIconButton({ class: historyButtonClass, onClick: Message.ClickedHistoryBack(), title: "Back" }, [ArrowLeft({ class: "size-4" }, h)], h),
      ghostIconButton({ class: historyButtonClass, onClick: Message.ClickedHistoryForward(), title: "Forward" }, [ArrowRight({ class: "size-4" }, h)], h),
    ]),
    archivedChatsDialog(app, model, h),
    rowMenu(app, model, h),
  ])
})
