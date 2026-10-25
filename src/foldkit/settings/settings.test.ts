import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Scene, Story } from "foldkit/test"
import { fromString } from "foldkit/url"
import type { AppSettingsSnapshot, LocalProjectsSnapshot } from "../../shared/types"
import { AppAction } from "../app/action"
import type { Flags, Model as AppModel } from "../app/model"
import { SliceOutMessage } from "../app/slice"
import * as Stores from "../app/stores"
import { init as initApp } from "../app/update"
import * as TerminalPreferences from "../core/stores/terminalPreferences"
import * as Select from "../ui/select"
import * as Changelog from "./changelog"
import * as CloudPair from "./cloud-pair"
import * as General from "./general"
import { ContinueAppActions, FetchAuthStatus, init, Message, PageMount, update, view } from "./index"
import * as Keybindings from "./keybindings"
import * as Providers from "./providers"
import { BlurActiveElement } from "./shared"
import * as Skills from "./skills"
import * as Usage from "./usage"

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  clear() { this.values.clear() }
  key() { return null }
  get length() { return this.values.size }
}

const PROJECTS: LocalProjectsSnapshot = {
  machine: { id: "local", displayName: "Your Mac", platform: "darwin" },
  projects: [{ localPath: "/Users/you/Projects/tidepool", title: "tidepool", source: "saved", lastOpenedAt: 0, chatCount: 3 }],
}

function boot(path: string): AppModel {
  const flags: Flags = {
    sidebarCollapsed: false,
    systemTheme: "dark",
    initialAppSettings: null,
    stores: Stores.load(new MemoryStorage() as unknown as Storage),
  }
  return initApp(flags, Option.getOrThrow(fromString(`http://localhost${path}`))).model
}

/** The root as the page sees it once the socket is up and the projects have arrived. */
function connectedApp(path = "/settings/general", overrides: Partial<AppModel> = {}): AppModel {
  return { ...boot(path), connectionStatus: "connected", localProjectsReady: true, localProjects: PROJECTS, ...overrides }
}

function withSettings(app: AppModel, settings: Partial<AppSettingsSnapshot>): AppModel {
  const current = app.stores.appSettings
  return { ...app, stores: { ...app.stores, appSettings: { ...current, settings: { ...(current.settings ?? {}), ...settings } as AppSettingsSnapshot } } }
}

const updateWith = (app: AppModel) => (model: ReturnType<typeof init>, message: Message) => update(model, message, app)
const requested = (action: AppAction) => SliceOutMessage.RequestedAppAction({ action })
const write = (patch: object) => AppAction.WriteAppSettings({ patch })
const terminalStore = (message: TerminalPreferences.Message) =>
  AppAction.Store({ message: Stores.Message.GotTerminalPreferencesMessage({ message }) })
const general = (message: General.Message) => Message.GotGeneralMessage({ message })

describe("settings page: navigation and the shell", () => {
  test("a section button navigates; Back opens the app sidebar", () => {
    const app = connectedApp()
    const clicked = update(init(), Message.ClickedSection({ id: "skills" }), app)
    expect(clicked.outMessage).toEqual(requested(AppAction.Navigate({ path: "/settings/skills", replace: false })))
    expect(update(init(), Message.ClickedBack(), app).outMessage).toEqual(requested(AppAction.OpenSidebar()))
  })

  test("the page asks /auth/status once mounted; Sign out shows only when it's on, and fires once", () => {
    Story.story(
      updateWith(connectedApp()),
      Story.given(init()),
      Story.message(Message.MountedPage()),
      Story.Command.expectExact(FetchAuthStatus),
      Story.Command.resolve(FetchAuthStatus, Message.ReceivedAuthStatus({ enabled: true })),
      Story.model((model) => {
        expect(model.authEnabled).toBe(true)
        expect(model.openedOn).toBe("general")
      }),
      Story.message(Message.ClickedSignOut()),
      Story.expectOutMessage(requested(AppAction.SignOut())),
      Story.model((model) => expect(model.signingOut).toBe(true)),
      Story.message(Message.ClickedSignOut()),
      Story.expectNoOutMessage(),
    )
  })

  test("an unknown section shows General and replaces its URL with /settings/general once General mounts", () => {
    const app = connectedApp("/settings/nope")
    const mounted = update(init(), general(General.Message.MountedSection()), app)
    expect(mounted.model.activeSection).toBe("general")
    expect(mounted.outMessage).toEqual(requested(AppAction.Navigate({ path: "/settings/general", replace: true })))
    // A known section mounting asks for nothing.
    expect(update(init(), general(General.Message.MountedSection()), connectedApp()).outMessage).toBeUndefined()
  })

  test("a section mounting marks it active (gating its Subscriptions); a section shown after the first one fades in", () => {
    const app = connectedApp("/settings/usage")
    const page = update(init(), Message.MountedPage(), app).model
    const usage = update(page, Message.GotUsageMessage({ message: Usage.Message.MountedSection() }), app).model
    expect(usage.activeSection).toBe("usage")
    expect(usage.switched).toBe(false)
    const keys = update(usage, Message.GotKeybindingsMessage({ message: Keybindings.Message.MountedSection() }), connectedApp("/settings/keybindings")).model
    expect(keys.activeSection).toBe("keybindings")
    expect(keys.switched).toBe(true)
    // The old section unmounting after the new one mounted leaves the new one active.
    const left = update(keys, Message.GotUsageMessage({ message: Usage.Message.UnmountedSection() }), app).model
    expect(left.activeSection).toBe("keybindings")
  })

  test("a section's actions run in order, one update each (store change, then the settings write)", () => {
    const app = connectedApp()
    const changed = update(init(), general(General.Message.ChangedField({ id: "scrollback", text: "4000", base: "1000" })), app).model
    Story.story(
      updateWith(app),
      Story.given(changed),
      Story.message(general(General.Message.BlurredField({ id: "scrollback" }))),
      Story.expectOutMessage(requested(terminalStore(TerminalPreferences.Message.ChangedScrollbackLines({ scrollbackLines: 4000 })))),
      Story.Command.resolve(ContinueAppActions, Message.ContinuedAppActions({ actions: [write({ terminal: { scrollbackLines: 4000 } })] })),
      Story.expectOutMessage(requested(write({ terminal: { scrollbackLines: 4000 } }))),
      Story.Command.expectNone(),
    )
  })
})

describe("settings › general", () => {
  const app = connectedApp()
  const run = (model: General.Model, message: General.Message, at: AppModel = app) => General.update(model, message, at)

  test("switches write their setting", () => {
    expect(run(General.init(), General.Message.ToggledChatTabs({ checked: true })).outMessage?.actions).toEqual([write({ chatTabsEnabled: true })])
    expect(run(General.init(), General.Message.ToggledAnalytics({ checked: false })).outMessage?.actions).toEqual([write({ analyticsEnabled: false })])
  })

  test("Transcript Window commits on blur, rounded; garbage drops the draft", () => {
    const typed = run(General.init(), General.Message.ChangedField({ id: "transcriptWindow", text: "12.4", base: "50" })).model
    expect(General.fieldValue("transcriptWindow", app)).toBe("50")
    expect(run(typed, General.Message.BlurredField({ id: "transcriptWindow" })).outMessage?.actions).toEqual([write({ transcript: { windowAssistantMessages: 12 } })])
    const garbage = run(General.init(), General.Message.ChangedField({ id: "transcriptWindow", text: "abc", base: "50" })).model
    const blurred = run(garbage, General.Message.BlurredField({ id: "transcriptWindow" }))
    expect(blurred.outMessage).toBeUndefined()
    expect(blurred.model.drafts.transcriptWindow).toBeNull()
  })

  test("Enter in a field commits and blurs it; other keys do nothing", () => {
    const typed = run(General.init(), General.Message.ChangedField({ id: "newProjectsDirectory", text: " ~/Code ", base: "~/Kanna" })).model
    const entered = run(typed, General.Message.PressedFieldKey({ id: "newProjectsDirectory", key: "Enter" }))
    expect(entered.outMessage?.actions).toEqual([write({ newProjectsDirectory: "~/Code" })])
    expect(entered.commands?.map((command) => command.name)).toEqual([BlurActiveElement.name])
    expect(run(typed, General.Message.PressedFieldKey({ id: "newProjectsDirectory", key: "a" })).outMessage).toBeUndefined()
  })

  test("an unchanged projects directory writes nothing", () => {
    const current = General.fieldValue("newProjectsDirectory", app)
    const typed = run(General.init(), General.Message.ChangedField({ id: "newProjectsDirectory", text: `${current}  `, base: current })).model
    const blurred = run(typed, General.Message.BlurredField({ id: "newProjectsDirectory" }))
    expect(blurred.outMessage).toBeUndefined()
    expect(blurred.model.drafts.newProjectsDirectory).toBeNull()
  })

  test("a denied notification prompt saves Never, with a notice", () => {
    const resolved = run(General.init(), General.Message.ResolvedNotificationPermission({ requested: "always", permission: "denied" }))
    expect(resolved.model.error).toBe("Browser notifications are blocked or unsupported in this browser.")
    expect(resolved.outMessage?.actions[1]).toEqual(write({ chatBrowserNotificationPreference: "never" }))
  })

  test("a select reports a choice once, only for a new value, as Radix's onValueChange does", () => {
    const choose = (value: string) => General.Message.GotSelectMessage({ id: "theme", message: Select.Message.ChoseItem({ value, pointerType: "mouse" }) })
    const opened = run(General.init(), General.Message.GotSelectMessage({ id: "theme", message: Select.Message.PressedOpenKey() })).model
    // The value shown (no theme saved yet: System) is no change.
    expect(run(opened, choose("system")).outMessage).toBeUndefined()
    const chosen = run(opened, choose("light"))
    expect(chosen.outMessage?.actions).toEqual([write({ theme: "light" })])
    expect(chosen.commands?.map((command) => command.name)).toContain("SettingsApplyTheme")
    // The click after the release reaches the item again while the list closes.
    expect(run(chosen.model, choose("light")).outMessage).toBeUndefined()
  })

  test("leaving the section forgets its drafts", () => {
    const typed = run(General.init(), General.Message.ChangedField({ id: "scrollback", text: "9", base: "1000" })).model
    expect(run(typed, General.Message.UnmountedSection()).model).toEqual(General.init())
  })
})

describe("settings › providers: Model Registry", () => {
  const snapshot = (apiKey: string) => ({ provider: "custom" as const, apiKey, model: "m", baseUrl: "", faveModels: [], resolvedApiKey: apiKey }) as unknown as NonNullable<AppModel["llmProvider"]>

  test("each write's credentials check goes out when that write's answer lands, in order", () => {
    const before = connectedApp("/settings/providers", { llmProvider: snapshot("") })
    const typed = Providers.update(Providers.init(), Providers.Message.ChangedLlmField({ field: "apiKey", value: "sk-1" }), before).model
    const entered = Providers.update(typed, Providers.Message.PressedLlmFieldKey({ key: "Enter" }), before)
    expect(entered.outMessage?.actions[0]?._tag).toBe("WriteLlmProvider")
    expect(entered.commands?.map((command) => command.name)).not.toContain(Providers.ValidateLlmProvider.name)
    // The blur that follows Enter commits again.
    const blurred = Providers.update(entered.model, Providers.Message.BlurredLlmField(), before)
    expect(blurred.model.pendingValidations).toHaveLength(2)

    const first = { ...before, llmProvider: snapshot("sk-1") }
    const answered = Providers.observe(blurred.model, before, first)
    expect(answered.commands?.map((command) => command.name)).toEqual([Providers.ValidateLlmProvider.name])
    expect(answered.model.pendingValidations).toHaveLength(1)
    // Nothing on the root changed that a write answers: nothing goes out.
    expect(Providers.observe(answered.model, first, first).commands ?? []).toHaveLength(0)
    // The second write fails: its commit fails with the root's error.
    const failed = Providers.observe(answered.model, first, { ...first, commandError: "disk full" })
    expect(failed.model.pendingValidations).toHaveLength(0)
    expect(failed.model.llmProviderError).toBe("disk full")
  })
})

describe("settings › keybindings", () => {
  test("a blurred field writes every binding; Reset puts the default back and writes", () => {
    const app = connectedApp("/settings/keybindings")
    const typed = Keybindings.update(Keybindings.init(), Keybindings.Message.ChangedBinding({ action: "toggleRightSidebar", text: "cmd+shift+b", base: "" }), app).model
    const blurred = Keybindings.update(typed, Keybindings.Message.BlurredBinding(), app)
    expect(blurred.commands?.map((command) => command.name)).toEqual([Keybindings.WriteKeybindings.name])
    const reset = Keybindings.update(typed, Keybindings.Message.ClickedRestoreDefault({ action: "toggleRightSidebar" }), app)
    expect(reset.model.drafts.toggleRightSidebar?.text).not.toBe("cmd+shift+b")
    const failed = Keybindings.update(reset.model, Keybindings.Message.FailedWriteKeybindings({ error: "nope" }), app)
    expect(failed.model.error).toBe("nope")
  })
})

describe("settings › skills", () => {
  const app = connectedApp("/settings/skills")
  const skill = { id: "anthropics/skills/pdf", skillId: "pdf", name: "pdf", installs: 10, source: "anthropics/skills" }

  test("mounting lists what's installed; a search waits out the debounce and drops stale answers", () => {
    Story.story(
      (model: Skills.Model, message: Skills.Message) => Skills.update(model, message, app),
      Story.given(Skills.init()),
      Story.message(Skills.Message.MountedSection()),
      Story.Command.expectExact(Skills.ListInstalled),
      Story.Command.resolve(Skills.ListInstalled, Skills.Message.SucceededListInstalled({ skills: [] })),
      Story.message(Skills.Message.ChangedQuery({ query: "p" })),
      Story.Command.expectNone(),
      Story.message(Skills.Message.ChangedQuery({ query: "pd" })),
      Story.model((model) => expect(model.searchLoading).toBe(true)),
      Story.Command.resolve(Skills.DelaySearch, Skills.Message.ElapsedSearchDelay({ version: 2, query: "pd" })),
      Story.Command.resolve(Skills.SearchSkills, Skills.Message.SucceededSearch({ version: 2, skills: [skill] })),
      Story.model((model) => {
        expect(model.results).toHaveLength(1)
        expect(model.searchLoading).toBe(false)
      }),
      Story.message(Skills.Message.SucceededSearch({ version: 1, skills: [] })),
      Story.model((model) => expect(model.results).toHaveLength(1)),
      Story.message(Skills.Message.PressedQueryKey({ key: "Escape" })),
      Story.model((model) => {
        expect(model.query).toBe("")
        expect(model.results).toHaveLength(0)
      }),
    )
  })

  test("installing marks the result and lists again", () => {
    Story.story(
      (model: Skills.Model, message: Skills.Message) => Skills.update(model, message, app),
      Story.given(Skills.init()),
      Story.message(Skills.Message.ClickedInstall({ skill })),
      Story.model((model) => expect(model.installingSkillId).toBe(skill.id)),
      Story.Command.resolve(Skills.InstallSkill, Skills.Message.SucceededInstall({ skill })),
      Story.model((model) => {
        expect(model.installingSkillId).toBeNull()
        expect(model.installedSkillIds).toContain("pdf")
        expect(model.installMessages[skill.id]).toBe("Installed globally")
      }),
      Story.Command.resolve(Skills.ListInstalled, Skills.Message.SucceededListInstalled({ skills: [] })),
    )
  })

  test("offline, a search says the backend is needed and sends nothing", () => {
    const offline = connectedApp("/settings/skills", { connectionStatus: "disconnected" })
    const changed = Skills.update(Skills.init(), Skills.Message.ChangedQuery({ query: "pdf" }), offline)
    expect(changed.model.searchError).toBe("Backend connection required.")
    expect(changed.commands ?? []).toHaveLength(0)
  })
})

describe("settings › usage and changelog", () => {
  test("usage refreshes on mount; a refresh in flight ignores another click", () => {
    const app = connectedApp("/settings/usage")
    const mounted = Usage.update(Usage.init(), Usage.Message.MountedSection(), app)
    expect(mounted.commands?.map((command) => command.name)).toEqual([Usage.RefreshUsage.name])
    expect(Usage.update(mounted.model, Usage.Message.ClickedRefresh(), app).commands ?? []).toHaveLength(0)
    const done = Usage.update(mounted.model, Usage.Message.CompletedRefresh({ snapshot: null }), app).model
    expect(done.refreshing).toBe(false)
    expect(Usage.update(done, Usage.Message.ClickedRefresh(), app).commands?.map((command) => command.name)).toEqual([Usage.RefreshUsage.name])
  })

  test("the changelog loads on mount; a stale answer is dropped; Retry forces a reload", () => {
    const app = connectedApp("/settings/changelog")
    Story.story(
      (model: Changelog.Model, message: Changelog.Message) => Changelog.update(model, message, app),
      Story.given(Changelog.init()),
      Story.message(Changelog.Message.MountedSection()),
      Story.Command.resolve(Changelog.LoadChangelog, Changelog.Message.FailedLoadChangelog({ version: 1, error: "offline" })),
      Story.model((model) => expect(model.status).toBe("error")),
      Story.message(Changelog.Message.ClickedRetry()),
      Story.Command.expectExact(Changelog.LoadChangelog({ version: 2, force: true })),
      Story.Command.resolve(Changelog.LoadChangelog, Changelog.Message.SucceededLoadChangelog({ version: 2, releases: [] })),
      Story.model((model) => expect(model.status).toBe("success")),
    )
    // An answer to a load that has since been superseded changes nothing.
    const reloading = Changelog.update(Changelog.init(), Changelog.Message.ClickedRetry(), app).model
    expect(Changelog.update(reloading, Changelog.Message.FailedLoadChangelog({ version: 0, error: "late" }), app).model).toEqual(reloading)
  })
})

describe("settings page (Scene)", () => {
  const sceneView = (app: AppModel) => Scene.withViewInputs(view, { app })()

  test("the nav lists the sections; General's switches write their settings", () => {
    const app = withSettings(connectedApp(), { chatTabsEnabled: false })
    Scene.scene(
      { update: updateWith(app), view: sceneView(app) },
      Scene.given(init()),
      Scene.Mount.resolve(PageMount, Message.MountedPage()),
      Scene.Command.resolve(FetchAuthStatus, Message.ReceivedAuthStatus({ enabled: false })),
      Scene.Mount.resolve(General.SectionMount, General.Message.MountedSection()),
      // The section's eight selects.
      ...Array.from({ length: 8 }, () => Scene.Mount.resolve(Select.SelectTrigger, Select.Message.CompletedMountTrigger())),
      Scene.expect(Scene.text("Appearance, notifications, chats, layout, editor, and terminal.")).toExist(),
      Scene.expect(Scene.role("complementary")).toContainText("Settings"),
      Scene.expectAll(Scene.all.role("button", { name: "Skills" })).toHaveCount(2),
      Scene.expect(Scene.role("switch", { name: "Chat Tabs" })).toHaveAttr("aria-checked", "false"),
      Scene.click(Scene.role("switch", { name: "Chat Tabs" })),
      Scene.expectOutMessage(requested(write({ chatTabsEnabled: true }))),
      Scene.expect(Scene.text("Your Mac")).toExist(),
    )
  })

  test("while connecting it shows the placeholder and no footer", () => {
    const app = connectedApp("/settings/general", { connectionStatus: "connecting" })
    Scene.scene(
      { update: updateWith(app), view: sceneView(app) },
      Scene.given(init()),
      Scene.Mount.resolve(PageMount, Message.MountedPage()),
      Scene.Command.resolve(FetchAuthStatus, Message.ReceivedAuthStatus({ enabled: false })),
      Scene.expect(Scene.text("Loading machine settings…")).toExist(),
      Scene.expect(Scene.text("Projects Indexed")).toBeAbsent(),
    )
  })
})

describe("cloud pairing panel", () => {
  const waiting = { status: "waiting" as const, claimUrl: "https://kanna.sh/machine?pair=ABC" }
  const paired = { status: "paired" as const, appOrigin: "https://you.kanna.sh" }

  test("the first fetch loads it; Retry starts a session and the view swaps from the link to the result", () => {
    Story.story(
      CloudPair.update,
      Story.given(CloudPair.init()),
      Story.message(CloudPair.Message.ReceivedSession({ session: { status: "expired" }, visible: true })),
      Story.model((model) => {
        expect(model.loaded).toBe(true)
        expect(CloudPair.viewFor(model.shown)).toBe("retry")
        expect(model.swapped).toBe(true)
      }),
      Story.message(CloudPair.Message.EndedLeavingView()),
      Story.message(CloudPair.Message.ClickedRetry()),
      Story.model((model) => expect(model.starting).toBe(true)),
      Story.Command.resolve(CloudPair.StartPairSession, CloudPair.Message.StartedSession({ session: waiting, visible: true })),
      Story.model((model) => {
        expect(model.starting).toBe(false)
        expect(CloudPair.isWaiting(model)).toBe(true)
        expect(model.leaving?.key).toBe("retry")
      }),
    )
  })

  test("a change while the page is hidden waits for it to come back, then a beat", () => {
    const shown = { ...CloudPair.init(), session: waiting, shown: waiting, loaded: true }
    Story.story(
      CloudPair.update,
      Story.given(shown),
      Story.message(CloudPair.Message.ReceivedSession({ session: paired, visible: false })),
      Story.model((model) => expect(model.shown).toEqual(waiting)),
      Story.message(CloudPair.Message.ReturnedToView()),
      Story.Command.resolve(CloudPair.WaitReturnBeat, CloudPair.Message.ElapsedReturnBeat({ version: 1 })),
      Story.model((model) => expect(CloudPair.viewFor(model.shown)).toBe("paired")),
    )
  })

  test("the panel shows the link with its copy button, and the manual steps where pairing isn't supported", () => {
    const sceneView = (showOpenButton: boolean) => Scene.withViewInputs(CloudPair.view, { showOpenButton })()
    Scene.scene(
      { update: CloudPair.update, view: sceneView(true) },
      Scene.given({ ...CloudPair.init(), session: waiting, shown: waiting, loaded: true }),
      Scene.Mount.resolve(CloudPair.StageMount, CloudPair.Message.MeasuredStage({ height: 120 })),
      Scene.expect(Scene.role("link", { name: "kanna.sh/machine?pair=ABC" })).toHaveAttr("href", waiting.claimUrl),
      Scene.expect(Scene.role("link", { name: "Open link & sign in" })).toExist(),
      Scene.click(Scene.role("button", { name: "Copy link" })),
      Scene.Command.resolve(CloudPair.CopyLink, CloudPair.Message.CopiedLink({ ok: true })),
      Scene.expect(Scene.role("button", { name: "Copied" })).toExist(),
      Scene.Command.resolve(CloudPair.WaitCopied, CloudPair.Message.ElapsedCopied({ version: 1 })),
      Scene.expect(Scene.role("button", { name: "Copy link" })).toExist(),
    )
    Scene.scene(
      { update: CloudPair.update, view: sceneView(false) },
      Scene.given({ ...CloudPair.init(), session: { status: "unsupported" }, shown: { status: "unsupported" }, loaded: true }),
      Scene.Mount.resolve(CloudPair.StageMount, CloudPair.Message.MeasuredStage({ height: 80 })),
      Scene.expect(Scene.role("link", { name: "kanna.sh/fleet" })).toExist(),
      Scene.expect(Scene.role("link", { name: "Open link & sign in" })).toBeAbsent(),
    )
  })
})
