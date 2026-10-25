import { Effect, Option, Schema } from "effect"
import { Command, Mount, Submodel, Subscription } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { cn } from "../../client/lib/utils"
import { SDK_CLIENT_APP } from "../../shared/branding"
import { AppAction } from "../app/action"
import { SliceOutMessage, type AppModel, type SliceReturn, type SliceViewInputs } from "../app/slice"
import { ArrowLeft, Info, LogOut } from "../ui/icons"
import * as Changelog from "./changelog"
import * as General from "./general"
import * as Keybindings from "./keybindings"
import * as Labs from "./labs"
import * as Mac from "./mac"
import * as Mcp from "./mcp"
import * as Providers from "./providers"
import { resolveSettingsSectionId, visibleSettingsSections, type SettingsSectionId } from "./registry"
import type { SectionOutMessage, SectionReturn, SectionViewInputs } from "./section"
import { settingsNotice, settingsPlaceholder } from "./shared"
import * as Skills from "./skills"
import * as Usage from "./usage"

// The settings page at /settings/:sectionId (app/SettingsPage.tsx): the
// section list (a sidebar on desktop, a row of pills on mobile), the selected
// section (app/settings/*, one module each here) and the machine footer.
//
// A React section ran its effects while mounted; each section here reports
// `MountedSection` / `UnmountedSection` from its content element
// (activeSection.ts), which the page also uses to know which section is on
// screen: that gates the sections' Subscriptions.

export { getKeybindingsSubtitle, resolveChatBrowserNotificationPreferenceAfterPermission, shouldPreviewChatSoundChange } from "./shared"
export { listAllSettingsRowDefs, resolveSettingsSectionId, SETTINGS_ROWS, SETTINGS_SECTIONS } from "./registry"

const SectionIdSchema = Schema.Literals(["general", "mac", "providers", "mcp", "skills", "keybindings", "usage", "labs", "changelog"])

// MODEL

export const Model = Schema.Struct({
  general: General.Model,
  mac: Mac.Model,
  providers: Providers.Model,
  mcp: Mcp.Model,
  skills: Skills.Model,
  keybindings: Keybindings.Model,
  usage: Usage.Model,
  labs: Labs.Model,
  changelog: Changelog.Model,
  /** The section whose content is on screen (mounted), for its Subscriptions. */
  activeSection: Schema.NullOr(SectionIdSchema),
  /** The section the page opened on; null while the page isn't mounted. */
  openedOn: Schema.NullOr(SectionIdSchema),
  /** Another section has been shown since the page opened. */
  switched: Schema.Boolean,
  /** /auth/status said a password protects this machine: show Sign out. */
  authEnabled: Schema.Boolean,
  signingOut: Schema.Boolean,
})
export type Model = typeof Model.Type

export function init(): Model {
  return {
    general: General.init(),
    mac: Mac.init(),
    providers: Providers.init(),
    mcp: Mcp.init(),
    skills: Skills.init(),
    keybindings: Keybindings.init(),
    usage: Usage.init(),
    labs: Labs.init(),
    changelog: Changelog.init(),
    activeSection: null,
    openedOn: null,
    switched: false,
    authEnabled: false,
    signingOut: false,
  }
}

// MESSAGE

export const Message = defineMessageUnion({
  GotGeneralMessage: { message: General.Message },
  GotMacMessage: { message: Mac.Message },
  GotProvidersMessage: { message: Providers.Message },
  GotMcpMessage: { message: Mcp.Message },
  GotSkillsMessage: { message: Skills.Message },
  GotKeybindingsMessage: { message: Keybindings.Message },
  GotUsageMessage: { message: Usage.Message },
  GotLabsMessage: { message: Labs.Message },
  GotChangelogMessage: { message: Changelog.Message },
  MountedPage: {},
  UnmountedPage: {},
  /** The content arrived for this route's section id (as typed in the URL). */
  MountedContent: { sectionId: Schema.String },
  ReceivedAuthStatus: { enabled: Schema.Boolean },
  ClickedSection: { id: SectionIdSchema },
  ClickedBack: {},
  ClickedSignOut: {},
  /** The rest of a section's actions, one per update. */
  ContinuedAppActions: { actions: Schema.Array(AppAction) },
})
export type Message = typeof Message.Type

type Return = SliceReturn<Model, Message>

// COMMANDS

const FetchAuthStatus = Command.define("FetchSettingsAuthStatus", {
  messages: [Message.ReceivedAuthStatus],
  execute: Effect.promise(async () => {
    try {
      const response = await fetch("/auth/status", { method: "GET", cache: "no-store", headers: { Accept: "application/json" } })
      if (!response.ok) return Message.ReceivedAuthStatus({ enabled: false })
      const payload = await response.json() as { enabled?: boolean }
      return Message.ReceivedAuthStatus({ enabled: payload.enabled === true })
    } catch {
      return Message.ReceivedAuthStatus({ enabled: false })
    }
  }),
})

const ContinueAppActions = Command.define("ContinueSettingsAppActions", {
  args: { actions: Schema.Array(AppAction) },
  messages: [Message.ContinuedAppActions],
  execute: ({ actions }) => Effect.succeed(Message.ContinuedAppActions({ actions })),
})

// UPDATE

/** The section the route names: a visible section's id, else General. */
export function selectedSection(app: AppModel): SettingsSectionId {
  return (app.route._tag === "Settings" ? resolveSettingsSectionId(app.route.sectionId) : null) ?? "general"
}

/** Asks the root for a section's actions: the first now, the rest one update at a time. */
function runActions(model: Model, actions: ReadonlyArray<AppAction>, commands: Return["commands"] = []): Return {
  const [first, ...rest] = actions
  if (!first) return { model, commands }
  return {
    model,
    commands: rest.length > 0 ? [...(commands ?? []), ContinueAppActions({ actions: rest })] : commands,
    outMessage: SliceOutMessage.RequestedAppAction({ action: first }),
  }
}

type SectionKey = "general" | "mac" | "providers" | "mcp" | "skills" | "keybindings" | "usage" | "labs" | "changelog"

/** Runs a section's update into the page: its Model back, its Commands lifted, its actions asked for. */
function foldSection<ChildMessage extends { _tag: string }, ChildModel>(
  model: Model,
  key: SectionKey,
  result: SectionReturn<ChildModel, ChildMessage>,
  wrap: (message: ChildMessage) => Message,
  childMessage: ChildMessage,
): Return {
  let next: Model = { ...model, [key]: result.model }
  if (childMessage._tag === "MountedSection") {
    next = {
      ...next,
      activeSection: key,
      switched: next.switched || (next.openedOn !== null && next.openedOn !== key),
    }
  } else if (childMessage._tag === "UnmountedSection" && next.activeSection === key) {
    next = { ...next, activeSection: null }
  }
  const commands = Command.mapMessages(result.commands ?? [], wrap) as Return["commands"]
  const outMessage = result.outMessage as SectionOutMessage | undefined
  return outMessage ? runActions(next, outMessage.actions, commands) : { model: next, commands }
}

export function update(model: Model, message: Message, app: AppModel): Return {
  return Message.match<Return>(message, {
    GotGeneralMessage: ({ message: child }) => foldSection(model, "general", General.update(model.general, child, app), (m) => Message.GotGeneralMessage({ message: m }), child),
    GotMacMessage: ({ message: child }) => foldSection(model, "mac", Mac.update(model.mac, child, app), (m) => Message.GotMacMessage({ message: m }), child),
    GotProvidersMessage: ({ message: child }) => foldSection(model, "providers", Providers.update(model.providers, child, app), (m) => Message.GotProvidersMessage({ message: m }), child),
    GotMcpMessage: ({ message: child }) => foldSection(model, "mcp", Mcp.update(model.mcp, child, app), (m) => Message.GotMcpMessage({ message: m }), child),
    GotSkillsMessage: ({ message: child }) => foldSection(model, "skills", Skills.update(model.skills, child, app), (m) => Message.GotSkillsMessage({ message: m }), child),
    GotKeybindingsMessage: ({ message: child }) => foldSection(model, "keybindings", Keybindings.update(model.keybindings, child, app), (m) => Message.GotKeybindingsMessage({ message: m }), child),
    GotUsageMessage: ({ message: child }) => foldSection(model, "usage", Usage.update(model.usage, child, app), (m) => Message.GotUsageMessage({ message: m }), child),
    GotLabsMessage: ({ message: child }) => foldSection(model, "labs", Labs.update(model.labs, child, app), (m) => Message.GotLabsMessage({ message: m }), child),
    GotChangelogMessage: ({ message: child }) => foldSection(model, "changelog", Changelog.update(model.changelog, child, app), (m) => Message.GotChangelogMessage({ message: m }), child),
    MountedPage: () => ({
      model: { ...model, openedOn: selectedSection(app), switched: false },
      commands: [FetchAuthStatus()],
    }),
    UnmountedPage: () => ({ model: { ...model, openedOn: null, switched: false, signingOut: false } }),
    // An unknown section shows General and puts /settings/general in the
    // address bar, replacing the bad one.
    MountedContent: ({ sectionId }) => resolveSettingsSectionId(sectionId)
      ? { model }
      : runActions(model, [AppAction.Navigate({ path: "/settings/general", replace: true })]),
    ReceivedAuthStatus: ({ enabled }) => ({ model: { ...model, authEnabled: enabled } }),
    ClickedSection: ({ id }) => runActions(model, [AppAction.Navigate({ path: `/settings/${id}`, replace: false })]),
    ClickedBack: () => runActions(model, [AppAction.OpenSidebar()]),
    // The root signs out and reloads the page; "Signing out..." until then.
    ClickedSignOut: () => model.signingOut ? { model } : runActions({ ...model, signingOut: true }, [AppAction.SignOut()]),
    ContinuedAppActions: ({ actions }) => runActions(model, actions),
  })
}

// SUBSCRIPTIONS: a section's run while its content is on screen.

const gate = (id: SettingsSectionId) => (model: Model) => model.activeSection === id

export const subscriptions = Subscription.aggregate(
  Subscription.lift(Usage.subscriptions)<Model, Message>({
    read: (model) => Option.some(model.usage),
    toParentMessage: (message) => Message.GotUsageMessage({ message }),
    when: gate("usage"),
  }),
  Subscription.lift(Mcp.subscriptions)<Model, Message>({
    read: (model) => Option.some(model.mcp),
    toParentMessage: (message) => Message.GotMcpMessage({ message }),
    when: gate("mcp"),
  }),
  Subscription.lift(Mac.subscriptions)<Model, Message>({
    read: (model) => Option.some(model.mac),
    toParentMessage: (message) => Message.GotMacMessage({ message }),
    when: gate("mac"),
  }),
)

// VIEW

const PageMount = Mount.define("SettingsPage", {
  messages: [Message.MountedPage],
  execute: () => Effect.succeed(Message.MountedPage()),
})

const ContentMount = Mount.define("SettingsPageContent", {
  args: { sectionId: Schema.String },
  messages: [Message.MountedContent],
  execute: ({ sectionId }) => Effect.succeed(Message.MountedContent({ sectionId })),
})

/** SDK_CLIENT_APP's version. */
const APP_VERSION = SDK_CLIENT_APP.split("/")[1] ?? "unknown"

// This Mac shows only in Kanna for Mac (registry.isSettingsSectionVisible);
// the answer is a property of the page, so it's read once.
const sidebarItems = visibleSettingsSections()

function sectionView(model: Model, id: SettingsSectionId, inputs: SectionViewInputs, h: HtmlBuilder<Message>): Html {
  switch (id) {
    case "general":
      return h.submodel({ slotId: "general", model: model.general, view: General.view, viewInputs: inputs, toParentMessage: (message) => Message.GotGeneralMessage({ message }) })
    case "mac":
      return h.submodel({ slotId: "mac", model: model.mac, view: Mac.view, viewInputs: inputs, toParentMessage: (message) => Message.GotMacMessage({ message }) })
    case "providers":
      return h.submodel({ slotId: "providers", model: model.providers, view: Providers.view, viewInputs: inputs, toParentMessage: (message) => Message.GotProvidersMessage({ message }) })
    case "mcp":
      return h.submodel({ slotId: "mcp", model: model.mcp, view: Mcp.view, viewInputs: inputs, toParentMessage: (message) => Message.GotMcpMessage({ message }) })
    case "skills":
      return h.submodel({ slotId: "skills", model: model.skills, view: Skills.view, viewInputs: inputs, toParentMessage: (message) => Message.GotSkillsMessage({ message }) })
    case "keybindings":
      return h.submodel({ slotId: "keybindings", model: model.keybindings, view: Keybindings.view, viewInputs: inputs, toParentMessage: (message) => Message.GotKeybindingsMessage({ message }) })
    case "usage":
      return h.submodel({ slotId: "usage", model: model.usage, view: Usage.view, viewInputs: inputs, toParentMessage: (message) => Message.GotUsageMessage({ message }) })
    case "labs":
      return h.submodel({ slotId: "labs", model: model.labs, view: Labs.view, viewInputs: inputs, toParentMessage: (message) => Message.GotLabsMessage({ message }) })
    case "changelog":
      return h.submodel({ slotId: "changelog", model: model.changelog, view: Changelog.view, viewInputs: inputs, toParentMessage: (message) => Message.GotChangelogMessage({ message }) })
  }
}

function footerCell(label: string, value: string | number, hidden: boolean, h: HtmlBuilder<Message>): Html {
  return h.div(hidden ? [h.Class("hidden md:block")] : [], [
    h.div([h.Class("mb-1 uppercase tracking-wide text-[11px] text-muted-foreground/80")], [label]),
    h.div([h.Class("text-foreground/80")], [String(value)]),
  ])
}

export const view = Submodel.defineView<Model, Message, SliceViewInputs>((model, { app }, h) => {
  const rawSectionId = app.route._tag === "Settings" ? app.route.sectionId : "general"
  const selectedPage = selectedSection(app)
  const isConnecting = app.connectionStatus === "connecting" || !app.localProjectsReady
  const machineName = app.localProjects?.machine.displayName ?? "Unavailable"
  const projectCount = app.localProjects?.projects.length ?? 0
  const showFooter = !isConnecting
  // Picking another section fades its content in, so the swap reads as one
  // page changing rather than a cut. Opening Settings doesn't: that is often
  // ⌘, and a shortcut should land at once.
  const switched = model.switched || (model.openedOn !== null && model.openedOn !== selectedPage)
  const signOutLabel = model.signingOut ? "Signing out..." : "Sign out"

  return h.div([
    h.DataAttribute("settings-page", ""),
    h.Class("relative flex h-full flex-1 min-w-0 bg-background"),
    h.OnMount(PageMount()),
    h.OnUnmount(Message.UnmountedPage()),
  ], [
    // The Mac app's title bar across the settings page: it drags the window.
    // Only the sidebar's "Settings" heading and the content's md:pt-16 reach
    // up under it, so it covers nothing clickable.
    h.div([
      h.DataAttribute("window-drag", ""),
      h.AriaHidden(true),
      h.Class("hidden mac-app:md:block absolute inset-x-0 top-0 z-10 h-[calc(var(--mac-traffic-lights-center)*2)]"),
    ], []),
    h.div([h.Class("flex min-w-0 flex-1")], [
      h.aside([h.Class(`hidden w-[200px] shrink-0 md:block ${showFooter ? "pb-[89px]" : ""}`)], [
        // In the Mac app the traffic lights and the pinned sidebar toggle sit
        // over this column's top when the app sidebar is collapsed.
        h.div([h.Class("flex flex-col gap-1 px-4 py-6 mac-app:md:pt-[43px]")], [
          h.div([h.Class("px-3 pb-5 text-[22px] font-extrabold tracking-[-0.5px] text-foreground")], ["Settings"]),
          ...sidebarItems.map((item) => h.keyed("button")(item.id, [
            h.Type("button"),
            h.OnClick(Message.ClickedSection({ id: item.id })),
            h.Class(`cursor-pointer rounded-lg px-3 py-2 text-sm ${
              item.id === selectedPage
                ? "bg-muted font-medium text-foreground"
                : "text-muted-foreground hover:bg-muted/50 hover:text-foreground"
            }`),
          ], [
            h.div([h.Class("flex items-center gap-2.5")], [
              item.icon({ class: "h-4 w-4 shrink-0" }, h),
              h.span([], [item.label]),
            ]),
          ])),
          model.authEnabled
            ? h.button([
              h.Type("button"),
              h.OnClick(Message.ClickedSignOut()),
              ...(model.signingOut ? [h.Disabled(true)] : []),
              h.Class("cursor-pointer rounded-lg px-3 py-2 text-sm text-muted-foreground hover:bg-muted/50 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-50"),
            ], [
              h.div([h.Class("flex items-center gap-2.5")], [
                LogOut({ class: "h-4 w-4 shrink-0" }, h),
                h.span([], [signOutLabel]),
              ]),
            ])
            : null,
        ]),
      ]),

      h.div([h.Class("min-w-0 flex-1 overflow-y-auto")], [
        h.div([h.Class("border-b border-border py-2 md:hidden h-[63px] pl-1 md:h-auto")], [
          h.div([h.Class("overflow-x-auto pr-4 [scrollbar-width:none] [&::-webkit-scrollbar]:hidden")], [
            h.div([h.Class("flex min-w-max items-center gap-2")], [
              h.div([h.Class(" sticky left-0 bg-gradient-to-r from-background via-background/90 to-background/10 pl-2 pr-1 py-1")], [
                h.button([
                  h.Type("button"),
                  h.OnClick(Message.ClickedBack()),
                  h.Class("flex shrink-0 items-center p-2 text-sm text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"),
                  h.AriaLabel("Back"),
                  h.Title("Back"),
                ], [ArrowLeft({ class: "h-[20px] w-[20px] shrink-0" }, h)]),
              ]),
              ...sidebarItems.map((item) => h.keyed("button")(item.id, [
                h.Type("button"),
                h.OnClick(Message.ClickedSection({ id: item.id })),
                h.Class(cn(
                  "flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors",
                  item.id === selectedPage
                    ? "border-transparent bg-muted font-medium text-foreground"
                    : "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                )),
              ], [
                item.icon({ class: "h-4 w-4 shrink-0" }, h),
                h.span([h.Class("whitespace-nowrap")], [item.label]),
              ])),
              model.authEnabled
                ? h.button([
                  h.Type("button"),
                  h.OnClick(Message.ClickedSignOut()),
                  ...(model.signingOut ? [h.Disabled(true)] : []),
                  h.Class(cn(
                    "flex shrink-0 items-center gap-2 rounded-full border px-3 py-2 text-sm transition-colors",
                    "border-border bg-background text-muted-foreground hover:bg-muted/50 hover:text-foreground",
                    "disabled:cursor-not-allowed disabled:opacity-50",
                  )),
                ], [
                  LogOut({ class: "h-4 w-4 shrink-0" }, h),
                  h.span([h.Class("whitespace-nowrap")], [signOutLabel]),
                ])
                : null,
            ]),
          ]),
        ]),

        // Keyed by the section id as the URL has it, so arriving at an
        // unknown one mounts it afresh and its redirect runs.
        h.keyed("div")(rawSectionId, [
          h.Class("w-full px-4 pb-32 pt-8 md:px-6 md:pt-16"),
          h.OnMount(ContentMount({ sectionId: rawSectionId })),
        ], [
          isConnecting
            ? settingsPlaceholder({ loading: true, class: "mx-auto max-w-4xl" }, ["Loading machine settings…"], h)
            : sectionView(model, selectedPage, { app, appVersion: APP_VERSION, switched }, h),
          app.commandError
            ? settingsNotice({ class: "mx-auto mt-6 flex max-w-4xl items-start gap-3" }, [
              Info({ class: "mt-0.5 h-4 w-4 flex-shrink-0" }, h),
              h.span([], [app.commandError]),
            ], h)
            : null,
        ]),
      ]),
    ]),

    showFooter
      ? h.div([h.Class("absolute bottom-0 left-0 right-0 border-t border-border bg-background/95 backdrop-blur supports-[backdrop-filter]:bg-background/80")], [
        h.div([h.Class("px-6 py-[14.25px]")], [
          h.div([h.Class("grid gap-3 text-xs text-muted-foreground grid-cols-2 lg:grid-cols-4")], [
            footerCell("Machine", machineName, false, h),
            footerCell("Connection", app.connectionStatus, true, h),
            footerCell("Projects Indexed", projectCount, true, h),
            footerCell("App Version", APP_VERSION, false, h),
          ]),
        ]),
      ])
      : null,
  ])
})
