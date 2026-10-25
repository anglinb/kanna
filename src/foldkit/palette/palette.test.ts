import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Scene, Story } from "foldkit/test"
import { fromString } from "foldkit/url"
import type { FsListResult, LocalProjectsSnapshot, SidebarChatRow, SidebarData, SidebarProjectGroup } from "../../shared/types"
import { AppAction } from "../app/action"
import type { Flags, Model as AppModel } from "../app/model"
import { SliceOutMessage } from "../app/slice"
import * as Stores from "../app/stores"
import { init as initApp } from "../app/update"
import { memoryStorage } from "../core/stores/testing"
import { effectiveSelection, itemValues } from "./cmdk"
import * as Commands from "./commands"
import { derive } from "./derive"
import { Message } from "./message"
import { init, type Model } from "./model"
import { PaletteContent, PaletteList, PaletteRoot } from "./mounts"
import { observe, requestOpen, update } from "./update"
import { view } from "./view"

const NOW = Date.parse("2026-06-01T12:00:00Z")

function row(chatId: string, overrides: Partial<SidebarChatRow> = {}): SidebarChatRow {
  return {
    _id: chatId,
    _creationTime: NOW - 60_000,
    chatId,
    title: `Chat ${chatId}`,
    status: "idle",
    unread: false,
    localPath: "/Users/you/Projects/tidepool",
    provider: "claude",
    hasAutomation: false,
    lastMessageAt: NOW - 60_000,
    canFork: true,
    ...overrides,
  }
}

function group(groupKey: string, title: string, chats: SidebarChatRow[], overrides: Partial<SidebarProjectGroup> = {}): SidebarProjectGroup {
  return {
    groupKey,
    title,
    realTitle: title,
    localPath: `/Users/you/Projects/${title}`,
    chats,
    previewChats: chats,
    olderChats: [],
    defaultCollapsed: false,
    ...overrides,
  }
}

const DATA: SidebarData = {
  projectGroups: [
    group("p-tide", "tidepool", [
      row("c-units", { title: "Add a feet/meters toggle" }),
      row("c-safari", { title: "Fix blank tide chart in Safari", unread: true, lastMessageAt: NOW - 30_000 }),
    ]),
    group("p-ledger", "ledger-api", [row("c-rate", { title: "Rate limit charge creation", localPath: "/Users/you/Projects/ledger-api" })]),
  ],
}

const PROJECTS: LocalProjectsSnapshot = {
  machine: { id: "local", displayName: "Your Mac", platform: "darwin" },
  projects: [
    { localPath: "/Users/you/Projects/tidepool", title: "tidepool", source: "saved", lastOpenedAt: NOW - 60_000, chatCount: 2 },
    { localPath: "/Users/you/Projects/portfolio", title: "portfolio", source: "saved", lastOpenedAt: NOW - 120_000, chatCount: 0 },
  ],
}

const LISTING: FsListResult = {
  path: "/Users/you",
  parentPath: "/Users",
  homePath: "/Users/you",
  isGitRepo: false,
  entries: [{ name: "Desktop", kind: "dir" }, { name: "Projects", kind: "dir" }, { name: "notes.txt", kind: "file" }],
  truncated: false,
}

function appAt(path: string): AppModel {
  const flags: Flags = { sidebarCollapsed: false, systemTheme: "dark", initialAppSettings: null, stores: Stores.load(memoryStorage()) }
  const app = initApp(flags, Option.getOrThrow(fromString(`http://localhost${path}`))).model
  return {
    ...app,
    localProjects: PROJECTS,
    localProjectsReady: true,
    stores: { ...app.stores, sidebar: { ...app.stores.sidebar, data: DATA, ready: true } },
  }
}

const HOME = appAt("/home")
const asks = (action: AppAction) => SliceOutMessage.RequestedAppAction({ action })
const updateWith = (app: AppModel) => (model: Model, message: Message) => update(model, message, app)

/** The palette as the shortcut leaves it. */
function opened(app: AppModel = HOME): Model {
  const result = update(init(), Message.PressedPaletteShortcut({ at: NOW }), app)
  return result.model
}

const openSteps = Story.steps(
  Story.message(Message.PressedPaletteShortcut({ at: NOW })),
  Story.Command.resolveAll(
    [Commands.RefreshMacSetup, Message.ReceivedMacSetup({ state: null })],
    [Commands.ResetListScroll, Message.CompletedSideEffect()],
  ),
)

describe("palette: opening and closing", () => {
  test("the shortcut opens it at the root with the first result highlighted; again closes it", () => {
    Story.story(
      updateWith(HOME),
      Story.given(init()),
      openSteps,
      Story.model((model) => {
        expect(model.phase).toBe("Open")
        expect(model.pages).toEqual([])
        expect(model.nowMs).toBe(NOW)
        // Review leads: the unread chat waiting on you.
        expect(model.selectedValue).toBe("thread-c-safari")
      }),
      Story.message(Message.PressedPaletteShortcut({ at: NOW })),
      Story.Command.resolve(Commands.WaitForExitAnimation, Message.CompletedExitAnimation({ version: 2 })),
      Story.model((model) => expect(model.phase).toBe("Closed")),
    )
  })

  test("the root's open request lands on a page; Clone seeds Add Project underneath", () => {
    const requested = requestOpen(init(), "clone-github", HOME)
    expect(requested.commands?.length).toBe(1)
    Story.story(
      updateWith(HOME),
      Story.given(init()),
      Story.message(Message.ReceivedOpenRequest({ page: "clone-github", at: NOW })),
      Story.Command.resolveAll(
        [Commands.RefreshMacSetup, Message.ReceivedMacSetup({ state: null })],
        [Commands.FetchGithubRepos({ seq: 1 }), Message.ReceivedGithubRepos({ seq: 1, result: { available: false, repos: [] } })],
        [Commands.ResetListScroll, Message.CompletedSideEffect()],
      ),
      Story.model((model) => {
        expect(model.pages.map((entry) => entry.page)).toEqual(["add-project", "clone-github"])
        expect(model.githubRepos).toEqual({ available: false, repos: [] })
        expect(model.githubReposLoading).toBe(false)
      }),
      Story.message(Message.PressedBackKey()),
      Story.Command.resolveAll([Commands.ResetListScroll, Message.CompletedSideEffect()]),
      Story.model((model) => expect(model.pages.map((entry) => entry.page)).toEqual(["add-project"])),
    )
  })

  test("an unknown page opens the root", () => {
    const result = update(init(), Message.ReceivedOpenRequest({ page: "nope", at: NOW }), HOME)
    expect(result.model.pages).toEqual([])
  })
})

describe("palette: typing and the highlight", () => {
  test("typing filters the root and highlights the best match; arrows move it", () => {
    Story.story(
      updateWith(HOME),
      Story.given(init()),
      openSteps,
      Story.message(Message.ChangedQuery({ value: "chart" })),
      Story.Command.resolveAll([Commands.ResetListScroll, Message.CompletedSideEffect()]),
      Story.model((model) => {
        expect(model.selectedValue).toBe("thread-c-safari")
        const values = itemValues(derive(model, HOME).nodes)
        expect(values[0]).toBe("thread-c-safari")
      }),
      Story.message(Message.PressedNavigationKey({ key: "ArrowDown", ctrlKey: false, metaKey: false, altKey: false })),
      Story.Command.expectExact(Commands.ScrollSelectedIntoView),
      Story.Command.resolve(Commands.ScrollSelectedIntoView, Message.CompletedSideEffect()),
      Story.model((model) => expect(model.selectedValue).not.toBe("thread-c-safari")),
    )
  })

  test("no match: cmdk's empty state, nothing highlighted", () => {
    const model = update(opened(), Message.ChangedQuery({ value: "zzzz nothing matches" }), HOME).model
    const data = derive(model, HOME)
    expect(itemValues(data.nodes)).toEqual([])
    expect(data.empty).toBe("No results found.")
    expect(data.selected).toBe("")
  })

  test("Home/End and ⌘↓ jump to the ends; Ctrl+N steps", () => {
    const model = opened()
    const data = derive(model, HOME)
    const values = itemValues(data.nodes)
    const last = update(model, Message.PressedNavigationKey({ key: "End", ctrlKey: false, metaKey: false, altKey: false }), HOME).model
    expect(last.selectedValue).toBe(values[values.length - 1]!)
    const first = update(last, Message.PressedNavigationKey({ key: "ArrowUp", ctrlKey: false, metaKey: true, altKey: false }), HOME).model
    expect(first.selectedValue).toBe(values[0]!)
    const second = update(first, Message.PressedNavigationKey({ key: "n", ctrlKey: true, metaKey: false, altKey: false }), HOME).model
    expect(second.selectedValue).toBe(values[1]!)
  })
})

describe("palette: the page stack", () => {
  test("choosing Add Project… pushes it with what was typed; Backspace pops back to the search", () => {
    let model = update(opened(), Message.ChangedQuery({ value: "add proj" }), HOME).model
    model = update(model, Message.ClickedItem({ value: "action-new-project" }), HOME).model
    expect(model.pages).toEqual([{ page: "add-project", browsePath: null, returnQuery: "add proj" }])
    expect(model.query).toBe("")
    expect(model.selectedValue).toBe("add-action-clone-github")
    model = update(model, Message.PressedBackKey(), HOME).model
    expect(model.pages).toEqual([])
    expect(model.query).toBe("add proj")
  })

  test("a row that runs an action closes the palette and asks the root", () => {
    Story.story(
      updateWith(HOME),
      Story.given(opened()),
      Story.message(Message.ClickedItem({ value: "thread-c-rate" })),
      Story.expectOutMessage(asks(AppAction.Navigate({ path: "/chat/c-rate", replace: false }))),
      Story.Command.resolve(Commands.WaitForExitAnimation, Message.CompletedExitAnimation({ version: 2 })),
      Story.model((model) => expect(model.phase).toBe("Closed")),
    )
  })
})

describe("palette: Add Project", () => {
  test("Create New lists the projects directory, and Enter on a name creates it; a failure stays inline", () => {
    let model = update(opened(), Message.ClickedItem({ value: "action-new-project" }), HOME).model
    const entered = update(model, Message.ClickedItem({ value: "add-action-create-new" }), HOME)
    expect(entered.commands?.some((command) => command.name === "ListPaletteCreateDir")).toBe(true)
    model = update(entered.model, Message.ReceivedCreateDirNames({ seq: entered.model.createDirSeq, names: ["tidepool"] }), HOME).model
    model = update(model, Message.ChangedQuery({ value: "surf-log" }), HOME).model
    expect(model.selectedValue).toBe("create-new-row")
    const chosen = update(model, Message.PressedEnter({ withModifier: false }), HOME)
    expect(chosen.outMessage).toEqual(asks(AppAction.CreateProject({ project: { mode: "create", localPath: "~/Kanna/surf-log", title: "surf-log" } })))
    expect(chosen.model.pendingActionValue).toBe("create-new-row")
    // The root's request: in flight, then failed.
    const inFlight = { ...HOME, actions: { ...HOME.actions, startingLocalPath: "~/Kanna/surf-log" } }
    const failed = { ...HOME, actions: { ...HOME.actions, startingLocalPath: null, projectRequestError: "Folder exists" } }
    const settled = observe(chosen.model, inFlight, failed)
    expect(settled.model.phase).toBe("Open")
    expect(settled.model.actionError).toBe("Folder exists")
    expect(settled.model.pendingActionValue).toBeNull()
    // A success closes it.
    const done = observe(chosen.model, inFlight, HOME)
    expect(done.model.phase).toBe("Closing")
  })

  test("a typed repo clones from the Clone page; the palette locks until it lands, then flashes and closes", () => {
    let model = update(opened(), Message.ClickedItem({ value: "action-new-project" }), HOME).model
    model = update(model, Message.ChangedQuery({ value: "you/surf-log" }), HOME).model
    expect(model.selectedValue).toBe("clone-inline")
    const cloned = update(model, Message.PressedEnter({ withModifier: false }), HOME)
    expect(cloned.model.pages.map((entry) => entry.page)).toEqual(["add-project", "clone-github"])
    expect(cloned.model.cloneRun?.status).toBe("cloning")
    expect(cloned.outMessage).toEqual(asks(AppAction.CreateProject({
      project: { mode: "clone", localPath: "~/Kanna/surf-log", fallbackPath: "~/Kanna/you-surf-log", title: "surf-log", cloneUrl: "https://github.com/you/surf-log.git" },
    })))
    // Locked: Escape, a click outside and Backspace do nothing.
    expect(update(cloned.model, Message.DismissedPalette(), HOME).model.phase).toBe("Open")
    expect(update(cloned.model, Message.PressedBackKey(), HOME).model.pages.length).toBe(2)
    const inFlight = { ...HOME, actions: { ...HOME.actions, startingLocalPath: "~/Kanna/surf-log" } }
    const succeeded = observe(cloned.model, inFlight, HOME)
    expect(succeeded.model.cloneRun?.status).toBe("success")
    const closed = update(succeeded.model, Message.ElapsedCloneSuccess({ cloneSeq: succeeded.model.cloneSeq }), HOME)
    expect(closed.model.phase).toBe("Closing")
    expect(closed.model.cloneRun).toBeNull()
  })
})

describe("palette: browsing folders", () => {
  test("Choose Existing lists home; a folder drills in from the cache; a typed path jumps", () => {
    let model = update(opened(), Message.ClickedItem({ value: "action-new-project" }), HOME).model
    const browse = update(model, Message.ClickedItem({ value: "add-action-choose-existing" }), HOME)
    expect(browse.commands?.some((command) => command.name === "LoadPaletteDirectory")).toBe(true)
    model = update(browse.model, Message.ReceivedDirectory({ seq: browse.model.browser.seq, result: LISTING }), HOME).model
    const data = derive(model, HOME)
    expect(itemValues(data.nodes)).toEqual(["browse-open-current", "browse-dir-Desktop", "browse-dir-Projects", "browse-file-notes.txt"])
    expect(model.selectedValue).toBe("browse-dir-Desktop")
    expect(data.footerBrowseTarget).toEqual({ path: "/Users/you/Desktop", name: "Desktop" })
    // Filtering with no folder match offers to create it.
    const filtered = update(model, Message.ChangedQuery({ value: "zebra" }), HOME).model
    expect(itemValues(derive(filtered, HOME).nodes)).toContain("browse-create")
    // A path jump pushes the listing the server resolved, the missing tail typed.
    const jumping = update(model, Message.ChangedQuery({ value: "~/Projects/ledger-api/src" }), HOME).model
    expect(derive(jumping, HOME).selected).toBe("browse-jump")
    const requested = update(jumping, Message.PressedEnter({ withModifier: false }), HOME)
    expect(requested.commands?.some((command) => command.name === "JumpPalettePath" || command.name === "JumpPaletteToPath")).toBe(true)
    const landed = update(requested.model, Message.ReceivedJump({
      seq: requested.model.browser.seq,
      result: { ...LISTING, path: "/Users/you/Projects/ledger-api", missingSuffix: "src" },
    }), HOME).model
    expect(landed.pages.at(-1)).toEqual({ page: "browse", browsePath: "/Users/you/Projects/ledger-api", returnQuery: "~/Projects/ledger-api/src" })
    expect(landed.query).toBe("src")
  })

  test("⌘↵ opens the highlighted folder as a project", () => {
    let model = update(opened(), Message.ClickedItem({ value: "action-new-project" }), HOME).model
    model = update(model, Message.ClickedItem({ value: "add-action-choose-existing" }), HOME).model
    model = update(model, Message.ReceivedDirectory({ seq: model.browser.seq, result: LISTING }), HOME).model
    const opening = update(model, Message.PressedEnter({ withModifier: true }), HOME)
    expect(opening.outMessage).toEqual(asks(AppAction.CreateProject({ project: { mode: "existing", localPath: "/Users/you/Desktop", title: "Desktop" } })))
    expect(opening.model.pendingActionValue).toBe("browse-open:/Users/you/Desktop")
  })
})

describe("palette: the chat page's actions", () => {
  const CHAT = appAt("/chat/c-units")

  test("chat actions are offered, and searching finds the search-only ones", () => {
    const model = opened(CHAT)
    const values = itemValues(derive(model, CHAT).nodes)
    expect(values).toContain("action-new-thread-current")
    expect(values).toContain("action-archive-chat")
    expect(values).not.toContain("action-toggle-pin-chat")
    const searched = update(model, Message.ChangedQuery({ value: "pin" }), CHAT).model
    expect(itemValues(derive(searched, CHAT).nodes)).toContain("action-toggle-pin-chat")
  })

  test("Archive Chat closes and asks the root to archive the open chat", () => {
    const chosen = update(opened(CHAT), Message.ClickedItem({ value: "action-archive-chat" }), CHAT)
    expect(chosen.outMessage).toEqual(asks(AppAction.ArchiveChat({ chatId: "c-units" })))
    expect(chosen.model.phase).toBe("Closing")
  })

  test("New Delegator closes and asks the root to make one in the current project (its prompt is the root's)", () => {
    const searched = update(opened(CHAT), Message.ChangedQuery({ value: "delegator" }), CHAT).model
    expect(itemValues(derive(searched, CHAT).nodes)).toContain("action-new-delegator-current")
    const chosen = update(searched, Message.ClickedItem({ value: "action-new-delegator-current" }), CHAT)
    expect(chosen.outMessage).toEqual(asks(AppAction.CreateDelegator({ projectId: "p-tide" })))
    expect(chosen.model.phase).toBe("Closing")
  })
})

describe("palette: cmdk", () => {
  test("a value no row has falls back to the first enabled row", () => {
    const data = derive(opened(), HOME)
    expect(effectiveSelection(data.nodes, "nope")).toBe(itemValues(data.nodes)[0]!)
  })
})

describe("palette: view", () => {
  const sceneView = Scene.withViewInputs(view, { app: HOME })()
  const acknowledgeMounts = [
    Scene.Mount.resolve(PaletteContent, Message.CompletedMountContent()),
    Scene.Mount.resolve(PaletteRoot, Message.CompletedMountRoot()),
    Scene.Mount.resolve(PaletteList, Message.CompletedSideEffect()),
  ] as const

  test("the dialog: its title, the combobox, the groups and a highlighted option", () => {
    Scene.scene(
      { update: updateWith(HOME), view: sceneView },
      Scene.given(opened()),
      ...acknowledgeMounts,
      Scene.expect(Scene.role("dialog", { name: "Command Palette" })).toExist(),
      Scene.expect(Scene.role("combobox")).toHaveAttr("placeholder", "Type a command or search threads…"),
      Scene.expect(Scene.role("group", { name: "Review" })).toExist(),
      Scene.expect(Scene.role("option", { name: /Fix blank tide chart/ })).toHaveAttr("aria-selected", "true"),
      Scene.expect(Scene.role("option", { name: /^Add Project…/ })).toExist(),
    )
  })

  test("clicking a row runs it", () => {
    Scene.scene(
      { update: updateWith(HOME), view: sceneView },
      Scene.given(opened()),
      ...acknowledgeMounts,
      Scene.click(Scene.role("option", { name: /^All Projects/ })),
      Scene.expectOutMessage(asks(AppAction.Navigate({ path: "/", replace: false }))),
      Scene.Command.resolve(Commands.WaitForExitAnimation, Message.CompletedExitAnimation({ version: 2 })),
      Scene.Mount.expectEnded(PaletteContent),
      Scene.Mount.expectEnded(PaletteRoot),
      Scene.Mount.expectEnded(PaletteList),
    )
  })
})
