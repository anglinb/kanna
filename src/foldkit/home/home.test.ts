import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Scene, Story } from "foldkit/test"
import { fromString } from "foldkit/url"
import type { GitHubRecentReposResult, LocalProjectsSnapshot } from "../../shared/types"
import { AppAction } from "../app/action"
import type { Flags, Model as AppModel } from "../app/model"
import { SliceOutMessage } from "../app/slice"
import * as Stores from "../app/stores"
import * as Connection from "../core/stores/connection"
import { init as initApp } from "../app/update"
import { FetchRecentRepos, MountPage, MountProjectsList, OpenArchive, OpenCommandPalette, WaitArrivalFade } from "./commands"
import { defaultEnvironment } from "./environment"
import { init, Message, type Model } from "./model"
import { SETUP_HELP_AFTER_MS, update } from "./update"
import { view } from "./view"

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
  projects: [
    { localPath: "/Users/you/Projects/tidepool", title: "tidepool", source: "saved", lastOpenedAt: Date.now() - 4 * 60_000, chatCount: 3 },
    { localPath: "/Users/you/Projects/ledger-api", title: "ledger-api", source: "saved", lastOpenedAt: Date.now() - 60_000, chatCount: 1 },
  ],
}

const REPOS: GitHubRecentReposResult = {
  available: true,
  login: "you",
  repos: [{ nameWithOwner: "you/harbor", description: "Boats", pushedAt: new Date().toISOString(), isPrivate: true, owner: "you" }],
}

function boot(path = "/home"): AppModel {
  const flags: Flags = {
    sidebarCollapsed: false,
    systemTheme: "dark",
    initialAppSettings: null,
    stores: Stores.load(new MemoryStorage() as unknown as Storage),
  }
  return initApp(flags, Option.getOrThrow(fromString(`http://localhost${path}`))).model
}

/** The root as the page sees it once the socket is up and the projects have arrived. */
function connectedApp(overrides: Partial<AppModel> = {}): AppModel {
  return { ...boot(), connectionStatus: "connected", localProjectsReady: true, localProjects: PROJECTS, ...overrides }
}

const mounted: Model = { ...init(), environment: { ...defaultEnvironment, nowMs: Date.now() } }

function updateWith(app: AppModel) {
  return (model: Model, message: Message) => update(model, message, app)
}

const requested = (action: AppAction) => SliceOutMessage.RequestedAppAction({ action })

describe("home: recent repos", () => {
  test("the list's mount fetches them; the answer fades its rows in once", () => {
    Story.story(
      updateWith(connectedApp()),
      Story.given(mounted),
      Story.message(Message.MountedProjectsList({ ghStatus: "none" })),
      Story.Command.expectExact(FetchRecentRepos({ version: 1 })),
      Story.Command.resolve(FetchRecentRepos, Message.ReceivedRecentRepos({ version: 1, result: REPOS, at: 1_000 })),
      Story.model((model) => {
        expect(model.recentRepos).toEqual(REPOS)
        expect(model.reposJustArrived).toBe(true)
      }),
      Story.Command.expectExact(WaitArrivalFade({ arrivedAt: 1_000 })),
      Story.Command.resolve(WaitArrivalFade, Message.ElapsedArrivalFade({ arrivedAt: 1_000 })),
      Story.model((model) => expect(model.reposJustArrived).toBe(false)),
      // GitHub's sign-in changed: fetched again, and the rows don't fade a second time.
      Story.message(Message.MountedProjectsList({ ghStatus: "signed_in" })),
      Story.Command.resolve(FetchRecentRepos, Message.ReceivedRecentRepos({ version: 2, result: REPOS, at: 2_000 })),
      Story.model((model) => expect(model.reposJustArrived).toBe(false)),
      Story.Command.expectNone(),
    )
  })

  test("an answer for a list that has gone is dropped", () => {
    Story.story(
      updateWith(connectedApp()),
      Story.given({ ...mounted, reposRequestVersion: 1 }),
      Story.message(Message.LeftProjectsList()),
      Story.message(Message.ReceivedRecentRepos({ version: 1, result: REPOS, at: 1_000 })),
      Story.model((model) => expect(model.recentRepos).toBeNull()),
    )
  })
})

describe("home: search and rows", () => {
  test("typing filters; Escape and Clear search empty it", () => {
    Story.story(
      updateWith(connectedApp()),
      Story.given(mounted),
      Story.message(Message.ChangedQuery({ value: "tide" })),
      Story.model((model) => expect(model.query).toBe("tide")),
      Story.message(Message.PressedSearchKey({ key: "a" })),
      Story.model((model) => expect(model.query).toBe("tide")),
      Story.message(Message.PressedSearchKey({ key: "Escape" })),
      Story.model((model) => expect(model.query).toBe("")),
      Story.message(Message.ChangedQuery({ value: "x" })),
      Story.message(Message.ClickedClearSearch()),
      Story.model((model) => expect(model.query).toBe("")),
    )
  })

  test("a project row asks the root to open it; add project opens the palette", () => {
    Story.story(
      updateWith(connectedApp()),
      Story.given(mounted),
      Story.message(Message.ClickedLocalProject({ localPath: "/Users/you/Projects/tidepool" })),
      Story.expectOutMessage(requested(AppAction.OpenLocalProject({ localPath: "/Users/you/Projects/tidepool" }))),
      Story.message(Message.ClickedAddProject()),
      Story.Command.expectExact(OpenCommandPalette({ page: "add-project" })),
      Story.Command.resolve(OpenCommandPalette, Message.CompletedSideEffect()),
    )
  })

  test("a repo clones once: a second click while it runs does nothing", () => {
    const app = connectedApp()
    const first = update(mounted, Message.ClickedRepo({ nameWithOwner: "you/harbor" }), app)
    const action = first.outMessage?.action
    expect(action?._tag).toBe("CreateProject")
    if (action?._tag !== "CreateProject") return
    expect(action.project).toMatchObject({ mode: "clone", cloneUrl: "https://github.com/you/harbor.git", title: "harbor" })
    // The root holds startingLocalPath on the clone's folder while it runs.
    const cloning = { ...app, actions: { ...app.actions, startingLocalPath: action.project.localPath } }
    const second = update(first.model, Message.ClickedRepo({ nameWithOwner: "you/other" }), cloning)
    expect(second.outMessage).toBeUndefined()
  })

  test("Show Archived stamps the time and opens the dialog; opening a chat closes it", () => {
    const opened = update(mounted, Message.OpenedArchive({ localPath: "/Users/you/Projects/tidepool", nowMs: 5 }), connectedApp())
    expect(opened.model.archive).toEqual({ localPath: "/Users/you/Projects/tidepool", nowMs: 5 })
    const chose = update(opened.model, Message.ClickedArchivedChat({ chatId: "c1" }), connectedApp())
    expect(chose.model.archive).toBeNull()
    expect(chose.outMessage).toEqual(requested(AppAction.OpenArchivedChat({ chatId: "c1" })))
    const restored = update(opened.model, Message.ClickedRestoreChat({ chatId: "c1" }), connectedApp())
    expect(restored.model.archive).not.toBeNull()
    expect(OpenArchive({ localPath: "x" }).name).toBe("OpenArchivedChats")
  })
})

describe("home: connection timing (LocalDev)", () => {
  test("setup help shows only after attempts keep failing, and stays until connected", () => {
    const app = boot()
    const start = { ...mounted, failingSince: 0, waitingSince: 0 }
    const early = update(start, Message.ChangedSocketStatus({ status: "disconnected", at: 500 }), app).model
    expect(early.connectionFailed).toBe(false)
    const late = update(early, Message.ChangedSocketStatus({ status: "disconnected", at: SETUP_HELP_AFTER_MS + 1 }), app).model
    expect(late.connectionFailed).toBe(true)
    const retrying = update(late, Message.ChangedSocketStatus({ status: "connecting", at: SETUP_HELP_AFTER_MS + 2 }), app).model
    expect(retrying.connectionFailed).toBe(true)
    const connected = update(retrying, Message.ChangedSocketStatus({ status: "connected", at: SETUP_HELP_AFTER_MS + 3 }), app).model
    expect(connected.connectionFailed).toBe(false)
    // The connecting screen was up long enough to be seen: the page fades in.
    expect(connected.revealChildren).toBe(true)
  })

  test("a fast connection cuts straight to the page", () => {
    const app = boot()
    const waiting = update(mounted, Message.ChangedSocketStatus({ status: "connecting", at: 0 }), app).model
    const connected = update(waiting, Message.ChangedSocketStatus({ status: "connected", at: 100 }), app).model
    expect(connected.revealChildren).toBe(false)
  })
})

describe("home: the page (Scene)", () => {
  const sceneView = (app: AppModel) => Scene.withViewInputs(view, { app })()
  // The page asks for the machine list (LocalDev's useConnectHelpContext) while it is unknown.
  const resolvePage = [
    Scene.Mount.resolve(MountPage, Message.MountedPage({ environment: mounted.environment })),
    Scene.Command.resolve(Connection.LoadConnection, Connection.Message.FoundServerNotCloud()),
  ] as const
  const mountPage = [
    ...resolvePage,
    Scene.Mount.resolve(MountProjectsList, Message.MountedProjectsList({ ghStatus: "none" })),
    Scene.Command.resolve(FetchRecentRepos, Message.ReceivedRecentRepos({ version: 1, result: { available: false, repos: [] }, at: 0 })),
  ] as const

  test("lists the projects and searches them", () => {
    const app = connectedApp()
    Scene.scene(
      { update: updateWith(app), view: sceneView(app) },
      Scene.given(mounted),
      ...mountPage,
      Scene.expect(Scene.role("heading", { name: "Projects", level: 1 })).toExist(),
      Scene.expect(Scene.text("Your Mac")).toExist(),
      Scene.expect(Scene.role("searchbox", { name: "Search projects" })).toHaveAttr("placeholder", "Search projects…"),
      Scene.expectAll(Scene.all.role("button", { name: /^(tidepool|ledger-api)/ })).toHaveCount(2),
      Scene.type(Scene.role("searchbox", { name: "Search projects" }), "ledger"),
      Scene.expectAll(Scene.all.role("button", { name: /^tidepool/ })).toHaveCount(0),
      Scene.expect(Scene.role("button", { name: /^ledger-api/ })).toExist(),
      Scene.type(Scene.role("searchbox", { name: "Search projects" }), "nothing-here"),
      Scene.expect(Scene.text("Nothing matches.")).toExist(),
      Scene.click(Scene.role("button", { name: "Clear search" })),
      Scene.expect(Scene.role("searchbox", { name: "Search projects" })).toHaveValue(""),
      Scene.expect(Scene.text("v" + "0", { exact: false })).toExist(),
    )
  })

  test("a row click opens its project", () => {
    const app = connectedApp()
    Scene.scene(
      { update: updateWith(app), view: sceneView(app) },
      Scene.given(mounted),
      ...mountPage,
      Scene.click(Scene.role("button", { name: /^tidepool/ })),
      Scene.expectOutMessage(requested(AppAction.OpenLocalProject({ localPath: "/Users/you/Projects/tidepool" }))),
    )
  })

  test("while connecting it says so, and shows no list", () => {
    const app = { ...boot(), connectionStatus: "connecting" as const }
    Scene.scene(
      { update: updateWith(app), view: sceneView(app) },
      Scene.given({ ...mounted, waitingSince: 0 }),
      ...resolvePage,
      Scene.expect(Scene.role("status")).toContainText("Connecting to Kanna…"),
      Scene.expect(Scene.role("heading", { name: "Projects" })).toBeAbsent(),
    )
  })
})
