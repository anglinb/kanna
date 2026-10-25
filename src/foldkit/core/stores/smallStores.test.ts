import { describe, expect, test } from "bun:test"
import { Story } from "foldkit/test"
import { OPEN_EXTERNAL_SELECT_STORAGE_KEY, OPEN_FILE_DESTINATION_STORAGE_KEY, SIDEBAR_VIEW_STORAGE_KEY } from "../../../client/lib/storageKeys"
import { createDefaultProviderDefaults } from "../../../shared/provider-preferences"
import type { AppSettingsSnapshot } from "../../../shared/types"
import * as AppSettings from "./appSettings"
import * as OpenDestination from "./openDestination"
import * as ServerCapabilities from "./serverCapabilities"
import * as SidebarView from "./sidebarView"
import * as TerminalPreferences from "./terminalPreferences"
import { memoryStorage, run } from "./testing"

// The stores that had no test file of their own in React.

describe("app settings", () => {
  const settings = {
    theme: "dark",
    terminal: { scrollbackLines: 1000 },
    editor: { preset: "cursor" },
    transcript: {},
    paneVisibility: { widgets: "project" },
    providerDefaults: createDefaultProviderDefaults(),
  } as unknown as AppSettingsSnapshot

  test("a patch before the first snapshot does nothing", () => {
    const model = run(AppSettings.update, AppSettings.initialModel, AppSettings.Message.AppliedOptimisticPatch({ patch: { theme: "light" } }))
    expect(model).toBe(AppSettings.initialModel)
  })

  test("a patch merges over the snapshot, nested sections included", () => {
    const model = run(
      AppSettings.update,
      AppSettings.initialModel,
      AppSettings.Message.ReceivedAppSettings({ settings }),
      AppSettings.Message.AppliedOptimisticPatch({ patch: { theme: "light", terminal: { minColumnWidth: 300 } } as never }),
    )
    expect(model.settings).toMatchObject({ theme: "light", terminal: { scrollbackLines: 1000, minColumnWidth: 300 }, paneVisibility: { widgets: "project" } })
  })
})

describe("open destination", () => {
  test("loads both choices from their keys", () => {
    expect(OpenDestination.load(memoryStorage({ [OPEN_EXTERNAL_SELECT_STORAGE_KEY]: "vscode", [OPEN_FILE_DESTINATION_STORAGE_KEY]: "preview" })))
      .toEqual({ value: "vscode", fileValue: "preview" })
    expect(OpenDestination.load(memoryStorage())).toEqual({ value: null, fileValue: null })
  })

  test("each choice is kept under its own key", () => {
    Story.story(
      OpenDestination.update,
      Story.given(OpenDestination.initialModel),
      Story.message(OpenDestination.Message.ChoseFileDestination({ value: "preview" })),
      Story.Command.expectExact(OpenDestination.SaveOpenDestination({ key: OPEN_FILE_DESTINATION_STORAGE_KEY, value: "preview" })),
      Story.Command.resolve(OpenDestination.SaveOpenDestination, OpenDestination.Message.CompletedSave()),
      Story.model((model) => expect(model).toEqual({ value: null, fileValue: "preview" })),
    )
  })
})

describe("sidebar view", () => {
  test("loads the stored view, and nothing else, as both views", () => {
    expect(SidebarView.load(memoryStorage({ [SIDEBAR_VIEW_STORAGE_KEY]: "channels" }))).toEqual({ view: "channels", returnView: "channels" })
    expect(SidebarView.load(memoryStorage({ [SIDEBAR_VIEW_STORAGE_KEY]: "archived" }))).toEqual({ view: "recents", returnView: "recents" })
  })

  test("Archived is visited, not stored, and leaving it goes back", () => {
    Story.story(
      SidebarView.update,
      Story.given(SidebarView.initialModel),
      Story.message(SidebarView.Message.ChangedView({ view: "projects" })),
      Story.Command.expectExact(SidebarView.SaveSidebarView({ view: "projects" })),
      Story.Command.resolve(SidebarView.SaveSidebarView, SidebarView.Message.CompletedSave()),
      Story.message(SidebarView.Message.ChangedView({ view: "archived" })),
      Story.Command.expectNone(),
      Story.model((model) => expect(model).toEqual({ view: "archived", returnView: "projects" })),
      Story.message(SidebarView.Message.LeftArchived()),
      Story.model((model) => expect(model).toEqual({ view: "projects", returnView: "projects" })),
    )
  })
})

describe("server capabilities", () => {
  test("unknown until the bootstrap request answers", () => {
    expect(ServerCapabilities.serverCapabilities(ServerCapabilities.initialModel)).toBeNull()
    const model = run(ServerCapabilities.update, ServerCapabilities.initialModel, ServerCapabilities.Message.ReceivedServerCapabilities({
      value: { cloud: false, publicSharing: false },
    }))
    expect(ServerCapabilities.serverCapabilities(model)).toEqual({ cloud: false, publicSharing: false })
  })

  test("an injected fetch gets its own answer", async () => {
    const fetchImpl = (async () => new Response("", { status: 404 })) as unknown as typeof fetch
    expect(await ServerCapabilities.getServerCapabilities(fetchImpl)).toEqual({ cloud: true, publicSharing: true })
  })
})

describe("terminal preferences", () => {
  const { update, initialModel, Message } = TerminalPreferences

  test("clamps the numbers it is given", () => {
    const model = run(
      update,
      initialModel,
      Message.ChangedScrollbackLines({ scrollbackLines: 99_999 }),
      Message.ChangedMinColumnWidth({ minColumnWidth: Number.NaN }),
    )
    expect(model.scrollbackLines).toBe(TerminalPreferences.MAX_TERMINAL_SCROLLBACK)
    expect(model.minColumnWidth).toBe(TerminalPreferences.DEFAULT_TERMINAL_MIN_COLUMN_WIDTH)
  })

  test("a preset brings its own command; a custom one keeps what was typed", () => {
    const custom = run(update, initialModel, Message.ChangedEditorPreset({ editorPreset: "custom" }))
    expect(custom.editorCommandTemplate).toBe(initialModel.editorCommandTemplate)
    const typed = run(update, custom, Message.ChangedEditorCommandTemplate({ editorCommandTemplate: "  nvim {path}  " }))
    expect(typed.editorCommandTemplate).toBe("nvim {path}")
    const blank = run(update, typed, Message.ChangedEditorCommandTemplate({ editorCommandTemplate: "  " }))
    expect(blank.editorCommandTemplate).toBe(TerminalPreferences.getDefaultEditorCommandTemplate("custom"))
    const back = run(update, typed, Message.ChangedEditorPreset({ editorPreset: "cursor" }))
    expect(back.editorCommandTemplate).toBe(TerminalPreferences.getDefaultEditorCommandTemplate("cursor"))
  })
})
