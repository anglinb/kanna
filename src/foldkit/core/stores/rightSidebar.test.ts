import { describe, expect, test } from "bun:test"
import { Story } from "foldkit/test"
import {
  DEFAULT_RIGHT_SIDEBAR_SIZE,
  initialModel,
  load,
  Message,
  migrateRightSidebarStore,
  persistedRightSidebarState,
  RIGHT_SIDEBAR_MAX_WIDTH_PX,
  RIGHT_SIDEBAR_MIN_WIDTH_PX,
  Save,
  STORAGE_NAME,
  update,
  widgetsOpen,
  type ChatViewerState,
  type Model,
} from "./rightSidebar"
import { memoryStorage, persisted, run } from "./testing"

const PROJECT_ID = "project-1"

describe("right sidebar", () => {
  test("loads what the React store persisted at v11", () => {
    const state: Model = {
      size: 480,
      projects: { [PROJECT_ID]: { widgetsOpen: true, chats: { "chat-a": false } } },
      projectUi: { [PROJECT_ID]: { expanded: { changes: true }, summary: "feat", description: "" } },
      chatViewers: { "chat-a": { item: { kind: "file", projectId: PROJECT_ID, path: "a.md" }, expanded: true } },
      viewerWidthPx: 640,
    }
    expect(load(memoryStorage({ [STORAGE_NAME]: persisted(state, 11) }))).toEqual(state)
  })

  test("migrates what an older version persisted", () => {
    const model = load(memoryStorage({
      [STORAGE_NAME]: persisted({ size: 520, projects: { [PROJECT_ID]: { rightPanel: "git" } } }, 7),
    }))
    expect(model).toEqual({
      size: 520,
      projects: { [PROJECT_ID]: { widgetsOpen: true } },
      projectUi: {},
      chatViewers: {},
      viewerWidthPx: null,
    })
  })

  test("saves what partialize kept, on every change", () => {
    const chart: ChatViewerState = { item: { kind: "chart", payload: { title: "x", type: "bar", data: [] } }, expanded: false }
    const given = { ...initialModel, chatViewers: { "chat-1": chart } }
    Story.story(
      update,
      Story.given(given),
      Story.message(Message.ChangedSize({ size: 430 })),
      Story.Command.expectExact(Save({ state: { ...given, size: 430 } })),
      Story.Command.resolve(Save, Message.CompletedSave()),
    )
    // The chart doesn't outlive the page; the write leaves it out.
    expect(persistedRightSidebarState(given).chatViewers).toEqual({})
  })

  test("widgets start closed with the default size", () => {
    expect(widgetsOpen(initialModel, PROJECT_ID)).toBe(false)
    expect(initialModel.size).toBe(DEFAULT_RIGHT_SIDEBAR_SIZE)
  })

  test("toggling is per project; size is shared", () => {
    let model = run(
      update,
      initialModel,
      Message.ToggledWidgets({ projectId: PROJECT_ID, chatKey: null }),
      Message.ChangedSize({ size: 430 }),
    )

    expect(model.projects[PROJECT_ID]).toEqual({ widgetsOpen: true })
    expect(model.projects["project-2"]).toBeUndefined()
    expect(model.size).toBe(430)

    model = run(update, model, Message.ToggledWidgets({ projectId: PROJECT_ID, chatKey: null }))
    expect(model.projects[PROJECT_ID]).toEqual({ widgetsOpen: false })
  })

  test("open and hide are idempotent", () => {
    let model = run(
      update,
      initialModel,
      Message.OpenedWidgets({ projectId: PROJECT_ID, chatKey: null }),
      Message.OpenedWidgets({ projectId: PROJECT_ID, chatKey: null }),
    )
    expect(model.projects[PROJECT_ID]).toEqual({ widgetsOpen: true })
    model = run(
      update,
      model,
      Message.HidWidgets({ projectId: PROJECT_ID, chatKey: null }),
      Message.HidWidgets({ projectId: PROJECT_ID, chatKey: null }),
    )
    expect(model.projects[PROJECT_ID]).toEqual({ widgetsOpen: false })
  })

  test("a chat key keeps each chat's state apart from the project's and from other chats", () => {
    let model = run(update, initialModel, Message.ToggledWidgets({ projectId: PROJECT_ID, chatKey: "chat-a" }))

    expect(model.projects[PROJECT_ID]).toEqual({ widgetsOpen: false, chats: { "chat-a": true } })

    model = run(
      update,
      model,
      Message.ToggledWidgets({ projectId: PROJECT_ID, chatKey: null }),
      Message.HidWidgets({ projectId: PROJECT_ID, chatKey: "chat-a" }),
      Message.OpenedWidgets({ projectId: PROJECT_ID, chatKey: "chat-b" }),
    )
    expect(model.projects[PROJECT_ID]).toEqual({
      widgetsOpen: true,
      chats: { "chat-a": false, "chat-b": true },
    })
    expect(widgetsOpen(model, PROJECT_ID, "chat-b")).toBe(true)
    expect(widgetsOpen(model, PROJECT_ID, "chat-a")).toBe(false)

    model = run(update, model, Message.ClearedProject({ projectId: PROJECT_ID }))
    expect(model.projects[PROJECT_ID]).toBeUndefined()
  })

  test("clamps the size between the minimum and the left sidebar's maximum", () => {
    expect(run(update, initialModel, Message.ChangedSize({ size: 100 })).size).toBe(RIGHT_SIDEBAR_MIN_WIDTH_PX)
    expect(run(update, initialModel, Message.ChangedSize({ size: 480 })).size).toBe(480)
    expect(run(update, initialModel, Message.ChangedSize({ size: 900 })).size).toBe(RIGHT_SIDEBAR_MAX_WIDTH_PX)
  })

  test("clearing a project drops its state but keeps the shared size", () => {
    const model = run(
      update,
      initialModel,
      Message.ToggledWidgets({ projectId: PROJECT_ID, chatKey: null }),
      Message.ChangedSize({ size: 440 }),
      Message.ChangedWidgetExpanded({ projectId: PROJECT_ID, id: "changes", expanded: true }),
      Message.ClearedProject({ projectId: PROJECT_ID }),
    )

    expect(model.projects[PROJECT_ID]).toBeUndefined()
    expect(model.projectUi[PROJECT_ID]).toBeUndefined()
    expect(model.size).toBe(440)
  })

  test("keeps widget ui state isolated per project", () => {
    const model = run(
      update,
      initialModel,
      Message.ChangedWidgetExpanded({ projectId: PROJECT_ID, id: "changes", expanded: true }),
      Message.ChangedCommitDraft({ projectId: PROJECT_ID, summary: "feat: one", description: "body" }),
      Message.ChangedCommitDraft({ projectId: "project-2", summary: "feat: two", description: "" }),
    )

    expect(model.projectUi[PROJECT_ID]).toEqual({ expanded: { changes: true }, summary: "feat: one", description: "body" })
    expect(model.projectUi["project-2"]).toEqual({ expanded: {}, summary: "feat: two", description: "" })

    const cleared = run(update, model, Message.ClearedCommitDraft({ projectId: PROJECT_ID }))
    expect(cleared.projectUi[PROJECT_ID]).toEqual({ expanded: { changes: true }, summary: "", description: "" })
  })

  describe("migration to widgets (v8)", () => {
    test("any open panel, or the legacy isVisible flag, means the widgets are open", () => {
      const migrated = migrateRightSidebarStore({
        projects: {
          git: { rightPanel: "git" },
          browser: { rightPanel: "browser" },
          hidden: { rightPanel: "hidden" },
          legacyOpen: { isVisible: true, size: 34 },
          legacyClosed: { isVisible: false, size: 26 },
        },
      }, 7)

      expect(migrated.projects).toEqual({
        git: { widgetsOpen: true },
        browser: { widgetsOpen: true },
        hidden: { widgetsOpen: false },
        legacyOpen: { widgetsOpen: true },
        legacyClosed: { widgetsOpen: false },
      })
    })

    test("keeps the commit draft; drops collapsed paths, the history picker and the browser", () => {
      const migrated = migrateRightSidebarStore({
        projects: {},
        projectUi: {
          [PROJECT_ID]: {
            viewMode: "changes",
            collapsedPaths: { "a.ts": false },
            summary: "feat: one",
            description: "body",
          },
        },
        projectBrowser: { [PROJECT_ID]: { address: "http://localhost:3000" } },
      }, 7)

      expect(migrated).toEqual({
        size: DEFAULT_RIGHT_SIDEBAR_SIZE,
        projects: {},
        projectUi: { [PROJECT_ID]: { expanded: {}, summary: "feat: one", description: "body" } },
        chatViewers: {},
        viewerWidthPx: null,
      })
    })

    test("v10 keeps one viewer width for every chat, and drops each chat's own", () => {
      const v9 = migrateRightSidebarStore({
        size: 420,
        chatViewers: {
          "chat-1": { item: { kind: "chat", chatId: "a" }, expanded: false, widthPx: 520 },
          "chat-2": { item: { kind: "file", projectId: "p", path: "a.md" }, expanded: false, widthPx: 700, returnTo: { item: { kind: "chat", chatId: "b" }, widthPx: 480 } },
        },
      }, 9)
      expect(v9.chatViewers).toEqual({
        "chat-1": { item: { kind: "chat", chatId: "a" }, expanded: false },
        "chat-2": { item: { kind: "file", projectId: "p", path: "a.md" }, expanded: false, returnTo: { item: { kind: "chat", chatId: "b" } } },
      })
      expect(v9.viewerWidthPx).toBeNull()
      expect(migrateRightSidebarStore({ size: 420, viewerWidthPx: 640 }, 10).viewerWidthPx).toBe(640)
    })

    test("v11 opens a ticket left open as its delegator's pane, and a chat forgets its ticket", () => {
      const v10 = migrateRightSidebarStore({
        size: 420,
        chatViewers: {
          "deleg": { item: { kind: "ticket", chatId: "deleg", ticketId: "tk_00000d" }, expanded: false },
          "deleg-2": { item: { kind: "chat", chatId: "a", delegated: "deleg-2", ticket: "tk_00000e" }, expanded: false },
          "chat-3": { item: { kind: "file", projectId: "p", path: "a.md" }, expanded: false, returnTo: { item: { kind: "ticket", chatId: "deleg", ticketId: "tk_00000d" } } },
        },
      }, 10)
      expect(v10.chatViewers).toEqual({
        "deleg": { item: { kind: "delegated", chatId: "deleg" }, expanded: false },
        "deleg-2": { item: { kind: "chat", chatId: "a", delegated: "deleg-2" }, expanded: false },
        "chat-3": { item: { kind: "file", projectId: "p", path: "a.md" }, expanded: false, returnTo: { item: { kind: "delegated", chatId: "deleg" } } },
      })
    })

    test("keeps a v7 pixel width but resets an older percentage", () => {
      expect(migrateRightSidebarStore({ size: 520 }, 7).size).toBe(520)
      expect(migrateRightSidebarStore({ size: 44 }, 6).size).toBe(DEFAULT_RIGHT_SIDEBAR_SIZE)
      expect(migrateRightSidebarStore(null).size).toBe(DEFAULT_RIGHT_SIDEBAR_SIZE)
    })
  })
})
