import { describe, expect, test } from "bun:test"
import { Story } from "foldkit/test"
import {
  AddTerminal,
  getDefaultProjectTerminalLayout,
  initialModel,
  isTerminalVisible,
  load,
  Message,
  projectTerminalLayout,
  Save,
  STORAGE_NAME,
  update,
  type Model,
} from "./terminalLayout"
import { memoryStorage, persisted, run } from "./testing"

const PROJECT_ID = "project-1"

const added = (projectId: string, terminalId: string, chatKey: string | null = null) =>
  Message.AddedTerminal({ projectId, terminalId, afterTerminalId: null, chatKey })
const layoutOf = (model: Model, projectId = PROJECT_ID) => model.projects[projectId] ?? getDefaultProjectTerminalLayout()

describe("terminal layouts", () => {
  test("loads what the React store persisted", () => {
    const state: Model = {
      projects: {
        [PROJECT_ID]: {
          isVisible: true,
          chatVisibility: { "chat-a": true },
          mainSizes: [70, 30],
          terminals: [{ id: "t1", title: "Terminal A", size: 100 }],
          nextTerminalIndex: 1,
        },
      },
    }
    expect(load(memoryStorage({ [STORAGE_NAME]: persisted(state, 1) }))).toEqual(state)
  })

  test("adding a terminal makes its id, then adds it under that id and saves", () => {
    Story.story(
      update,
      Story.given(initialModel),
      Story.message(added(PROJECT_ID, "t1")),
      Story.Command.expectHas(Save),
      Story.Command.resolve(Save, Message.CompletedSave()),
    )
    const command = AddTerminal({ projectId: PROJECT_ID, afterTerminalId: null, chatKey: null, nextTerminalIndex: 0 })
    expect(command.name).toBe("AddTerminal")
  })

  test("adds the first terminal and shows the workspace", () => {
    const layout = layoutOf(run(update, initialModel, added(PROJECT_ID, "t1")))
    expect(layout.isVisible).toBe(true)
    expect(layout.terminals).toHaveLength(1)
    expect(layout.terminals[0]?.id).toBe("t1")
    expect(layout.terminals[0]?.title).toBe("Terminal A")
  })

  test("a terminal added after another goes right of it, and the panes share the width", () => {
    const model = run(
      update,
      initialModel,
      added(PROJECT_ID, "t1"),
      added(PROJECT_ID, "t2"),
      Message.AddedTerminal({ projectId: PROJECT_ID, terminalId: "t3", afterTerminalId: "t1", chatKey: null }),
    )
    const layout = layoutOf(model)
    expect(layout.terminals.map((terminal) => [terminal.id, terminal.title])).toEqual([["t1", "Terminal A"], ["t3", "Terminal C"], ["t2", "Terminal B"]])
    expect(layout.terminals.reduce((sum, terminal) => sum + terminal.size, 0)).toBeCloseTo(100)
  })

  test("keeps layouts isolated per project", () => {
    const model = run(update, initialModel, added(PROJECT_ID, "t1"), added("project-2", "t2"), added("project-2", "t3"))

    expect(model.projects[PROJECT_ID]?.terminals).toHaveLength(1)
    expect(model.projects["project-2"]?.terminals).toHaveLength(2)
  })

  test("removing the last terminal hides the workspace", () => {
    const model = run(update, initialModel, added(PROJECT_ID, "t1"), Message.RemovedTerminal({ projectId: PROJECT_ID, terminalId: "t1" }))

    const layout = layoutOf(model)
    expect(layout.isVisible).toBe(false)
    expect(layout.terminals).toHaveLength(0)
  })

  test("hiding keeps the panes so their shells stay attached", () => {
    const hidden = run(update, initialModel, added(PROJECT_ID, "t1"), Message.HidTerminals({ projectId: PROJECT_ID, chatKey: null }))
    expect(layoutOf(hidden).isVisible).toBe(false)
    expect(layoutOf(hidden).terminals).toHaveLength(1)

    const shown = run(update, hidden, Message.ToggledVisibility({ projectId: PROJECT_ID, chatKey: null }))
    expect(layoutOf(shown).isVisible).toBe(true)
    expect(layoutOf(shown).terminals[0]?.id).toBe("t1")
  })

  test("a chat key shows and hides the pane for that chat only", () => {
    let model = run(update, initialModel, added(PROJECT_ID, "t1", "chat-a"))
    expect(isTerminalVisible(layoutOf(model), "chat-a")).toBe(true)
    expect(isTerminalVisible(layoutOf(model), "chat-b")).toBe(false)
    expect(isTerminalVisible(layoutOf(model))).toBe(false)

    model = run(
      update,
      model,
      Message.ToggledVisibility({ projectId: PROJECT_ID, chatKey: "chat-b" }),
      Message.HidTerminals({ projectId: PROJECT_ID, chatKey: "chat-a" }),
    )
    expect(isTerminalVisible(layoutOf(model), "chat-a")).toBe(false)
    expect(isTerminalVisible(layoutOf(model), "chat-b")).toBe(true)
    expect(layoutOf(model).terminals).toHaveLength(1)
  })

  test("removing the last terminal forgets every chat's visibility", () => {
    const model = run(update, initialModel, added(PROJECT_ID, "t1", "chat-a"), Message.RemovedTerminal({ projectId: PROJECT_ID, terminalId: "t1" }))

    const layout = layoutOf(model)
    expect(layout.chatVisibility).toBeUndefined()
    expect(isTerminalVisible(layout, "chat-a")).toBe(false)
  })

  test("resetting main sizes restores the default split without removing terminals", () => {
    const model = run(
      update,
      initialModel,
      added(PROJECT_ID, "t1"),
      Message.ChangedMainSizes({ projectId: PROJECT_ID, sizes: [80, 20] }),
      Message.ResetMainSizes({ projectId: PROJECT_ID }),
    )

    const layout = layoutOf(model)
    expect(layout.mainSizes).toEqual([68, 32])
    expect(layout.isVisible).toBe(true)
    expect(layout.terminals).toHaveLength(1)
  })

  test("sizes are normalized to percentages, and a wrong count is ignored", () => {
    let model = run(update, initialModel, added(PROJECT_ID, "t1"), added(PROJECT_ID, "t2"), Message.ChangedMainSizes({ projectId: PROJECT_ID, sizes: [3, 1] }))
    expect(layoutOf(model).mainSizes).toEqual([75, 25])
    model = run(update, model, Message.ChangedTerminalSizes({ projectId: PROJECT_ID, sizes: [1, 3] }))
    expect(layoutOf(model).terminals.map((terminal) => terminal.size)).toEqual([25, 75])
    expect(run(update, model, Message.ChangedTerminalSizes({ projectId: PROJECT_ID, sizes: [1] }))).toEqual(model)
    expect(projectTerminalLayout(run(update, model, Message.ClearedProject({ projectId: PROJECT_ID })), PROJECT_ID).terminals).toEqual([])
  })
})
