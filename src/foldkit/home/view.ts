import { Submodel } from "foldkit"
import type { ChildAttribute, Html, HtmlBuilder } from "foldkit/html"
import { buildHomeGroups, repoKey, type HomeItem, type HomeSource } from "../../client/components/home/homeItems"
import { formatRelativeTime, formatSidebarAgeLabel } from "../../client/lib/formatters"
import { formatPathWithTilde } from "../../client/lib/pathUtils"
import { getSidebarChatTimestamp } from "../../client/lib/sidebarChats"
import { cn } from "../../client/lib/utils"
import { APP_NAME, getCliInvocation, SDK_CLIENT_APP } from "../../shared/branding"
import type { CloudMachineSummary } from "../../shared/cloud-api"
import { getRepoUrlLabel } from "../../shared/git-url"
import { DEV_CLIENT_PORT, PROD_SERVER_PORT } from "../../shared/ports"
import { AUTH_SERVICE_ORDER, type GitHubRepoSummary, type LocalProjectSummary, type SidebarProjectGroup } from "../../shared/types"
import type { AppModel, SliceViewInputs } from "../app/slice"
import { findCurrentMachine } from "../core/stores/connection"
import * as ProviderAuth from "../core/stores/providerAuth"
import type { Child } from "../ui/attributes"
import { button } from "../ui/button"
import * as ContextMenu from "../ui/context-menu"
import * as CopyButton from "../ui/copy-button"
import * as Dialog from "../ui/dialog"
import type { Icon } from "../ui/icon"
import {
  Archive,
  Building2,
  Check,
  ChevronRight,
  Cloud,
  Code,
  Copy,
  Download,
  ExternalLink,
  EyeOff,
  Flower,
  Folder,
  FolderOpen,
  Github,
  LaptopMinimal,
  Layers,
  ListFilter,
  Loader2,
  Lock,
  Pencil,
  Plus,
  RotateCcw,
  Search,
  Settings2,
  SquarePen,
  Terminal,
  User,
  Users,
  X,
} from "../ui/icons"
import * as Popover from "../ui/popover"
import * as Tooltip from "../ui/tooltip"
import { MountPage, MountProjectsList } from "./commands"
import { isOnThisMac } from "./environment"
import {
  ADD_PROJECT_TOOLTIP,
  CLEAR_SEARCH_TOOLTIP,
  FILTER_TOOLTIP,
  Message,
  rowTooltipKey,
  type Model,
} from "./model"
import { AUTH_SERVICE_ICONS, GitHubIcon, type ProviderIcon } from "../ui/provider-icons"
import {
  cloneDestination,
  cloneError,
  cloningRepo,
  CONNECTING_REVEAL_DELAY_MS,
  editorLabel,
  ghAuthStatus,
  isConnected,
  rowMenuFor,
  tooltipFor,
} from "./update"

type H = HtmlBuilder<Message>

// LocalProjectsPage (the page), LocalDev (its frame: connecting, setup help,
// the version), ProjectsHome (the list) and the menus and dialog the page
// opens, in that order.

export const view = Submodel.defineView<Model, Message, SliceViewInputs>((model, { app }, h) => pageView(model, app, h))

// LOCAL PROJECTS PAGE

// The mobile back button on /home is KannaSidebar's (App.tsx's
// showMobileBackButton), so it is the sidebar slice's too, rendered before
// the sidebar as React does; this page has none of its own.
function pageView(model: Model, app: AppModel, h: H): Html {
  return h.div([h.Class("flex-1 flex flex-col min-w-0 relative"), h.OnMount(MountPage()), h.OnUnmount(Message.LeftPage())], [
    // The Mac app's title bar across the projects page: it drags the window,
    // as on the settings page. The page starts with pt-16 of empty space, so
    // at the top of the scroll it covers nothing clickable.
    h.div([
      h.DataAttribute("window-drag", "true"),
      h.AriaHidden(true),
      h.Class("hidden mac-app:md:block absolute inset-x-0 top-0 z-10 h-[calc(var(--mac-traffic-lights-center)*2)]"),
    ]),
    localDevView(model, app, h),
    archivedChatsDialog(model, app, h),
  ])
}

// LOCAL DEV

const PREVIEW_VARIANTS = ["local", "mac", "cloud", "devbox", "connecting"] as const
type PreviewVariant = typeof PREVIEW_VARIANTS[number]

/**
 * Who is reading the page decides what brings the server back. A browser on
 * the machine itself needs the command. Kanna for Mac restarts its own
 * server (macos/src/server-agent.ts), so a command there would only start a
 * second one. On a machine's kanna.sh address the reader is usually on
 * another device, and the machine is what went away.
 */
type ConnectHelpContext =
  | { kind: "local"; command: string; host: string | null }
  | { kind: "mac" }
  | { kind: "cloud"; machine: CloudMachineSummary | null; others: CloudMachineSummary[]; fromMacApp: boolean }

/**
 * The page reconnects to the port it was served from, so a server started
 * anywhere else never picks it back up. Name the port whenever it isn't the
 * default. The dev client's port is Vite's, not the server's, so it is left
 * out.
 */
function localStartCommand(model: Model) {
  const port = Number(model.environment.port)
  const customPort = port > 0 && port !== PROD_SERVER_PORT && port !== DEV_CLIENT_PORT
  return getCliInvocation(customPort ? `--port ${port}` : undefined)
}

function connectHelpContext(model: Model, app: AppModel): ConnectHelpContext {
  const { hostname, host, macApp } = model.environment
  const connection = app.stores.connection
  if (macApp && isOnThisMac(hostname)) return { kind: "mac" }
  if (connection.mode === "cloud" && !isOnThisMac(hostname)) {
    const machine = findCurrentMachine(connection.machines, host)
    return { kind: "cloud", machine, others: connection.machines.filter((other) => other !== machine), fromMacApp: connection.fromMacApp }
  }
  return { kind: "local", command: localStartCommand(model), host: isOnThisMac(hostname) ? null : hostname }
}

// `/home?preview=<variant>` shows this page's states while connected: they
// are hard to reach on purpose (a stopped server, an offline machine).
const PREVIEW_MACHINE: CloudMachineSummary = {
  subdomain: "studio",
  name: "Studio Mac",
  appOrigin: "#",
  online: false,
  lastSeenAt: Date.now() - 2 * 60 * 60 * 1000,
}

/** Online and offline machines, and dev boxes both awake and paused. */
function previewFleet(now: number): CloudMachineSummary[] {
  return [
    { subdomain: "mbp", name: "MacBook Pro", appOrigin: "#", online: true, lastSeenAt: now },
    { subdomain: "linux", name: "Linux Server", appOrigin: "#", online: false, lastSeenAt: now - 3 * 24 * 60 * 60 * 1000 },
    { subdomain: "box", name: "Agents Box", appOrigin: "#", online: true, lastSeenAt: now, kind: "e2b" },
    { subdomain: "scratch", name: "Scratch Box", appOrigin: "#", online: false, lastSeenAt: now - 40 * 60 * 1000, kind: "e2b" },
    { subdomain: "mini", name: "Mac mini", appOrigin: "#", online: false, lastSeenAt: null },
  ]
}

function previewContext(variant: Exclude<PreviewVariant, "connecting">, model: Model): ConnectHelpContext {
  const now = model.environment.nowMs
  switch (variant) {
    case "local": return { kind: "local", command: localStartCommand(model), host: null }
    case "mac": return { kind: "mac" }
    case "cloud": return { kind: "cloud", machine: PREVIEW_MACHINE, others: previewFleet(now), fromMacApp: false }
    case "devbox": return {
      kind: "cloud",
      machine: { ...PREVIEW_MACHINE, name: "Dev Box", kind: "e2b" },
      others: previewFleet(now),
      fromMacApp: false,
    }
  }
}

/** The Fleet page's wording (kanna-site `formatLastSeen`), so a machine reads the same in both places. */
function formatLastSeen(lastSeenAt: number, now: number) {
  const minutes = Math.floor((now - lastSeenAt) / 60_000)
  if (minutes < 1) return "just now"
  if (minutes < 60) return `${minutes}m ago`
  const hours = Math.floor(minutes / 60)
  if (hours < 24) return `${hours}h ago`
  return `${Math.floor(hours / 24)}d ago`
}

function machineStatus(machine: CloudMachineSummary, now: number) {
  if (machine.kind === "e2b") return machine.online ? "Ready" : "Asleep"
  if (machine.online) return "Online"
  return machine.lastSeenAt === null ? "Never connected" : `Last seen ${formatLastSeen(machine.lastSeenAt, now)}`
}

function localDevView(model: Model, app: AppModel, h: H): Html {
  const preview = PREVIEW_VARIANTS.find((variant) => variant === model.environment.preview) ?? null
  // Each state is its own element (React's separate components and keys), so
  // a change of state enters with its own fade rather than patching the last.
  const content: Html[] = preview
    ? [
      previewBar(preview, h),
      preview === "connecting"
        ? connectingNotice(false, `preview-${preview}`, h)
        : connectHelp(previewContext(preview, model), model, `preview-${preview}`, h),
    ]
    // Until the page has read its environment (`?preview=` among it), the
    // list isn't drawn: LocalDev read the param on its first render, and a
    // list mounted for that frame would fetch the GitHub repos a preview
    // never asks for.
    : !model.pageMounted
      ? []
      : isConnected(app)
      ? [h.keyed("div")("connected", [h.Class(cn(model.revealChildren && "transition-opacity duration-200 ease-snappy starting:opacity-0"))], [
        projectsHomeView(model, app, h),
      ])]
      : !model.connectionFailed
        ? [connectingNotice(true, "connecting", h)]
        : [connectHelp(connectHelpContext(model, app), model, "help", h)]
  return h.div([h.Class("flex-1 flex flex-col min-w-0 bg-background overflow-y-auto")], [
    ...content,
    h.div([h.Class("py-4 text-center")], [
      h.span([h.Class("text-xs text-muted-foreground/50")], [`v${SDK_CLIENT_APP.split("/")[1]}`]),
    ]),
  ])
}

function previewBar(variant: PreviewVariant, h: H): Html {
  return h.div([h.Class("pointer-events-none absolute inset-x-0 top-3 z-20 flex justify-center")], [
    h.div([h.Class("pointer-events-auto flex items-center gap-0.5 rounded-full border border-border bg-background/80 p-1 text-xs shadow-sm backdrop-blur")], [
      ...PREVIEW_VARIANTS.map((option) =>
        h.keyed("button")(option, [
          h.Type("button"),
          h.OnClick(Message.ChosePreview({ preview: option })),
          h.Class(cn(
            "rounded-full px-2.5 py-1 capitalize text-muted-foreground transition-colors hover:text-foreground",
            option === variant && "bg-muted text-foreground",
          )),
        ], [option])),
      h.keyed("button")("close", [
        h.Type("button"),
        h.OnClick(Message.ClosedPreview()),
        h.Title("Close preview"),
        h.Class("rounded-full p-1 text-muted-foreground hover:text-foreground"),
      ], [X({ class: "size-3.5" }, h)]),
    ]),
  ])
}

function connectingNotice(delayed: boolean, key: string, h: H): Html {
  // A transient state, so it stays quiet: no page chrome, one line.
  // Hidden through the reveal delay so fast connections never show it.
  return h.keyed("div")(key, [
    h.Role("status"),
    h.Class("flex flex-1 flex-col items-center justify-center gap-3 px-6 transition-opacity duration-200 ease-snappy starting:opacity-0"),
    ...(delayed ? [h.Style({ "transition-delay": `${CONNECTING_REVEAL_DELAY_MS}ms` })] : []),
  ], [
    Loader2({ class: "size-5 animate-spin text-muted-foreground" }, h),
    h.p([h.Class("text-sm text-muted-foreground")], [`Connecting to ${APP_NAME}…`]),
  ])
}

/** Worded for the whole retry loop, so it doesn't change between attempts; the spinner is the retrying. */
function retryStatus(children: ReadonlyArray<Child>, h: H): Html {
  return h.div([h.Role("status"), h.Class("flex items-center justify-center gap-2 text-xs text-muted-foreground")], [
    Loader2({ class: "size-3.5 shrink-0 animate-spin" }, h),
    h.span([], children),
  ])
}

function connectHelp(context: ConnectHelpContext, model: Model, key: string, h: H): Html {
  const now = model.environment.nowMs
  let icon = Flower({ class: "size-7 text-muted-foreground" }, h)
  let title: string
  let body: ReadonlyArray<Child>
  let action: Html | null = null
  let status = retryStatus(["Trying again automatically"], h)
  let footer: Html | null = null

  if (context.kind === "mac") {
    title = `${APP_NAME} is restarting`
    body = [`${APP_NAME} for Mac starts its server again on its own. This window picks up where you left off.`]
  } else if (context.kind === "cloud") {
    const machine = context.machine
    const name = machine?.name ?? "This machine"
    icon = LaptopMinimal({ class: "size-7 text-muted-foreground" }, h)
    // Dev-boxes pause when idle and wake on traffic, so this page's own
    // retries are what bring one back.
    if (machine?.kind === "e2b") {
      title = `Waking ${name}`
      body = ["Dev boxes pause when nobody is using them. This takes a few seconds."]
      status = retryStatus(["Starting up"], h)
    } else {
      title = `${name} is offline`
      body = [
        "Open ", APP_NAME, " on it, or run ",
        h.code([h.Class("font-mono text-[0.9em] text-foreground")], [getCliInvocation()]),
        " there. This page reconnects as soon as it's back.",
      ]
      const lastSeen = machine?.lastSeenAt ?? null
      if (lastSeen !== null) status = retryStatus(["Last seen ", formatLastSeen(lastSeen, now)], h)
    }
    footer = fleetCard(context.others, context.fromMacApp, now, h)
  } else {
    title = `${APP_NAME} isn't running`
    body = [context.host
      ? `Start it on ${context.host}. This page reconnects by itself.`
      : "Start it from any terminal on this machine. This page reconnects by itself."]
    action = codeBlock(context.command, model, h)
  }

  return h.keyed("div")(key, [h.Class("flex flex-1 flex-col items-center justify-center px-6 py-16")], [
    h.div([h.Class("flex w-full max-w-md flex-col items-center gap-6 text-center transition-[opacity,translate] duration-300 ease-snappy starting:opacity-0 starting:translate-y-1 motion-reduce:starting:translate-y-0")], [
      h.div([h.Class("flex size-14 items-center justify-center rounded-2xl border border-border bg-card")], [icon]),
      h.div([h.Class("flex flex-col gap-2")], [
        h.h1([h.Class("text-2xl font-semibold leading-tight tracking-tight text-foreground text-balance")], [title]),
        h.p([h.Class("text-sm leading-relaxed text-muted-foreground text-balance")], body),
      ]),
      action ? h.div([h.Class("w-full")], [action]) : h.empty,
      status,
      footer ? h.div([h.Class("w-full pt-4")], [footer]) : h.empty,
    ]),
  ])
}

function codeBlock(text: string, model: Model, h: H): Html {
  // Darker than the page, and led by a prompt glyph rather than a chevron,
  // which read as a card that expands.
  return h.div([h.Class("grid grid-cols-[1fr_auto] items-center bg-muted dark:bg-black/30 border border-border text-foreground rounded-xl p-1.5 pl-3 font-mono text-sm text-left")], [
    h.pre([h.Class("inline-flex items-center gap-2 overflow-x-auto")], [
      Terminal({ class: "inline h-4 w-4 text-muted-foreground" }, h),
      h.code([], [text]),
    ]),
    h.submodel({
      slotId: "start-command-copy",
      model: model.commandCopy,
      view: CopyButton.view,
      viewInputs: {
        text,
        // Only the glyph brightens on hover: a box would frame a button
        // inside what is already a box.
        class: "h-8 w-8 text-muted-foreground hover:text-foreground hover:!border-border/0 hover:!bg-transparent",
        copiedHoverReset: false,
      },
      toParentMessage: (message) => Message.GotCommandCopyMessage({ message }),
    }),
  ])
}

const SETTINGS_LIST_CARD_CLASS = "divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card/40"
const FLEET_ROW_CLASS = "flex w-full items-center gap-2.5 px-3 py-2.5 text-left transition-colors duration-150 hover:bg-muted/60"

/**
 * The account's other machines, so an offline one isn't a dead end. Every
 * row opens its machine, as Launch does on the Fleet page: an offline one
 * lands on this same page for that machine, which is still the right place.
 * Kanna for Mac switches machines itself (MachineSwitcher) and blocks plain
 * links to other origins, so there the rows ask the app.
 */
function fleetCard(machines: ReadonlyArray<CloudMachineSummary>, fromMacApp: boolean, now: number, h: H): Html {
  // Online first, then most recently seen, so the likeliest switch is on top.
  const sorted = [...machines].sort((a, b) =>
    Number(b.online) - Number(a.online) || (b.lastSeenAt ?? 0) - (a.lastSeenAt ?? 0)
  )
  return h.div([h.Class(cn(SETTINGS_LIST_CARD_CLASS, "text-left"))], [
    ...sorted.map((machine) => {
      const content = [
        // In an icon-sized box, so the dots line up with Manage Fleet's icon.
        h.span([h.Class("flex size-4 shrink-0 items-center justify-center"), h.AriaHidden(true)], [
          h.span([h.Class(cn("size-2 rounded-full", machine.online ? "bg-emerald-500" : "bg-slate-400 dark:bg-slate-600"))]),
        ]),
        h.span([h.Class("flex min-w-0 flex-1 items-center gap-2")], [
          h.span([h.Class(cn("truncate text-sm", machine.online ? "text-foreground" : "text-muted-foreground"))], [machine.name]),
          machine.kind === "e2b"
            ? h.span([h.Class("inline-flex shrink-0 items-center gap-1 rounded-full border border-border px-1.5 py-px text-[10px] uppercase tracking-wide text-muted-foreground")], [
              Cloud({ class: "size-2.5" }, h),
              "Dev box",
            ])
            : h.empty,
        ]),
        // Kept whole: a long name truncates instead.
        h.span([h.Class("shrink-0 whitespace-nowrap text-xs text-muted-foreground")], [machineStatus(machine, now)]),
        ChevronRight({ class: "size-4 shrink-0 text-muted-foreground/50" }, h),
      ]
      return fromMacApp
        ? h.keyed("button")(machine.subdomain, [
          h.Type("button"),
          h.OnClick(Message.ClickedFleetMachine({ subdomain: machine.subdomain })),
          h.Class(FLEET_ROW_CLASS),
        ], content)
        : h.keyed("a")(machine.subdomain, [h.Href(machine.appOrigin), h.Class(FLEET_ROW_CLASS)], content)
    }),
    h.keyed("button")("manage-fleet", [
      h.Type("button"),
      h.OnClick(Message.ClickedManageFleet()),
      h.Class(cn(FLEET_ROW_CLASS, "text-sm text-muted-foreground hover:text-foreground")),
    ], [
      Settings2({ class: "size-4 shrink-0" }, h),
      h.span([h.Class("flex-1")], ["Manage Fleet"]),
      // Says it leaves the app, where the machine rows' chevrons are.
      ExternalLink({ class: "size-3.5 shrink-0 opacity-60" }, h),
    ]),
  ])
}

// PROJECTS HOME
//
// The "/" page: every project, wherever it lives. Projects on this machine
// and the account's GitHub repos share one search, one set of recency
// groups and one row design (homeItems.ts merges them; a cloned repo is its
// local row). Search gets a card of its own; each recency group is a titled
// card below it, as in Settings.

const LIST_CLASS = "divide-y divide-border overflow-hidden rounded-2xl border border-border bg-card/40"

function parentFolder(localPath: string) {
  const trimmed = localPath.replace(/\/+$/, "")
  const parent = trimmed.slice(0, trimmed.lastIndexOf("/")) || "/"
  return formatPathWithTilde(parent)
}

function relativeTime(timeMs: number | undefined) {
  return timeMs === undefined ? null : formatRelativeTime(new Date(timeMs).toISOString())
}

function searchPlaceholder(hasRepos: boolean, source: HomeSource, account: string) {
  if (!hasRepos || source === "local") return "Search projects…"
  if (source === "github") return account === "all" ? "Search GitHub repos…" : `Search ${account}’s repos…`
  return "Search projects and repos…"
}

/** The page's repos, and the accounts that own them: personal first, then organizations alphabetically. */
function reposOf(model: Model) {
  const result = model.recentRepos
  const repos: GitHubRepoSummary[] = result?.available ? result.repos : []
  const owners = [...new Set(repos.map((repo) => repo.owner).filter(Boolean))]
  const login = result?.login
  const rest = owners.filter((owner) => owner !== login).sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
  const accounts = login && owners.includes(login) ? [login, ...rest] : rest
  return { repos, accounts, login }
}

function projectsHomeView(model: Model, app: AppModel, h: H): Html {
  const projects = app.localProjects?.projects ?? []
  const machineName = app.localProjects?.machine.displayName ?? "This machine"
  const { repos, accounts, login } = reposOf(model)
  const hasRepos = repos.length > 0
  const ghStatus = ghAuthStatus(app)
  const signedIn = ghStatus === "signed_in"
  const groupsByPath = new Map(app.stores.sidebar.data.projectGroups.map((group) => [group.localPath, group]))
  // Each local project's GitHub remote, so a repo that's already cloned
  // shows once, as its local row.
  const repoKeyByPath = new Map<string, string>()
  for (const group of app.stores.sidebar.data.projectGroups) {
    const key = repoKey(group.repoUrl)
    if (key) repoKeyByPath.set(group.localPath, key)
  }
  const groups = buildHomeGroups({
    projects,
    repos,
    repoKeyByPath,
    source: hasRepos ? model.source : "local",
    account: model.account,
    query: model.query,
  })

  const searching = model.query.trim().length > 0
  const nothingYet = projects.length === 0 && !hasRepos

  // The recent list is a slice of GitHub: past it, the palette searches all
  // of it. It closes whichever card is last.
  const githubSearchRow = () => searching && signedIn && model.source !== "local"
    ? h.keyed("button")("search-github", [
      h.Type("button"),
      h.OnClick(Message.ClickedSearchGitHub()),
      h.Class("flex w-full items-center gap-3 px-4 py-2.5 text-left text-sm text-muted-foreground transition-colors duration-150 hover:bg-muted/40 hover:text-foreground active:bg-muted/70"),
    ], [Search({ class: "size-4 shrink-0" }, h), "Search all of GitHub"])
    : h.empty

  const error = app.commandError ?? cloneError(model, app)
  const setup = setupCard(app, h)

  return h.div([h.Class("mx-auto w-full max-w-3xl px-6 pb-10 pt-16"), h.OnUnmount(Message.LeftProjectsList())], [
    h.div([h.Class("mb-6 flex items-end justify-between gap-4")], [
      h.keyed("h1")("projects", [
        h.Class("text-2xl font-semibold text-foreground"),
        h.OnMount(MountProjectsList()),
      ], ["Projects"]),
      h.span([h.Class("flex min-w-0 items-center gap-1.5 pb-1 text-sm text-muted-foreground")], [
        LaptopMinimal({ class: "size-4 shrink-0" }, h),
        h.span([h.Class("truncate")], [machineName]),
      ]),
    ]),

    setup,

    h.div([h.Class("flex flex-col gap-8")], [
      h.keyed("div")("search", [h.Class("flex h-12 items-center gap-1 rounded-2xl border border-border bg-card/40 pl-4 pr-2")], [
        Search({ class: "mr-1.5 size-4 shrink-0 text-muted-foreground" }, h),
        h.input([
          h.Type("text"),
          h.Role("searchbox"),
          h.AriaLabel("Search projects"),
          h.Placeholder(searchPlaceholder(hasRepos, model.source, model.account)),
          h.Value(model.query),
          h.OnInput((value) => Message.ChangedQuery({ value })),
          h.OnKeyDown((key) => Message.PressedSearchKey({ key })),
          h.Spellcheck(false),
          h.Autocomplete("off"),
          h.Class("min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"),
        ]),
        model.query
          ? accessoryButton(model, {
            tooltipKey: CLEAR_SEARCH_TOOLTIP,
            label: "Clear search",
            attributes: [h.OnClick(Message.ClickedClearSearch())],
            children: [X({ class: "size-3.5" }, h)],
          }, h)
          : h.empty,
        hasRepos ? filterPopover(model, accounts, login, h) : h.empty,
        accessoryButton(model, {
          tooltipKey: ADD_PROJECT_TOOLTIP,
          label: "Add project",
          attributes: [h.OnClick(Message.ClickedAddProject())],
          children: [Plus({ class: "size-4" }, h)],
        }, h),
      ]),

      ...groups.map((group, index) =>
        h.keyed("section")(group.key, [h.AriaLabel(group.title)], [
          settingsGroupHeading(group.title, h),
          h.div([h.Class(LIST_CLASS)], [
            ...group.items.map((item) => homeItemView(model, app, item, groupsByPath, h)),
            index === groups.length - 1 ? githubSearchRow() : h.empty,
          ]),
        ])),

      groups.length === 0
        ? h.keyed("div")("empty", [h.Class(LIST_CLASS)], [
          h.div([h.Class("px-4 py-6 text-center text-sm text-muted-foreground")], [
            nothingYet ? "No projects yet. Add a folder or clone a repo to start." : "Nothing matches.",
          ]),
          githubSearchRow(),
        ])
        : h.empty,
    ]),

    error
      ? h.div([h.Class("mt-4 rounded-2xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive")], [error])
      : h.empty,
  ])
}

/** SettingsGroupHeading (app/settings/shared.tsx). */
function settingsGroupHeading(title: string, h: H): Html {
  return h.div([h.Class(cn("flex min-h-5 items-center justify-between gap-3 pb-1.5", "px-[17px]"))], [
    h.h3([h.Class("text-sm text-slate-500 dark:text-slate-400")], [title]),
  ])
}

/**
 * Compact "finish setup" entry point shown on the home page and new-chat empty
 * state until the setup wizard has been completed. Connected services render
 * bright, missing ones muted. Clicking opens the full-screen wizard.
 */
function setupCard(app: AppModel, h: H): Html {
  const providerAuth = app.stores.providerAuth
  if (!ProviderAuth.showSetupCard(providerAuth)) return h.empty
  const status = ProviderAuth.setupStatus(providerAuth)
  const subtitle = !status.anyAgentConnected
    ? "Connect your coding agents to start building."
    : "Connect the rest of your accounts."
  return h.button([
    h.Type("button"),
    h.OnClick(Message.ClickedSetup()),
    h.Class(cn(
      "group w-full rounded-2xl border border-border bg-card/40 px-3.5 py-3 text-left transition-colors hover:border-primary/30 hover:bg-muted/40",
      "mb-6",
    )),
  ], [
    h.div([h.Class("flex items-center justify-between gap-3")], [
      h.div([h.Class("flex min-w-0 items-center gap-2.5")], [
        Flower({ class: "h-4 w-4 shrink-0 text-logo" }, h),
        h.span([h.Class("truncate text-sm font-semibold text-foreground")], ["Set up Kanna"]),
      ]),
      h.span([h.Class("inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border px-2.5 py-1 text-xs font-semibold text-foreground transition-colors group-hover:bg-muted")], [
        "Setup",
        ChevronRight({ class: "h-3.5 w-3.5 -mr-0.5" }, h),
      ]),
    ]),
    h.div([h.Class("mt-2.5 flex items-center gap-3")], [
      h.div([h.Class("flex items-center gap-2.5")], AUTH_SERVICE_ORDER.map((id) => {
        const connected = ProviderAuth.selectAuthService(providerAuth.snapshot, id)?.authStatus === "signed_in"
        return AUTH_SERVICE_ICONS[id]({ class: cn("h-4 w-4", connected ? "text-foreground" : "text-muted-foreground/40") }, h)
      })),
      h.span([h.Class("min-w-0 truncate text-xs text-muted-foreground")], [subtitle]),
    ]),
  ])
}

// ROWS

const ROW_ICON_CLASS = cn(
  "size-4 text-muted-foreground transition-[opacity,filter,scale] duration-150 ease-snappy",
  "group-enabled:group-focus-visible:scale-75 group-enabled:group-focus-visible:opacity-0 group-enabled:group-focus-visible:blur-[1px]",
  "[@media(hover:hover)]:group-enabled:group-hover:scale-75 [@media(hover:hover)]:group-enabled:group-hover:opacity-0 [@media(hover:hover)]:group-enabled:group-hover:blur-[1px]",
)

const ROW_ACTION_CLASS = cn(
  "absolute size-4 scale-75 text-foreground opacity-0 blur-[1px] transition-[opacity,filter,scale] duration-150 ease-snappy",
  "group-enabled:group-focus-visible:scale-100 group-enabled:group-focus-visible:opacity-100 group-enabled:group-focus-visible:blur-none",
  "[@media(hover:hover)]:group-enabled:group-hover:scale-100 [@media(hover:hover)]:group-enabled:group-hover:opacity-100 [@media(hover:hover)]:group-enabled:group-hover:blur-none",
)

interface HomeRowOptions {
  key: string
  icon: Icon | ProviderIcon
  title: string
  /** Marks the row, like a private repo's lock, right after the title. */
  badge?: Html
  context: string
  fact?: string | null
  time: string | null
  action: Icon
  loading: boolean
  disabled?: boolean
  arrived?: boolean
  tooltip: () => ReadonlyArray<Child>
  onClick: Message
  /** The context menu's trigger attributes (ProjectSectionMenu's asChild), and its portal. */
  menu?: { trigger: ReadonlyArray<ChildAttribute>; portal: Html }
}

/**
 * One row, the same parts for both sources: icon (the action it will take,
 * on hover), name, one line of context, a fact, and the time.
 */
function homeRow(model: Model, options: HomeRowOptions, h: H): Html {
  const tooltipKey = rowTooltipKey(options.key)
  return h.submodel({
    slotId: `row-tooltip:${options.key}`,
    model: tooltipFor(model, tooltipKey),
    view: Tooltip.view,
    viewInputs: {
      content: options.tooltip,
      toView: ({ trigger, portal }) => h.keyed("button")(options.key, [
        // The menu's attributes after the tooltip's: React's Slot let the
        // child's own props (the menu's, spread onto the button) win.
        ...trigger,
        ...(options.menu?.trigger ?? []),
        h.Type("button"),
        ...(options.loading || options.disabled ? [h.Disabled(true)] : []),
        h.OnClick(options.onClick),
        h.Class(cn(
          // A list cell: pressing darkens it at once, like a system list.
          "group flex w-full items-center gap-3 px-4 py-2.5 text-left transition-[background-color,opacity] duration-150 ease-snappy",
          "hover:bg-muted/40 active:bg-muted/70",
          "disabled:cursor-not-allowed disabled:opacity-50",
          options.arrived && "starting:opacity-0",
        )),
      ], [
        // The action takes the icon's place on hover instead of holding an
        // empty slot at the row's end. Blur and a small scale blend the
        // swap into one change rather than two icons crossing.
        h.span([h.Class("relative flex size-4 shrink-0 items-center justify-center")], options.loading
          ? [Loader2({ class: "size-4 animate-spin text-muted-foreground" }, h)]
          : [options.icon({ class: ROW_ICON_CLASS }, h), options.action({ class: ROW_ACTION_CLASS }, h)]),
        h.span([h.Class("flex min-w-0 flex-1 items-baseline gap-2")], [
          h.span([h.Class("truncate text-sm font-medium text-foreground")], [options.title]),
          options.badge ?? h.empty,
          h.span([h.Class("truncate text-xs text-muted-foreground")], [options.context]),
        ]),
        options.fact ? h.span([h.Class("hidden shrink-0 text-xs text-muted-foreground sm:inline")], [options.fact]) : h.empty,
        options.time ? h.span([h.Class("w-16 shrink-0 text-right text-xs tabular-nums text-muted-foreground")], [options.time]) : h.empty,
        portal,
        options.menu?.portal ?? h.empty,
      ]),
    },
    toParentMessage: (message) => Message.GotTooltipMessage({ key: tooltipKey, message }),
  })
}

function homeItemView(model: Model, app: AppModel, item: HomeItem, groupsByPath: Map<string, SidebarProjectGroup>, h: H): Html {
  if (item.kind === "local") {
    const { project } = item
    return projectMenu(model, app, project, groupsByPath.get(project.localPath)?.repoUrl, (menu) => homeRow(model, {
      key: item.key,
      icon: Folder,
      title: item.title,
      context: parentFolder(project.localPath),
      fact: project.chatCount > 0 ? `${project.chatCount} ${project.chatCount === 1 ? "chat" : "chats"}` : null,
      time: relativeTime(item.timeMs),
      action: SquarePen,
      loading: app.actions.startingLocalPath === project.localPath,
      tooltip: () => [h.p([], [project.localPath])],
      onClick: Message.ClickedLocalProject({ localPath: project.localPath }),
      menu,
    }, h), h)
  }
  const { repo } = item
  const clone = cloneDestination(repo.nameWithOwner, app)
  const destination = clone ? formatPathWithTilde(clone.destination.localPath) : null
  const cloning = cloningRepo(model, app)
  return homeRow(model, {
    key: item.key,
    icon: GitHubIcon,
    title: item.title,
    badge: repo.isPrivate
      ? Lock({ class: "size-3 shrink-0 self-center text-muted-foreground", attributes: [h.AriaLabel("Private")] }, h)
      : undefined,
    context: repo.owner,
    time: relativeTime(item.timeMs),
    action: Download,
    loading: cloning === repo.nameWithOwner,
    disabled: cloning !== null && cloning !== repo.nameWithOwner,
    arrived: model.reposJustArrived,
    tooltip: () => [
      h.p([], [repo.nameWithOwner, repo.isPrivate ? " · private" : ""]),
      repo.description ? h.p([h.Class("max-w-72 text-muted-foreground")], [repo.description]) : h.empty,
      destination ? h.p([h.Class("text-muted-foreground")], ["Clone to ", destination]) : h.empty,
    ],
    onClick: Message.ClickedRepo({ nameWithOwner: repo.nameWithOwner }),
  }, h)
}

// ACCESSORY BUTTONS AND THE FILTER

interface AccessoryOptions {
  tooltipKey: string
  label: string
  active?: boolean
  attributes?: ReadonlyArray<ChildAttribute | ReturnType<H["OnClick"]>>
  children: ReadonlyArray<Child>
  /** A popover's portal, when the button is its trigger. */
  portal?: Html
}

/**
 * An icon button inside the search card. The card is rounded-2xl (16px) and
 * the button sits 8px in from its edge, so rounded-lg (8px) keeps the two
 * corners concentric.
 */
function accessoryButton(model: Model, options: AccessoryOptions, h: H): Html {
  return h.submodel({
    slotId: `accessory-tooltip:${options.tooltipKey}`,
    model: tooltipFor(model, options.tooltipKey),
    view: Tooltip.view,
    viewInputs: {
      content: () => [options.label],
      toView: ({ trigger, portal }) => h.button([
        ...trigger,
        ...(options.attributes ?? []),
        h.Type("button"),
        h.AriaLabel(options.label),
        h.Class(cn(
          "relative inline-flex size-8 shrink-0 items-center justify-center rounded-lg text-muted-foreground",
          "transition-[background-color,color,transform] duration-150 ease-snappy hover:bg-muted hover:text-foreground active:scale-[0.96]",
          "data-[state=open]:bg-muted data-[state=open]:text-foreground",
          options.active && "text-foreground",
        )),
      ], [...options.children, portal, options.portal ?? h.empty]),
    },
    toParentMessage: (message) => Message.GotTooltipMessage({ key: options.tooltipKey, message }),
  })
}

function filterSubheader(text: string, h: H): Html {
  return h.div([h.Class("bg-muted/40 px-3 py-1.5 text-xs text-muted-foreground")], [text])
}

/** PopoverMenuItem (chat-ui/ChatPreferenceControls.tsx) as FilterOption used it. */
function filterOption(key: string, label: string, icon: Html, selected: boolean, onSelect: Message, h: H): Html {
  return h.keyed("button")(key, [
    h.OnClick(onSelect),
    h.Class(cn(
      "w-full flex items-center gap-2 text-left [&>svg]:shrink-0 px-3 py-2 transition-colors",
      selected ? "bg-muted" : "hover:bg-muted/50",
    )),
  ], [
    icon,
    h.div([h.Class("min-w-0 flex-1")], [
      h.div([h.Class("text-sm font-medium")], [label]),
    ]),
    selected ? Check({ class: "size-3.5 shrink-0 text-muted-foreground" }, h) : h.empty,
  ])
}

/**
 * Which projects the list shows, behind one icon. Picking an account also
 * switches to GitHub, since accounts only narrow GitHub. The popover stays
 * open so a source and an account can be picked in one visit.
 */
function filterPopover(model: Model, accounts: ReadonlyArray<string>, login: string | undefined, h: H): Html {
  const { source, account } = model
  const filtered = source !== "all"
  const shownAccount = source === "github" ? account : null
  return h.submodel({
    slotId: "filter-popover",
    model: model.filterPopover,
    view: Popover.view,
    viewInputs: {
      align: "end",
      sideOffset: 8,
      className: "w-60 overflow-hidden p-0",
      content: () => [
        h.div([h.Class("max-h-96 overflow-y-auto divide-y divide-border/60")], [
          filterSubheader("Show", h),
          filterOption("all", "Everything", Layers({ class: "size-4" }, h), source === "all", Message.ChoseFilter({ source: "all", account: "all" }), h),
          filterOption("local", "This Mac", LaptopMinimal({ class: "size-4" }, h), source === "local", Message.ChoseFilter({ source: "local", account: "all" }), h),
          filterOption("github", "GitHub", GitHubIcon({ class: "size-4" }, h), source === "github", Message.ChoseFilter({ source: "github", account }), h),
          ...(accounts.length > 1
            ? [
              filterSubheader("GitHub account", h),
              filterOption("account:all", "Everyone", Users({ class: "size-4" }, h), shownAccount === "all", Message.ChoseFilter({ source: "github", account: "all" }), h),
              ...accounts.map((owner) =>
                filterOption(
                  `account:${owner}`,
                  owner,
                  owner === login ? User({ class: "size-4" }, h) : Building2({ class: "size-4" }, h),
                  shownAccount === owner,
                  Message.ChoseFilter({ source: "github", account: owner }),
                  h,
                )),
            ]
            : []),
        ]),
      ],
      toView: ({ trigger, portal }) => accessoryButton(model, {
        tooltipKey: FILTER_TOOLTIP,
        label: "Filter projects",
        active: filtered,
        // The popover's attributes after the tooltip's, as React's Slot merged them.
        attributes: trigger,
        children: [
          ListFilter({ class: "size-4" }, h),
          // The filter lives out of sight, so the icon says when it's on.
          filtered ? h.span([h.AriaHidden(true), h.Class("absolute right-1.5 top-1.5 size-1.5 rounded-full bg-primary")]) : h.empty,
        ],
        portal,
      }, h),
    },
    toParentMessage: (message) => Message.GotFilterPopoverMessage({ message }),
  })
}

// PROJECT MENU (chat-ui/sidebar/Menus.tsx's ProjectSectionMenu)

const MENU_LABELS: Record<string, { icon: Icon; label: (editor: string, repoUrl: string | undefined) => string }> = {
  "rename": { icon: Pencil, label: () => "Rename" },
  "copy-path": { icon: Copy, label: () => "Copy Path" },
  "show-archived": { icon: Archive, label: () => "Show Archived" },
  "open-finder": { icon: FolderOpen, label: () => "Show in Finder" },
  "open-editor": { icon: Code, label: (editor) => `Open in ${editor}` },
  "open-repo": { icon: Github, label: (_editor, repoUrl) => `Open on ${getRepoUrlLabel(repoUrl)}` },
  "hide": { icon: EyeOff, label: () => "Hide" },
}

function projectMenu(
  model: Model,
  app: AppModel,
  project: LocalProjectSummary,
  repoUrl: string | undefined,
  row: (menu: { trigger: ReadonlyArray<ChildAttribute>; portal: Html }) => Html,
  h: H,
): Html {
  const localPath = project.localPath
  const editor = editorLabel(app)
  const newChatDisabled = app.connectionStatus !== "connected" || app.actions.startingLocalPath === localPath
  return h.submodel({
    slotId: `project-menu:${localPath}`,
    model: rowMenuFor(model, localPath),
    view: ContextMenu.view,
    viewInputs: {
      className: "[&_svg]:size-3.5",
      items: [
        ContextMenu.item({ value: "new-chat", disabled: newChatDisabled }),
        ContextMenu.item({ value: "rename" }),
        ContextMenu.item({ value: "copy-path" }),
        ContextMenu.item({ value: "show-archived" }),
        ContextMenu.item({ value: "open-finder" }),
        ContextMenu.item({ value: "open-editor" }),
        // "Open on GitHub" renders nothing without a URL: a project with no
        // `origin` has no page to open.
        ...(repoUrl ? [ContextMenu.item({ value: "open-repo" })] : []),
        ContextMenu.item({ value: "hide" }),
      ],
      renderItem: (value) => {
        if (value === "new-chat") return [SquarePen({}, h), h.span([], ["New Chat"])]
        const entry = MENU_LABELS[value]
        if (!entry) return []
        return [entry.icon({ class: "h-3.5 w-3.5" }, h), h.span([h.Class("text-xs font-medium")], [entry.label(editor, repoUrl)])]
      },
      toView: ({ trigger, portal }) => row({ trigger, portal }),
    },
    toParentMessage: (message) => Message.GotRowMenuMessage({ localPath, message }),
  })
}

// ARCHIVED CHATS (chat-ui/sidebar/ArchivedChatsDialog.tsx)
//
// One project's archived chats, opened from its menu. Opening a chat closes
// the dialog (you're leaving for it) while restoring leaves it open, since
// putting several chats back is one errand and each row drops out of the
// list on the next snapshot anyway.

function archivedChatsDialog(model: Model, app: AppModel, h: H): Html {
  const archive = model.archive
  const group = archive ? app.stores.sidebar.data.projectGroups.find((candidate) => candidate.localPath === archive.localPath) : undefined
  const chats = group?.archivedChats ?? []
  const nowMs = archive?.nowMs ?? model.environment.nowMs
  return h.submodel({
    slotId: "archived-chats-dialog",
    model: model.archiveDialog,
    view: Dialog.view,
    viewInputs: {
      size: "md",
      content: ({ titleId, descriptionId }) => [
        Dialog.dialogHeader({}, [
          Dialog.dialogTitle({ id: titleId }, ["Archived Chats"], h),
          Dialog.dialogDescription({ id: descriptionId }, [archive?.localPath ?? ""], h),
        ], h),
        Dialog.dialogBody({ class: "space-y-1" }, chats.length
          ? chats.map((chat) =>
            h.keyed("div")(chat.chatId, [
              h.Class("group flex items-center gap-1 rounded-lg border border-border/0 pr-1 transition-colors hover:border-border hover:bg-muted"),
            ], [
              h.button([
                h.Type("button"),
                h.Class("flex min-w-0 flex-1 items-center justify-between gap-3 px-3 py-2 text-left"),
                h.OnClick(Message.ClickedArchivedChat({ chatId: chat.chatId })),
              ], [
                h.span([h.Class("min-w-0 truncate text-sm")], [chat.title]),
                h.span([h.Class("shrink-0 text-xs text-muted-foreground")], [
                  formatSidebarAgeLabel(chat.archivedAt ?? getSidebarChatTimestamp(chat), nowMs),
                ]),
              ]),
              button({
                variant: "ghost",
                size: "icon",
                class: "h-7 w-7 shrink-0 rounded-md text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100",
                attributes: [
                  h.Title("Restore chat"),
                  h.AriaLabel(`Restore ${chat.title}`),
                  h.OnClick(Message.ClickedRestoreChat({ chatId: chat.chatId })),
                ],
              }, [RotateCcw({ class: "size-3.5" }, h)], h),
            ]))
          : [h.p([h.Class("px-1 py-3 text-sm text-muted-foreground")], ["No archived chats"])], h),
      ],
    },
    toParentMessage: (message) => Message.GotArchiveDialogMessage({ message }),
  })
}
