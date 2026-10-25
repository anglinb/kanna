import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { readPersistedStore, writePersistedStore } from "../storage"

// Port of src/client/stores/diffCommitStore.ts: which changed files are
// checked for the next commit, per project, stored as the exceptions to a
// mode ("all" checked, or "none").

export type DiffCommitSelectionMode = "all" | "none"

export interface ProjectDiffCommitSelection {
  mode: DiffCommitSelectionMode
  exceptions: Record<string, boolean>
}

const SelectionSchema = Schema.Struct({
  mode: Schema.Literals(["all", "none"]),
  exceptions: Schema.Record(Schema.String, Schema.Boolean),
})

export const Model = Schema.Struct({
  selectionsByProjectId: Schema.Record(Schema.String, SelectionSchema),
})
export type Model = typeof Model.Type

export const STORAGE_NAME = "diff-commit-selections"
export const STORAGE_VERSION = 4

export const initialModel: Model = { selectionsByProjectId: {} }

function defaultCheckedForMode(mode: DiffCommitSelectionMode) {
  return mode === "all"
}

export function isDiffPathChecked(selection: ProjectDiffCommitSelection | undefined, path: string) {
  const mode = selection?.mode ?? "all"
  return selection?.exceptions[path] ?? defaultCheckedForMode(mode)
}

function compactProjectSelection(selection: ProjectDiffCommitSelection) {
  const defaultChecked = defaultCheckedForMode(selection.mode)
  return {
    mode: selection.mode,
    exceptions: Object.fromEntries(
      Object.entries(selection.exceptions).filter(([, checked]) => checked !== defaultChecked)
    ),
  }
}

function pruneProjectSelection(selection: ProjectDiffCommitSelection, paths: ReadonlyArray<string>) {
  const knownPaths = new Set(paths)
  return compactProjectSelection({
    mode: selection.mode,
    exceptions: Object.fromEntries(
      Object.entries(selection.exceptions).filter(([path]) => knownPaths.has(path))
    ),
  })
}

function setProjectSelection(
  selectionsByProjectId: Model["selectionsByProjectId"],
  projectId: string,
  selection: ProjectDiffCommitSelection | undefined
) {
  const next = { ...selectionsByProjectId }
  if (!selection || (selection.mode === "all" && Object.keys(selection.exceptions).length === 0)) {
    delete next[projectId]
  } else {
    next[projectId] = compactProjectSelection(selection)
  }
  return next
}

function migrateFullPathSnapshot(selections: Record<string, Record<string, boolean>>) {
  return Object.fromEntries(
    Object.entries(selections)
      .map(([projectId, checkedPaths]) => {
        const entries = Object.entries(checkedPaths ?? {})
        const checkedEntries = entries.filter(([, checked]) => checked === true)
        const uncheckedEntries = entries.filter(([, checked]) => checked === false)
        const useNoneMode = checkedEntries.length < uncheckedEntries.length
        const selection: ProjectDiffCommitSelection = useNoneMode
          ? { mode: "none", exceptions: Object.fromEntries(checkedEntries) }
          : { mode: "all", exceptions: Object.fromEntries(uncheckedEntries) }
        return [projectId, compactProjectSelection(selection)] as const
      })
      .filter(([, selection]) => selection.mode === "none" || Object.keys(selection.exceptions).length > 0)
  )
}

function migrateSparseUncheckedSnapshot(selections: Record<string, Record<string, boolean>>) {
  return Object.fromEntries(
    Object.entries(selections)
      .map(([projectId, checkedPaths]) => [
        projectId,
        compactProjectSelection({
          mode: "all",
          exceptions: Object.fromEntries(
            Object.entries(checkedPaths ?? {}).filter(([, checked]) => checked === false)
          ),
        }),
      ] as const)
      .filter(([, selection]) => Object.keys(selection.exceptions).length > 0)
  )
}

export function migrateDiffCommitStore(persistedState: unknown, persistedVersion = 0) {
  if (!persistedState || typeof persistedState !== "object") {
    return { selectionsByProjectId: {} }
  }

  const state = persistedState as {
    checkedPathsByProjectId?: Record<string, Record<string, boolean>>
    selectionsByProjectId?: Record<string, ProjectDiffCommitSelection>
  }

  if (state.selectionsByProjectId) {
    return {
      selectionsByProjectId: Object.fromEntries(
        Object.entries(state.selectionsByProjectId).map(([projectId, selection]) => [
          projectId,
          compactProjectSelection({
            mode: selection?.mode === "none" ? "none" : "all",
            exceptions: selection?.exceptions ?? {},
          }),
        ])
      ),
    }
  }

  const checkedPathsByProjectId = state.checkedPathsByProjectId ?? {}
  return {
    selectionsByProjectId: persistedVersion >= 3
      ? migrateSparseUncheckedSnapshot(checkedPathsByProjectId)
      : migrateFullPathSnapshot(checkedPathsByProjectId),
  }
}

/** The persisted state over the defaults, migrated from older versions, as zustand's persist hydrates. */
export function load(storage?: Storage): Model {
  return { ...initialModel, ...readPersistedStore<Model>(STORAGE_NAME, STORAGE_VERSION, migrateDiffCommitStore, storage) }
}

export const Message = defineMessageUnion({
  /** The project's changed files are these: exceptions for files no longer there are dropped. */
  ReconciledProject: { projectId: Schema.String, paths: Schema.Array(Schema.String) },
  ChangedPathChecked: { projectId: Schema.String, path: Schema.String, checked: Schema.Boolean },
  ChangedAllChecked: { projectId: Schema.String, paths: Schema.Array(Schema.String), checked: Schema.Boolean },
  CompletedSave: {},
})
export type Message = typeof Message.Type

export const Save = Command.define("SaveDiffCommitSelections", {
  args: { state: Model },
  messages: [Message.CompletedSave],
  execute: ({ state }) => writePersistedStore(STORAGE_NAME, STORAGE_VERSION, state).pipe(Effect.as(Message.CompletedSave())),
})

// zustand's persist writes after every `set`, changed or not; so does this.
function saved(model: Model): Update.Return<Model, Message> {
  return { model, commands: [Save({ state: model })] }
}

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    ReconciledProject: ({ projectId, paths }) => {
      if (paths.length === 0) {
        return saved({ selectionsByProjectId: setProjectSelection(model.selectionsByProjectId, projectId, undefined) })
      }
      const current = model.selectionsByProjectId[projectId] ?? { mode: "all", exceptions: {} }
      const next = pruneProjectSelection(current, paths)
      if (
        current.mode === next.mode
        && Object.keys(current.exceptions).length === Object.keys(next.exceptions).length
        && Object.entries(next.exceptions).every(([path, checked]) => current.exceptions[path] === checked)
      ) {
        return saved(model)
      }
      return saved({ selectionsByProjectId: setProjectSelection(model.selectionsByProjectId, projectId, next) })
    },
    ChangedPathChecked: ({ projectId, path, checked }) => {
      const current = model.selectionsByProjectId[projectId] ?? { mode: "all", exceptions: {} }
      const next = {
        mode: current.mode,
        exceptions: { ...current.exceptions, [path]: checked },
      }
      return saved({ selectionsByProjectId: setProjectSelection(model.selectionsByProjectId, projectId, next) })
    },
    ChangedAllChecked: ({ projectId, checked }) => saved({
      selectionsByProjectId: setProjectSelection(
        model.selectionsByProjectId,
        projectId,
        { mode: checked ? "all" : "none", exceptions: {} }
      ),
    }),
    CompletedSave: () => ({ model }),
  })

export function projectSelection(model: Model, projectId: string): ProjectDiffCommitSelection | undefined {
  return model.selectionsByProjectId[projectId]
}
