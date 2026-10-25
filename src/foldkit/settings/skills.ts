import { Duration, Effect, Schema } from "effect"
import { Command, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { cn } from "../../client/lib/utils"
import type {
  AgentProvider,
  GlobalSkillSummary,
  GlobalSkillsSnapshot,
  SkillInstallResult,
  SkillSearchResult,
  SkillSearchSnapshot,
  SkillUninstallResult,
} from "../../shared/types"
import { opaque } from "../core/schema"
import { errorMessage, sendCommand } from "../core/socket"
import * as ContextMenu from "../ui/context-menu"
import { Ellipsis, ExternalLink, FolderOpen, Loader2, Search, Trash2, X } from "../ui/icons"
import * as Tooltip from "../ui/tooltip"
import { makeSectionMount } from "./activeSection"
import { PROVIDER_ICONS } from "../ui/provider-icons"
import { liftChild, sectionLabel, sectionSubtitle, type AppModel, type SectionReturn, type SectionViewInputs } from "./section"
import { sectionContainer, SETTINGS_LIST_CARD_CLASS, settingsActionButton, settingsNotice } from "./shared"

// Settings › Skills (app/settings/SkillsSection.tsx).

const PROVIDER_LABELS: Record<AgentProvider, string> = {
  claude: "Claude",
  codex: "Codex",
  cursor: "Cursor",
  grok: "Grok",
  pi: "Pi",
}

function formatInstallCount(count: number) {
  if (!count || count <= 0) return "0 installs"
  if (count >= 1_000_000) return `${(count / 1_000_000).toFixed(1).replace(/\.0$/, "")}M installs`
  if (count >= 1_000) return `${(count / 1_000).toFixed(1).replace(/\.0$/, "")}K installs`
  return `${count} install${count === 1 ? "" : "s"}`
}

/** "/Users/jake/.claude/skills/foo/SKILL.md" → "~/.claude/skills/foo". */
function formatSkillLocation(skillPath: string) {
  return skillPath
    .replace(/\/SKILL\.md$/, "")
    .replace(/^.*?(?=\/\.(?:agents|claude|cursor|codex)\/)/, "~")
}

const SEARCH_DEBOUNCE_MS = 250

// MODEL

const Installed = opaque<GlobalSkillSummary[]>("GlobalSkillSummaries")
const Results = opaque<SkillSearchResult[]>("SkillSearchResults")
const ResultSkill = opaque<SkillSearchResult>("SkillSearchResult")

export const Model = Schema.Struct({
  query: Schema.String,
  results: Results,
  searchLoading: Schema.Boolean,
  searchError: Schema.NullOr(Schema.String),
  /** Bumped per query change: a search for an older query is dropped, as React's `cancelled` did. */
  searchVersion: Schema.Number,
  installedSkills: Installed,
  installedSkillIds: Schema.Array(Schema.String),
  installedLoading: Schema.Boolean,
  installedError: Schema.NullOr(Schema.String),
  operationError: Schema.NullOr(Schema.String),
  installingSkillId: Schema.NullOr(Schema.String),
  uninstallingSkillId: Schema.NullOr(Schema.String),
  installMessages: Schema.Record(Schema.String, Schema.String),
  /** One per installed skill's card, by skill name. */
  menus: Schema.Record(Schema.String, ContextMenu.Model),
  /** One per provider icon, by `${skill}:${provider}`. */
  tooltips: Schema.Record(Schema.String, Tooltip.Model),
})
export type Model = typeof Model.Type

export function init(): Model {
  return {
    query: "",
    results: [],
    searchLoading: false,
    searchError: null,
    searchVersion: 0,
    installedSkills: [],
    installedSkillIds: [],
    installedLoading: false,
    installedError: null,
    operationError: null,
    installingSkillId: null,
    uninstallingSkillId: null,
    installMessages: {},
    menus: {},
    tooltips: {},
  }
}

const menuFor = (model: Model, name: string) => model.menus[name] ?? ContextMenu.init({ id: `settings-skill-${name}` })
const tooltipFor = (model: Model, key: string) => model.tooltips[key] ?? Tooltip.init({ id: `settings-skill-${key}` })

// MESSAGE

export const Message = defineMessageUnion({
  MountedSection: {},
  UnmountedSection: {},
  SucceededListInstalled: { skills: Installed },
  FailedListInstalled: { error: Schema.String },
  ChangedQuery: { query: Schema.String },
  PressedQueryKey: { key: Schema.String },
  ClickedClearQuery: {},
  ElapsedSearchDelay: { version: Schema.Number, query: Schema.String },
  SucceededSearch: { version: Schema.Number, skills: Results },
  FailedSearch: { version: Schema.Number, error: Schema.String },
  ClickedInstall: { skill: ResultSkill },
  SucceededInstall: { skill: ResultSkill },
  FailedInstall: { error: Schema.String },
  SucceededUninstall: { name: Schema.String },
  FailedUninstall: { error: Schema.String },
  FailedReveal: { error: Schema.String },
  CompletedReveal: {},
  ClickedSkillActions: { name: Schema.String },
  MeasuredSkillActions: { name: Schema.String, x: Schema.Number, y: Schema.Number },
  GotMenuMessage: { name: Schema.String, message: ContextMenu.Message },
  GotTooltipMessage: { key: Schema.String, message: Tooltip.Message },
  CompletedOpenSkillsSh: {},
})
export type Message = typeof Message.Type

type Return = SectionReturn<Model, Message>

// COMMANDS

const ListInstalled = Command.define("ListGlobalSkills", {
  messages: [Message.SucceededListInstalled, Message.FailedListInstalled],
  execute: sendCommand<GlobalSkillsSnapshot>({ type: "skills.listGlobal" }).pipe(
    // React read `snapshot.skills.map(...)` inside its try: a reply without
    // `skills` fails the read with that TypeError's message.
    Effect.flatMap((snapshot) => Effect.try({
      try: () => {
        snapshot.skills.map((skill) => skill.name)
        return Message.SucceededListInstalled({ skills: snapshot.skills })
      },
      catch: (error) => error,
    })),
    Effect.catch((error) => Effect.succeed(Message.FailedListInstalled({ error: error instanceof Error ? error.message : "Unable to read installed skills." }))),
  ),
})

const DelaySearch = Command.define("DelaySkillsSearch", {
  args: { version: Schema.Number, query: Schema.String },
  messages: [Message.ElapsedSearchDelay],
  execute: ({ version, query }) => Effect.sleep(Duration.millis(SEARCH_DEBOUNCE_MS)).pipe(Effect.as(Message.ElapsedSearchDelay({ version, query }))),
})

const SearchSkills = Command.define("SearchSkills", {
  args: { version: Schema.Number, query: Schema.String },
  messages: [Message.SucceededSearch, Message.FailedSearch],
  execute: ({ version, query }) => sendCommand<SkillSearchSnapshot>({ type: "skills.search", query, limit: 100 }).pipe(
    Effect.map((snapshot) => Message.SucceededSearch({ version, skills: snapshot.skills })),
    Effect.catch((error) => Effect.succeed(Message.FailedSearch({ version, error: errorMessage(error) || "Unable to search skills." }))),
  ),
})

const InstallSkill = Command.define("InstallSkill", {
  args: { skill: ResultSkill },
  messages: [Message.SucceededInstall, Message.FailedInstall],
  execute: ({ skill }) => sendCommand<SkillInstallResult>({ type: "skills.install", source: skill.source, skillId: skill.skillId }).pipe(
    Effect.as(Message.SucceededInstall({ skill })),
    Effect.catch((error) => Effect.succeed(Message.FailedInstall({ error: errorMessage(error) || "Install failed." }))),
  ),
})

const UninstallSkill = Command.define("UninstallSkill", {
  args: { name: Schema.String },
  messages: [Message.SucceededUninstall, Message.FailedUninstall],
  execute: ({ name }) => sendCommand<SkillUninstallResult>({ type: "skills.uninstall", skillId: name }).pipe(
    Effect.as(Message.SucceededUninstall({ name })),
    Effect.catch((error) => Effect.succeed(Message.FailedUninstall({ error: errorMessage(error) || "Uninstall failed." }))),
  ),
})

// Reveal the skill's directory rather than the SKILL.md file itself.
const RevealSkill = Command.define("RevealSkillInFinder", {
  args: { skillPath: Schema.String },
  messages: [Message.CompletedReveal, Message.FailedReveal],
  execute: ({ skillPath }) => sendCommand({ type: "system.openExternal", action: "open_finder", localPath: skillPath.replace(/\/SKILL\.md$/, "") }).pipe(
    Effect.as(Message.CompletedReveal()),
    Effect.catch((error) => Effect.succeed(Message.FailedReveal({ error: errorMessage(error) || "Unable to open in Finder." }))),
  ),
})

const OpenSkillsSh = Command.define("OpenSkillOnSkillsSh", {
  args: { href: Schema.String },
  messages: [Message.CompletedOpenSkillsSh],
  execute: ({ href }) => Effect.sync(() => {
    window.open(href, "_blank", "noreferrer")
    return Message.CompletedOpenSkillsSh()
  }),
})

/**
 * Same trick as the widget rows' kebab: the "..." button opens the card's
 * context menu, at the button's bottom centre, so click and right-click
 * share one menu.
 */
const MeasureSkillActions = Command.define("MeasureSkillActions", {
  args: { name: Schema.String },
  messages: [Message.MeasuredSkillActions],
  execute: ({ name }) => Effect.sync(() => {
    const button = document.querySelector(`button[aria-label="${CSS.escape(`Open actions for ${name}`)}"]`)
    const rect = button?.getBoundingClientRect()
    return Message.MeasuredSkillActions({ name, x: rect ? rect.left + rect.width / 2 : 0, y: rect ? rect.bottom : 0 })
  }),
})

// UPDATE

const BACKEND_REQUIRED = "Backend connection required."

function loadInstalled(model: Model, app: AppModel): Return {
  if (app.connectionStatus !== "connected") {
    return { model: { ...model, installedSkills: [], installedSkillIds: [], installedError: null, installedLoading: false } }
  }
  return { model: { ...model, installedLoading: true, installedError: null }, commands: [ListInstalled()] }
}

function changeQuery(model: Model, query: string, app: AppModel): Return {
  const version = model.searchVersion + 1
  const normalizedQuery = query.trim()
  const next = { ...model, query, searchVersion: version }
  if (normalizedQuery.length < 2) {
    return { model: { ...next, results: [], searchError: null, searchLoading: false } }
  }
  if (app.connectionStatus !== "connected") {
    return { model: { ...next, results: [], searchLoading: false, searchError: BACKEND_REQUIRED } }
  }
  return {
    model: { ...next, searchLoading: true, searchError: null },
    commands: [DelaySearch({ version, query: normalizedQuery })],
  }
}

function foldMenu(model: Model, name: string, result: ReturnType<typeof ContextMenu.update>): Return {
  const lifted = liftChild(result, (menu) => ({ ...model, menus: { ...model.menus, [name]: menu } }), (message) => Message.GotMenuMessage({ name, message }))
  if (!lifted.outMessage || lifted.outMessage._tag !== "Selected") return { model: lifted.model, commands: lifted.commands }
  const chosen = menuChoice(lifted.model, name, lifted.outMessage.value)
  return { ...chosen, commands: [...lifted.commands, ...(chosen.commands ?? [])] }
}

function menuChoice(model: Model, name: string, value: string): Return {
  const skill = model.installedSkills.find((entry) => entry.name === name)
  if (!skill) return { model }
  if (value.startsWith("open:")) {
    return { model, commands: [RevealSkill({ skillPath: value.slice("open:".length) })] }
  }
  if (value === "skills-sh" && skill.source) {
    return { model, commands: [OpenSkillsSh({ href: `https://skills.sh/${skill.source}/${skill.name}` })] }
  }
  if (value === "uninstall") {
    return {
      model: { ...model, uninstallingSkillId: skill.name, operationError: null },
      commands: [UninstallSkill({ name: skill.name })],
    }
  }
  return { model }
}

export function update(model: Model, message: Message, app: AppModel): Return {
  const connected = app.connectionStatus === "connected"
  return Message.match<Return>(message, {
    MountedSection: () => loadInstalled(model, app),
    UnmountedSection: () => ({ model: init() }),
    SucceededListInstalled: ({ skills }) => ({
      model: { ...model, installedLoading: false, installedSkills: skills, installedSkillIds: skills.map((skill) => skill.name) },
    }),
    FailedListInstalled: ({ error }) => ({
      model: { ...model, installedLoading: false, installedSkills: [], installedSkillIds: [], installedError: error },
    }),
    ChangedQuery: ({ query }) => changeQuery(model, query, app),
    PressedQueryKey: ({ key }) => (key === "Escape" ? changeQuery(model, "", app) : { model }),
    ClickedClearQuery: () => changeQuery(model, "", app),
    ElapsedSearchDelay: ({ version, query }) =>
      version === model.searchVersion ? { model, commands: [SearchSkills({ version, query })] } : { model },
    SucceededSearch: ({ version, skills }) =>
      version === model.searchVersion ? { model: { ...model, results: skills, searchLoading: false } } : { model },
    FailedSearch: ({ version, error }) =>
      version === model.searchVersion ? { model: { ...model, results: [], searchError: error, searchLoading: false } } : { model },
    ClickedInstall: ({ skill }) => {
      if (!connected) return { model: { ...model, operationError: BACKEND_REQUIRED } }
      const installMessages = { ...model.installMessages }
      delete installMessages[skill.id]
      return {
        model: { ...model, installingSkillId: skill.id, operationError: null, installMessages },
        commands: [InstallSkill({ skill })],
      }
    },
    SucceededInstall: ({ skill }) => {
      const installed = {
        ...model,
        installingSkillId: null,
        installedSkillIds: model.installedSkillIds.includes(skill.skillId) ? model.installedSkillIds : [...model.installedSkillIds, skill.skillId],
        installMessages: { ...model.installMessages, [skill.id]: "Installed globally" },
      }
      return loadInstalled(installed, app)
    },
    FailedInstall: ({ error }) => ({ model: { ...model, installingSkillId: null, operationError: error } }),
    SucceededUninstall: ({ name }) => {
      const installMessages = Object.fromEntries(Object.entries(model.installMessages).filter(([key]) => !(key.endsWith(`/${name}`) || key === name)))
      return loadInstalled({
        ...model,
        uninstallingSkillId: null,
        installedSkills: model.installedSkills.filter((skill) => skill.name !== name),
        installedSkillIds: model.installedSkillIds.filter((id) => id !== name),
        installMessages,
      }, app)
    },
    FailedUninstall: ({ error }) => ({ model: { ...model, uninstallingSkillId: null, operationError: error } }),
    FailedReveal: ({ error }) => ({ model: { ...model, operationError: error } }),
    CompletedReveal: () => ({ model }),
    ClickedSkillActions: ({ name }) => ({ model, commands: [MeasureSkillActions({ name })] }),
    MeasuredSkillActions: ({ name, x, y }) => {
      // A right-button press at the point, then the contextmenu event.
      const pressed = foldMenu(model, name, ContextMenu.update(menuFor(model, name), ContextMenu.Message.PressedTrigger({ pointerType: "mouse", button: 2, x, y })))
      const opened = foldMenu(pressed.model, name, ContextMenu.update(menuFor(pressed.model, name), ContextMenu.Message.RequestedContextMenu()))
      return { model: opened.model, commands: [...(pressed.commands ?? []), ...(opened.commands ?? [])] }
    },
    GotMenuMessage: ({ name, message: child }) => {
      if (child._tag === "ChoseItem" && child.value.startsWith("open:") && !connected) {
        const closed = foldMenu(model, name, ContextMenu.update(menuFor(model, name), child))
        return { ...closed, model: { ...closed.model, operationError: BACKEND_REQUIRED } }
      }
      return foldMenu(model, name, ContextMenu.update(menuFor(model, name), child))
    },
    GotTooltipMessage: ({ key, message: child }) => {
      const lifted = liftChild(
        Tooltip.update(tooltipFor(model, key), child),
        (tooltip) => ({ ...model, tooltips: { ...model.tooltips, [key]: tooltip } }),
        (tooltipMessage) => Message.GotTooltipMessage({ key, message: tooltipMessage }),
      )
      return { model: lifted.model, commands: lifted.commands }
    },
    CompletedOpenSkillsSh: () => ({ model }),
  })
}

// VIEW

/** Raw harness icons for the providers that can invoke this skill (root-attributed). */
function skillProviderIcons(model: Model, skillName: string, providers: ReadonlyArray<AgentProvider>, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class("flex shrink-0 items-center gap-2 text-muted-foreground")], providers.map((provider) => {
    const key = `${skillName}:${provider}`
    const Icon = PROVIDER_ICONS[provider]
    return h.submodel({
      slotId: `tooltip-${key}`,
      model: tooltipFor(model, key),
      view: Tooltip.view,
      viewInputs: {
        content: () => [PROVIDER_LABELS[provider]],
        side: "top",
        align: "center",
        toView: ({ trigger, portal }: Tooltip.RenderInfo) => h.span([
          ...trigger,
          h.AriaLabel(`${skillName} is available in ${PROVIDER_LABELS[provider]}`),
          h.Class("inline-flex"),
        ], [Icon({ class: "h-3.5 w-3.5" }, h), portal]),
      },
      toParentMessage: (message) => Message.GotTooltipMessage({ key, message }),
    })
  }))
}

const DESTRUCTIVE_ITEM_CLASS = "text-destructive dark:text-red-400 hover:bg-destructive/10 focus:bg-destructive/10 dark:hover:bg-red-500/20 dark:focus:bg-red-500/20"
// The menu's heading ("Added via npx skills"). The menu primitive has no
// label entry, so it is an item that can't be chosen, drawn as the label.
const MENU_LABEL_CLASS = "rounded-none px-3 pb-1 pt-1.5 text-[11px] font-medium text-muted-foreground data-[disabled]:opacity-100"

function globalSkillCard(model: Model, skill: GlobalSkillSummary, h: HtmlBuilder<Message>): Html {
  const uninstalling = model.uninstallingSkillId === skill.name
  const href = skill.source ? `https://skills.sh/${skill.source}/${skill.name}` : null
  const description = skill.description || skill.source || skill.paths[0] || ""
  const items: ContextMenu.MenuEntry[] = [
    ContextMenu.item({ value: "label", disabled: true, className: MENU_LABEL_CLASS }),
    ContextMenu.separator(),
    ...skill.paths.map((skillPath) => ContextMenu.item({ value: `open:${skillPath}` })),
    ...(href ? [ContextMenu.item({ value: "skills-sh" })] : []),
    ...(skill.source ? [ContextMenu.item({ value: "uninstall", disabled: uninstalling, className: DESTRUCTIVE_ITEM_CLASS })] : []),
  ]
  const renderItem = (value: string): ReadonlyArray<Html | string> => {
    if (value === "label") return [skill.source ? "Added via npx skills" : "Added by you"]
    if (value === "skills-sh") return [ExternalLink({ class: "h-3.5 w-3.5" }, h), h.span([h.Class("text-xs font-medium")], ["View on skills.sh"])]
    if (value === "uninstall") return [Trash2({ class: "h-3.5 w-3.5" }, h), h.span([h.Class("text-xs font-medium")], ["Uninstall"])]
    const skillPath = value.slice("open:".length)
    return [
      FolderOpen({ class: "h-3.5 w-3.5" }, h),
      h.span([h.Class("text-xs font-medium")], [skill.paths.length > 1 ? `Open ${formatSkillLocation(skillPath)}` : "Open in Finder"]),
    ]
  }
  return h.submodel({
    slotId: `menu-${skill.name}`,
    model: menuFor(model, skill.name),
    view: ContextMenu.view,
    viewInputs: {
      items,
      renderItem,
      toView: ({ trigger, portal }: ContextMenu.RenderInfo) => h.keyed("div")(skill.name, [
        ...trigger,
        h.Class("flex min-w-0 items-center justify-between gap-4 px-4 py-2.5"),
      ], [
        h.div([h.Class("min-w-0 flex-1")], [
          h.div([h.Class("truncate text-sm font-medium text-foreground")], [skill.name]),
          // Full-width rows fit most descriptions on one line; a narrow
          // column gets a second line rather than an ellipsis mid-sentence.
          description
            ? h.div([h.Class("mt-0.5 line-clamp-2 text-[13px] leading-5 text-muted-foreground @2xl:line-clamp-1")], [description])
            : null,
        ]),
        h.div([h.Class("flex shrink-0 items-center gap-3")], [
          skillProviderIcons(model, skill.name, skill.providers, h),
          h.button([
            h.Type("button"),
            h.AriaLabel(`Open actions for ${skill.name}`),
            h.OnClick(Message.ClickedSkillActions({ name: skill.name })),
            h.Class("touch-manipulation flex h-7 w-7 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"),
          ], [uninstalling ? Loader2({ class: "h-3.5 w-3.5 animate-spin" }, h) : Ellipsis({ class: "h-4 w-4 shrink-0" }, h)]),
        ]),
        portal,
      ]),
    },
    toParentMessage: (message) => Message.GotMenuMessage({ name: skill.name, message }),
  })
}

function skillResultCard(model: Model, skill: SkillSearchResult, h: HtmlBuilder<Message>): Html {
  const installing = model.installingSkillId === skill.id
  const installed = model.installedSkillIds.includes(skill.skillId)
  const message = model.installMessages[skill.id]
  return h.keyed("div")(skill.id, [h.Class("flex min-w-0 items-center justify-between gap-4 px-4 py-2.5")], [
    h.div([h.Class("min-w-0 flex-1")], [
      h.div([h.Class("truncate text-sm font-medium text-foreground")], [skill.name]),
      h.div([h.Class("mt-0.5 truncate text-[13px] leading-5 text-muted-foreground")], [`${skill.source} · ${formatInstallCount(skill.installs)}`]),
      installed && message ? h.div([h.Class("mt-0.5 truncate text-xs text-emerald-500")], [message]) : null,
    ]),
    h.div([h.Class("flex shrink-0 items-center gap-2")], [
      h.a([
        h.Href(`https://skills.sh/${skill.id}`),
        h.Target("_blank"),
        h.Rel("noreferrer"),
        h.AriaLabel(`View ${skill.name} on skills.sh`),
        h.Class("touch-manipulation inline-flex h-7 w-7 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"),
      ], [ExternalLink({ class: "h-4 w-4" }, h)]),
      settingsActionButton({
        disabled: installing || installed,
        onClick: Message.ClickedInstall({ skill }),
        ...(installing ? { icon: Loader2({ class: "animate-spin" }, h) } : {}),
      }, [installed ? "Installed" : installing ? "Installing" : "Get"], h),
    ]),
  ])
}

/** Labels the installed and skills.sh halves of the card while a search is on. */
function skillsSubheader(text: string, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class("bg-muted/40 px-4 py-1.5 text-xs text-slate-500 dark:text-slate-400")], [text])
}

function skillsMessageRow(text: string, tone: "error" | undefined, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class(cn("whitespace-pre-wrap break-words px-4 py-3 text-sm", tone === "error" ? "text-destructive" : "text-muted-foreground"))], [text])
}

const SectionMount = makeSectionMount("SettingsSkillsSection", Message.MountedSection, () => Message.MountedSection())

export const view = Submodel.defineView<Model, Message, SectionViewInputs>((model, { switched }, h) => {
  // One query does both jobs: it filters what's installed right away and,
  // from two characters, searches skills.sh for more to add.
  const normalizedFilter = model.query.trim().toLowerCase()
  const filteredInstalledSkills = normalizedFilter
    ? model.installedSkills.filter((skill) =>
      [skill.name, skill.description, skill.source].some((field) => field?.toLowerCase().includes(normalizedFilter))
    )
    : model.installedSkills
  const searchingRegistry = model.query.trim().length >= 2

  return sectionContainer({
    sectionId: "skills",
    switched,
    mount: SectionMount(),
    unmounted: Message.UnmountedSection(),
    label: sectionLabel("skills"),
    subtitle: sectionSubtitle("skills"),
  }, [
    h.div([h.Class("flex flex-col gap-4")], [
      model.operationError ? settingsNotice({ class: "font-mono text-xs" }, [model.operationError], h) : null,
      h.div([h.Class(SETTINGS_LIST_CARD_CLASS)], [
        // The search field is the card's header row, on the card's own
        // surface rather than a separate input box above it.
        h.div([h.Class("flex h-11 items-center gap-2.5 px-4")], [
          Search({ class: "h-4 w-4 shrink-0 text-muted-foreground" }, h),
          h.input([
            h.Type("text"),
            h.Role("searchbox"),
            h.AriaLabel("Filter installed skills or search skills.sh"),
            h.Value(model.query),
            h.OnInput((query) => Message.ChangedQuery({ query })),
            h.OnKeyDown((key) => Message.PressedQueryKey({ key })),
            h.Placeholder(model.installedSkills.length > 0
              ? `Filter ${model.installedSkills.length} installed, or add from skills.sh`
              : "Add skills from skills.sh"),
            h.Spellcheck(false),
            h.Autocomplete("off"),
            h.Class("min-w-0 flex-1 bg-transparent text-sm text-foreground outline-none placeholder:text-muted-foreground"),
          ]),
          model.searchLoading || model.installedLoading ? Loader2({ class: "h-4 w-4 shrink-0 animate-spin text-muted-foreground" }, h) : null,
          model.query
            ? h.button([
              h.Type("button"),
              h.AriaLabel("Clear skills search"),
              h.OnClick(Message.ClickedClearQuery()),
              h.Class("touch-manipulation inline-flex h-6 w-6 shrink-0 items-center justify-center text-muted-foreground transition-colors hover:text-foreground"),
            ], [X({ class: "h-3.5 w-3.5" }, h)])
            : null,
        ]),

        model.installedError ? skillsMessageRow(model.installedError, "error", h) : null,

        searchingRegistry ? skillsSubheader("Installed", h) : null,
        ...filteredInstalledSkills.map((skill) => globalSkillCard(model, skill, h)),
        !model.installedLoading && !model.installedError && filteredInstalledSkills.length === 0
          ? skillsMessageRow(model.installedSkills.length === 0
            ? "No global skills installed yet. Search above to add one."
            : `No installed skills match “${model.query.trim()}”.`, undefined, h)
          : null,

        ...(searchingRegistry
          ? [
            skillsSubheader("From skills.sh", h),
            model.searchError ? skillsMessageRow(model.searchError, "error", h) : null,
            ...model.results.map((skill) => skillResultCard(model, skill, h)),
            !model.searchLoading && !model.searchError && model.results.length === 0
              ? skillsMessageRow("No skills found on skills.sh.", undefined, h)
              : null,
          ]
          : []),
      ]),
    ]),
  ], h)
})
