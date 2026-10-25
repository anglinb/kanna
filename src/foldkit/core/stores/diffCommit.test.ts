import { describe, expect, test } from "bun:test"
import { Story } from "foldkit/test"
import {
  initialModel,
  isDiffPathChecked,
  load,
  Message,
  migrateDiffCommitStore,
  Save,
  STORAGE_NAME,
  update,
} from "./diffCommit"
import { memoryStorage, persisted, run } from "./testing"

describe("diff commit selections", () => {
  test("loads what the React store persisted at v4", () => {
    const model = load(memoryStorage({
      [STORAGE_NAME]: persisted({ selectionsByProjectId: { p1: { mode: "none", exceptions: { "a.ts": true } } } }, 4),
    }))
    expect(model.selectionsByProjectId).toEqual({ p1: { mode: "none", exceptions: { "a.ts": true } } })
  })

  test("migrates what an older store persisted", () => {
    const model = load(memoryStorage({
      [STORAGE_NAME]: persisted({ checkedPathsByProjectId: { p1: { "a.ts": false, "b.ts": false, "c.ts": true } } }, 2),
    }))
    expect(model.selectionsByProjectId).toEqual({ p1: { mode: "none", exceptions: { "c.ts": true } } })
  })

  test("every change is saved", () => {
    Story.story(
      update,
      Story.given(initialModel),
      Story.message(Message.ChangedPathChecked({ projectId: "project-1", path: "a.ts", checked: false })),
      Story.Command.expectExact(Save({ state: { selectionsByProjectId: { "project-1": { mode: "all", exceptions: { "a.ts": false } } } } })),
      Story.Command.resolve(Save, Message.CompletedSave()),
    )
  })

  test("defaults paths to checked without storing them", () => {
    const model = run(update, initialModel, Message.ReconciledProject({ projectId: "project-1", paths: ["a.ts", "b.ts"] }))

    expect(model.selectionsByProjectId).toEqual({})
    expect(isDiffPathChecked(undefined, "a.ts")).toBe(true)
  })

  test("stores unchecked exceptions when most paths are selected", () => {
    const model = run(
      update,
      initialModel,
      Message.ChangedPathChecked({ projectId: "project-1", path: "a.ts", checked: false }),
      Message.ChangedPathChecked({ projectId: "project-1", path: "b.ts", checked: true }),
    )

    const selection = model.selectionsByProjectId["project-1"]
    expect(selection).toEqual({ mode: "all", exceptions: { "a.ts": false } })
    expect(isDiffPathChecked(selection, "a.ts")).toBe(false)
    expect(isDiffPathChecked(selection, "b.ts")).toBe(true)
  })

  test("stores checked exceptions when most paths are unselected", () => {
    const model = run(
      update,
      initialModel,
      Message.ChangedAllChecked({ projectId: "project-1", paths: ["a.ts", "b.ts", "c.ts"], checked: false }),
      Message.ChangedPathChecked({ projectId: "project-1", path: "b.ts", checked: true }),
    )

    const selection = model.selectionsByProjectId["project-1"]
    expect(selection).toEqual({ mode: "none", exceptions: { "b.ts": true } })
    expect(isDiffPathChecked(selection, "a.ts")).toBe(false)
    expect(isDiffPathChecked(selection, "b.ts")).toBe(true)
  })

  test("removes all-selected project state", () => {
    const model = run(
      update,
      initialModel,
      Message.ChangedAllChecked({ projectId: "project-1", paths: ["a.ts", "b.ts"], checked: false }),
      Message.ChangedAllChecked({ projectId: "project-1", paths: ["a.ts", "b.ts"], checked: true }),
    )

    expect(model.selectionsByProjectId).toEqual({})
  })

  test("keeps all-unselected project state compactly", () => {
    const model = run(update, initialModel, Message.ChangedAllChecked({ projectId: "project-1", paths: ["a.ts", "b.ts"], checked: false }))

    expect(model.selectionsByProjectId).toEqual({ "project-1": { mode: "none", exceptions: {} } })
  })

  test("reconcile prunes stale exceptions", () => {
    const model = run(
      update,
      initialModel,
      Message.ChangedAllChecked({ projectId: "project-1", paths: ["a.ts", "b.ts"], checked: false }),
      Message.ChangedPathChecked({ projectId: "project-1", path: "a.ts", checked: true }),
      Message.ReconciledProject({ projectId: "project-1", paths: ["b.ts", "c.ts"] }),
    )

    expect(model.selectionsByProjectId).toEqual({ "project-1": { mode: "none", exceptions: {} } })
  })

  test("migration compacts old full checked path snapshots to the smaller side", () => {
    expect(migrateDiffCommitStore({
      checkedPathsByProjectId: {
        "project-mostly-checked": { "a.ts": true, "b.ts": true, "c.ts": false },
        "project-mostly-unchecked": { "a.ts": false, "b.ts": false, "c.ts": true },
      },
    }, 2)).toEqual({
      selectionsByProjectId: {
        "project-mostly-checked": { mode: "all", exceptions: { "c.ts": false } },
        "project-mostly-unchecked": { mode: "none", exceptions: { "c.ts": true } },
      },
    })
  })

  test("migration keeps interim sparse unchecked snapshots in all mode", () => {
    expect(migrateDiffCommitStore({
      checkedPathsByProjectId: { "project-1": { "a.ts": false, "b.ts": false } },
    }, 3)).toEqual({
      selectionsByProjectId: { "project-1": { mode: "all", exceptions: { "a.ts": false, "b.ts": false } } },
    })
  })
})
