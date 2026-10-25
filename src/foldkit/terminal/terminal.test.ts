import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Scene, Story } from "foldkit/test"
import { fromString } from "foldkit/url"
import { createDemoAppSettings } from "../../demo/backend"
import { AppAction } from "../app/action"
import type { Flags, Model as AppModel } from "../app/model"
import { SliceOutMessage } from "../app/slice"
import * as Stores from "../app/stores"
import { init as initApp } from "../app/update"
import * as TerminalLayout from "../core/stores/terminalLayout"
import { CloseTerminal, DisposeCachedTerminal } from "./commands"
import { TerminalPane, TerminalWorkspaceScroller } from "./mounts"
import * as Resizable from "./resizable"
import { HOME_TERMINAL_LAYOUT_KEY, init, Message, type Model, observe, update, view, type WorkspaceOptions } from "./index"

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  clear() { this.values.clear() }
  key() { return null }
  get length() { return this.values.size }
}

function boot(path: string, devbox: boolean | null): AppModel {
  const flags: Flags = {
    sidebarCollapsed: false,
    systemTheme: "dark",
    initialAppSettings: devbox === null ? null : { ...createDemoAppSettings("dark"), devbox },
    stores: Stores.load(new MemoryStorage() as unknown as Storage),
  }
  return initApp(flags, Option.getOrThrow(fromString(`http://localhost${path}`))).model
}

function withTerminals(app: AppModel, layoutKey: string, ids: string[]): AppModel {
  const terminals = ids.map((id, index) => ({ id, title: `Terminal ${String.fromCharCode(65 + index)}`, size: 100 / ids.length }))
  return {
    ...app,
    stores: {
      ...app.stores,
      terminalLayout: {
        projects: {
          ...app.stores.terminalLayout.projects,
          [layoutKey]: { isVisible: true, mainSizes: [68, 32], terminals, nextTerminalIndex: ids.length },
        },
      },
    },
  }
}

const requested = (action: AppAction) => SliceOutMessage.RequestedAppAction({ action })
const layoutAction = (message: TerminalLayout.Message) =>
  requested(AppAction.Store({ message: Stores.Message.GotTerminalLayoutMessage({ message }) }))

function updateWith(app: AppModel) {
  return (model: Model, message: Message) => update(model, message, app)
}

describe("terminal page: TerminalPage's effects", () => {
  test("a dev box with no shell asks for one, once, and adds it under the id it gets", () => {
    const app = boot("/terminal", true)
    const first = observe(init(), app, app)
    expect(first.model.seeding).toBe(true)
    expect(first.commands?.map((command) => command.name)).toEqual(["AddTerminal"])
    // A later root update before the id arrives doesn't ask again.
    expect(observe(first.model, app, app).commands ?? []).toEqual([])

    const added = update(first.model, Message.MadeTerminalId({ layoutKey: HOME_TERMINAL_LAYOUT_KEY, terminalId: "t-1", afterTerminalId: null }), app)
    expect(added.model.seeding).toBe(false)
    expect(added.outMessage).toEqual(layoutAction(TerminalLayout.Message.AddedTerminal({ projectId: HOME_TERMINAL_LAYOUT_KEY, terminalId: "t-1", afterTerminalId: null, chatKey: null })))
    // With a shell there, nothing more.
    const seeded = withTerminals(app, HOME_TERMINAL_LAYOUT_KEY, ["t-1"])
    expect(observe(added.model, seeded, seeded)).toEqual({ model: added.model })
  })

  test("not a dev box: sent home once per visit, without a shell", () => {
    const app = boot("/terminal", false)
    const first = observe(init(), app, app)
    expect(first.outMessage).toEqual(requested(AppAction.Navigate({ path: "/", replace: true })))
    expect(first.commands ?? []).toEqual([])
    expect(observe(first.model, app, app).outMessage).toBeUndefined()
    // Leaving resets it for the next visit.
    const home = boot("/", false)
    const left = observe(first.model, app, home)
    expect(left.model.leaving).toBe(false)
    expect(observe(left.model, home, app).outMessage).toEqual(requested(AppAction.Navigate({ path: "/", replace: true })))
  })

  test("settings not loaded yet: waits, as TerminalPage did", () => {
    const app = boot("/terminal", null)
    expect(observe(init(), app, app)).toEqual({ model: init() })
  })

  test("off the page, nothing", () => {
    const app = boot("/settings/general", true)
    expect(observe(init(), app, app)).toEqual({ model: init() })
  })
})

describe("terminal workspace: panes", () => {
  const app = withTerminals(boot("/terminal", true), HOME_TERMINAL_LAYOUT_KEY, ["t-1", "t-2"])

  test("add makes an id, then adds the split after the pane", () => {
    Story.story(
      updateWith(app),
      Story.given(init()),
      Story.message(Message.ClickedAddTerminal({ layoutKey: HOME_TERMINAL_LAYOUT_KEY, afterTerminalId: "t-1" })),
      Story.Command.resolve(TerminalLayout.AddTerminal, TerminalLayout.Message.AddedTerminal({ projectId: HOME_TERMINAL_LAYOUT_KEY, terminalId: "t-3", afterTerminalId: "t-1", chatKey: null })),
      Story.expectOutMessage(layoutAction(TerminalLayout.Message.AddedTerminal({ projectId: HOME_TERMINAL_LAYOUT_KEY, terminalId: "t-3", afterTerminalId: "t-1", chatKey: null }))),
    )
  })

  test("on the page, closing a split kills its shell and removes it", () => {
    Story.story(
      updateWith(app),
      Story.given(init()),
      Story.message(Message.ClickedRemoveTerminal({ layoutKey: HOME_TERMINAL_LAYOUT_KEY, terminalId: "t-2", surface: "page", chatKey: null })),
      Story.expectOutMessage(layoutAction(TerminalLayout.Message.RemovedTerminal({ projectId: HOME_TERMINAL_LAYOUT_KEY, terminalId: "t-2" }))),
      Story.Command.expectExact(CloseTerminal({ terminalId: "t-2" })),
      Story.Command.resolve(CloseTerminal, Message.CompletedSideEffect()),
    )
  })

  test("in a chat, the only pane hides the panel and keeps its shell", () => {
    const chatApp = withTerminals(boot("/terminal", true), "project-1", ["t-1"])
    Story.story(
      updateWith(chatApp),
      Story.given(init()),
      Story.message(Message.ClickedRemoveTerminal({ layoutKey: "project-1", terminalId: "t-1", surface: "chat", chatKey: "chat-1" })),
      Story.expectOutMessage(layoutAction(TerminalLayout.Message.HidTerminals({ projectId: "project-1", chatKey: "chat-1" }))),
      Story.Command.expectNone(),
    )
  })

  test("in a chat, a split closes, and its parked xterm is dropped", () => {
    const chatApp = withTerminals(boot("/terminal", true), "project-1", ["t-1", "t-2"])
    Story.story(
      updateWith(chatApp),
      Story.given(init()),
      Story.message(Message.ClickedRemoveTerminal({ layoutKey: "project-1", terminalId: "t-2", surface: "chat", chatKey: null })),
      Story.expectOutMessage(layoutAction(TerminalLayout.Message.RemovedTerminal({ projectId: "project-1", terminalId: "t-2" }))),
      Story.Command.expectExact(CloseTerminal({ terminalId: "t-2" }), DisposeCachedTerminal({ terminalId: "t-2" })),
      Story.Command.resolve(CloseTerminal, Message.CompletedSideEffect()),
      Story.Command.resolve(DisposeCachedTerminal, Message.CompletedSideEffect()),
    )
  })

  test("clear bumps the pane's count and forgets its path", () => {
    Story.story(
      updateWith(app),
      Story.given(init()),
      Story.message(Message.ChangedPanePath({ terminalId: "t-1", path: "/home/you" })),
      Story.model((model) => expect(model.pathsByTerminalId["t-1"]).toBe("/home/you")),
      Story.message(Message.ClickedClearTerminal({ terminalId: "t-1" })),
      Story.model((model) => {
        expect(model.clearVersionsByTerminalId["t-1"]).toBe(1)
        expect(model.pathsByTerminalId["t-1"]).toBeNull()
      }),
      Story.message(Message.ClickedClearTerminal({ terminalId: "t-1" })),
      Story.model((model) => expect(model.clearVersionsByTerminalId["t-1"]).toBe(2)),
    )
  })

  test("the group's layout is stored in pane order, keeping sizes it didn't report", () => {
    Story.story(
      updateWith(app),
      Story.given(init()),
      Story.message(Message.GotGroupMessage({
        layoutKey: HOME_TERMINAL_LAYOUT_KEY,
        message: { _tag: "ChangedGroupLayout", groupId: "g", layout: { "t-2": 70 }, isUserInteraction: true },
      })),
      Story.expectOutMessage(layoutAction(TerminalLayout.Message.ChangedTerminalSizes({ projectId: HOME_TERMINAL_LAYOUT_KEY, sizes: [50, 70] }))),
    )
  })

  test("an unchanged path or width leaves the model alone", () => {
    const model = { ...init(), viewportWidth: 800, pathsByTerminalId: { "t-1": "/a" } }
    expect(update(model, Message.MeasuredWorkspace({ width: 800 }), app).model).toBe(model)
    expect(update(model, Message.ChangedPanePath({ terminalId: "t-1", path: "/a" }), app).model).toBe(model)
  })
})

describe("terminal views", () => {
  const twoPanes = withTerminals(boot("/terminal", true), HOME_TERMINAL_LAYOUT_KEY, ["t-1", "t-2"])
  const sceneView = (app: AppModel, workspace?: WorkspaceOptions) => Scene.withViewInputs(view, { app, workspace })()
  // What the workspace's Mounts report as it mounts: its width, the group's
  // layout, each pane's fresh state.
  const mountWorkspace = (ids: string[], layoutKey = HOME_TERMINAL_LAYOUT_KEY) => [
    Scene.Mount.resolve(TerminalWorkspaceScroller, Message.MeasuredWorkspace({ width: 1200 })),
    // The group's Mount is lifted with Mount.mapMessage, not a Submodel
    // boundary, so it resolves with the lifted Message; its type says the raw one.
    Scene.Mount.resolve(Resizable.PanelGroup, Message.GotGroupMessage({ layoutKey, message: Resizable.Message.ChangedGroupLayout({
      groupId: `terminal-workspace-${layoutKey}`,
      layout: Object.fromEntries(ids.map((id) => [id, 100 / ids.length])),
      isUserInteraction: false,
    }) }) as unknown as Resizable.Message),
    ...ids.map((terminalId) => Scene.Mount.resolve(TerminalPane({ terminalId }), Message.ChangedPanePath({ terminalId, path: null }))),
  ]

  test("the page: a header per pane, a handle between them, and Clear forgets the path", () => {
    Scene.scene(
      { update: updateWith(twoPanes), view: sceneView(twoPanes) },
      Scene.given({ ...init(), pathsByTerminalId: { "t-1": "/home/you" } }),
      Scene.expect(Scene.text("/home/you")).toExist(),
      Scene.expect(Scene.role("separator")).toExist(),
      Scene.expectAll(Scene.all.role("button", { name: "Close terminal" })).toHaveCount(2),
      ...mountWorkspace(["t-1", "t-2"]),
      Scene.click(Scene.first(Scene.all.role("button", { name: "Clear terminal" }))),
      Scene.expect(Scene.text("/home/you")).toBeAbsent(),
    )
  })

  test("the page's lone pane has no X, and Add asks for a split after it", () => {
    const single = withTerminals(boot("/terminal", true), HOME_TERMINAL_LAYOUT_KEY, ["t-1"])
    Scene.scene(
      { update: updateWith(single), view: sceneView(single) },
      Scene.given(init()),
      Scene.expect(Scene.role("button", { name: "Close terminal" })).toBeAbsent(),
      Scene.expect(Scene.role("separator")).toBeAbsent(),
      ...mountWorkspace(["t-1"]),
      Scene.click(Scene.role("button", { name: "Add terminal to the right" })),
      Scene.Command.resolve(TerminalLayout.AddTerminal, TerminalLayout.Message.AddedTerminal({ projectId: HOME_TERMINAL_LAYOUT_KEY, terminalId: "t-2", afterTerminalId: "t-1", chatKey: null })),
      Scene.expectOutMessage(layoutAction(TerminalLayout.Message.AddedTerminal({ projectId: HOME_TERMINAL_LAYOUT_KEY, terminalId: "t-2", afterTerminalId: "t-1", chatKey: null }))),
    )
  })

  test("the page shows nothing on a machine that is no dev box", () => {
    const notDevbox = withTerminals(boot("/terminal", false), HOME_TERMINAL_LAYOUT_KEY, ["t-1"])
    Scene.scene(
      // Wrapped: the page itself renders null.
      { update: updateWith(notDevbox), view: (model: Model, h: Parameters<ReturnType<typeof sceneView>>[1]) => h.main([], [sceneView(notDevbox)(model, h)]) },
      Scene.given(init()),
      Scene.expect(Scene.role("button", { name: "Clear terminal" })).toBeAbsent(),
    )
  })

  test("the chat's panel offers Hide on its only pane, naming the chat", () => {
    const chatApp = withTerminals(boot("/terminal", true), "project-1", ["t-1"])
    const workspace: WorkspaceOptions = {
      layoutKey: "project-1",
      paneProjectId: "project-1",
      surface: "chat",
      lastPaneClose: "hide",
      chatKey: "chat-1",
      focusRequestVersion: 0,
      pendingCommandsByTerminalId: {},
      splitTerminalShortcut: ["cmd+shift+d"],
    }
    Scene.scene(
      { update: updateWith(chatApp), view: sceneView(chatApp, workspace) },
      Scene.given(init()),
      ...mountWorkspace(["t-1"], "project-1"),
      Scene.click(Scene.role("button", { name: "Hide terminal" })),
      Scene.expectOutMessage(layoutAction(TerminalLayout.Message.HidTerminals({ projectId: "project-1", chatKey: "chat-1" }))),
    )
  })

  test("a pane's error shows under it", () => {
    Scene.scene(
      { update: updateWith(twoPanes), view: sceneView(twoPanes) },
      Scene.given(init()),
      ...mountWorkspace(["t-1"]),
      Scene.Mount.resolve(TerminalPane({ terminalId: "t-2" }), Message.ChangedPaneError({ terminalId: "t-2", error: "spawn failed" })),
      Scene.expect(Scene.text("Terminal error: spawn failed")).toExist(),
    )
  })
})

