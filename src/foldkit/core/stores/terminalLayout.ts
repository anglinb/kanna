import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { readPersistedStore, writePersistedStore } from "../storage"

// Port of src/client/stores/terminalLayoutStore.ts: each project's terminal
// panes and how the chat page splits around them.
//
// `addTerminal` made up the new terminal's id and returned it. Ids are random,
// so here `AddTerminal` makes one and answers `AddedTerminal` carrying it,
// which is what the caller sees the id in; a caller that has an id already
// sends `AddedTerminal` itself.

export interface TerminalPaneLayout {
  id: string
  title: string
  size: number
}

export interface ProjectTerminalLayout {
  /** The project's own visibility, which every chat follows when the setting is per project. */
  isVisible: boolean
  /**
   * Each chat's visibility when the `paneVisibility.terminal` setting is per
   * chat, by chat id. The terminals themselves stay the project's; only
   * whether the pane shows is the chat's. A chat with no entry starts hidden.
   */
  chatVisibility?: Record<string, boolean>
  mainSizes: [number, number]
  terminals: TerminalPaneLayout[]
  nextTerminalIndex: number
}

const ProjectTerminalLayoutSchema = Schema.Struct({
  isVisible: Schema.Boolean,
  chatVisibility: Schema.optionalKey(Schema.Record(Schema.String, Schema.Boolean)),
  mainSizes: Schema.Tuple([Schema.Number, Schema.Number]),
  terminals: Schema.Array(Schema.Struct({ id: Schema.String, title: Schema.String, size: Schema.Number })),
  nextTerminalIndex: Schema.Number,
})
type StoredLayout = typeof ProjectTerminalLayoutSchema.Type

export const Model = Schema.Struct({
  projects: Schema.Record(Schema.String, ProjectTerminalLayoutSchema),
})
export type Model = typeof Model.Type

export const STORAGE_NAME = "terminal-layouts"
export const STORAGE_VERSION = 1

export const initialModel: Model = { projects: {} }

/** The persisted state over the defaults, as zustand's persist hydrates. */
export function load(storage?: Storage): Model {
  return { ...initialModel, ...readPersistedStore<Model>(STORAGE_NAME, STORAGE_VERSION, undefined, storage) }
}

export const DEFAULT_TERMINAL_MAIN_SIZES: [number, number] = [68, 32]

function createDefaultProjectLayout(): StoredLayout {
  return {
    isVisible: false,
    mainSizes: [...DEFAULT_TERMINAL_MAIN_SIZES],
    terminals: [],
    nextTerminalIndex: 0,
  }
}

function getProjectLayout(projects: Model["projects"], projectId: string): StoredLayout {
  return projects[projectId] ?? createDefaultProjectLayout()
}

/** Whether the pane is set to show, for this chat (`chatKey`) or else the project. */
export function isTerminalVisible(layout: Pick<ProjectTerminalLayout, "isVisible" | "chatVisibility">, chatKey?: string | null) {
  if (chatKey) return layout.chatVisibility?.[chatKey] ?? false
  return layout.isVisible
}

function withTerminalVisible(layout: StoredLayout, chatKey: string | null | undefined, visible: boolean): StoredLayout {
  return chatKey
    ? { ...layout, chatVisibility: { ...layout.chatVisibility, [chatKey]: visible } }
    : { ...layout, isVisible: visible }
}

function normalizeSizes(values: ReadonlyArray<number>): number[] {
  if (values.length === 0) return []
  const total = values.reduce((sum, value) => sum + Math.max(value, 0), 0)
  if (!Number.isFinite(total) || total <= 0) {
    return Array.from({ length: values.length }, () => 100 / values.length)
  }
  return values.map((value) => (Math.max(value, 0) / total) * 100)
}

function labelForTerminalIndex(index: number): string {
  let value = index
  let suffix = ""
  do {
    suffix = String.fromCharCode(65 + (value % 26)) + suffix
    value = Math.floor(value / 26) - 1
  } while (value >= 0)
  return `Terminal ${suffix}`
}

function scaleForAdditionalTerminal(terminals: StoredLayout["terminals"]): StoredLayout["terminals"] {
  if (terminals.length === 0) return terminals
  const nextCount = terminals.length + 1
  return terminals.map((terminal) => ({
    ...terminal,
    size: (terminal.size * terminals.length) / nextCount,
  }))
}

function withProjectLayout(
  projects: Model["projects"],
  projectId: string,
  update: (layout: StoredLayout) => StoredLayout
) {
  return {
    ...projects,
    [projectId]: update(getProjectLayout(projects, projectId)),
  }
}

const ChatKey = Schema.NullOr(Schema.String)

/** `chatKey` is the chat whose own visibility to change (see lib/paneVisibility); null changes the project's. */
export const Message = defineMessageUnion({
  AddedTerminal: {
    projectId: Schema.String,
    terminalId: Schema.String,
    afterTerminalId: Schema.NullOr(Schema.String),
    chatKey: ChatKey,
  },
  RemovedTerminal: { projectId: Schema.String, terminalId: Schema.String },
  ToggledVisibility: { projectId: Schema.String, chatKey: ChatKey },
  /** Collapse the panel without touching panes, so their shells keep running. */
  HidTerminals: { projectId: Schema.String, chatKey: ChatKey },
  ResetMainSizes: { projectId: Schema.String },
  ChangedMainSizes: { projectId: Schema.String, sizes: Schema.Array(Schema.Number) },
  ChangedTerminalSizes: { projectId: Schema.String, sizes: Schema.Array(Schema.Number) },
  ClearedProject: { projectId: Schema.String },
  CompletedSave: {},
})
export type Message = typeof Message.Type

export const Save = Command.define("SaveTerminalLayouts", {
  args: { state: Model },
  messages: [Message.CompletedSave],
  execute: ({ state }) => writePersistedStore(STORAGE_NAME, STORAGE_VERSION, state).pipe(Effect.as(Message.CompletedSave())),
})

/** A fresh terminal id, as `addTerminal` made one. */
export function newTerminalId(nextTerminalIndex: number): string {
  return globalThis.crypto?.randomUUID?.() ?? `terminal-${Date.now()}-${nextTerminalIndex}`
}

/** `addTerminal`: makes the id, then adds the terminal under it. */
export const AddTerminal = Command.define("AddTerminal", {
  args: {
    projectId: Schema.String,
    afterTerminalId: Schema.NullOr(Schema.String),
    chatKey: ChatKey,
    /** The project's `nextTerminalIndex`, for the fallback id where there is no `crypto.randomUUID`. */
    nextTerminalIndex: Schema.Number,
  },
  messages: [Message.AddedTerminal],
  execute: ({ nextTerminalIndex, ...args }) => Effect.sync(() => Message.AddedTerminal({ ...args, terminalId: newTerminalId(nextTerminalIndex) })),
})

// zustand's persist writes after every `set`, changed or not; so does this.
function saved(model: Model): Update.Return<Model, Message> {
  return { model, commands: [Save({ state: model })] }
}

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    AddedTerminal: ({ projectId, terminalId, afterTerminalId, chatKey }) => saved({
      projects: withProjectLayout(model.projects, projectId, (layout) => {
        const existing = scaleForAdditionalTerminal(layout.terminals)
        const nextTerminal: TerminalPaneLayout = {
          id: terminalId,
          title: labelForTerminalIndex(layout.nextTerminalIndex),
          size: 100 / (existing.length + 1),
        }
        const insertIndex = afterTerminalId
          ? Math.max(existing.findIndex((terminal) => terminal.id === afterTerminalId) + 1, 0)
          : existing.length
        return {
          ...withTerminalVisible(layout, chatKey, true),
          nextTerminalIndex: layout.nextTerminalIndex + 1,
          terminals: [
            ...existing.slice(0, insertIndex),
            nextTerminal,
            ...existing.slice(insertIndex),
          ],
        }
      }),
    }),
    RemovedTerminal: ({ projectId, terminalId }) => saved({
      projects: withProjectLayout(model.projects, projectId, (layout) => {
        const remaining = layout.terminals.filter((terminal) => terminal.id !== terminalId)
        if (remaining.length === 0) {
          // No terminals means no pane for any chat, so the next terminal
          // opens only where it's asked for.
          const { chatVisibility: _cleared, ...rest } = layout
          return {
            ...rest,
            isVisible: false,
            terminals: [],
          }
        }
        const normalizedSizes = normalizeSizes(remaining.map((terminal) => terminal.size))
        return {
          ...layout,
          terminals: remaining.map((terminal, index) => ({
            ...terminal,
            size: normalizedSizes[index] ?? 100 / remaining.length,
          })),
        }
      }),
    }),
    ToggledVisibility: ({ projectId, chatKey }) => saved({
      projects: withProjectLayout(model.projects, projectId, (layout) => withTerminalVisible(
        layout,
        chatKey,
        layout.terminals.length > 0 ? !isTerminalVisible(layout, chatKey) : false,
      )),
    }),
    HidTerminals: ({ projectId, chatKey }) => saved({
      projects: withProjectLayout(model.projects, projectId, (layout) => withTerminalVisible(layout, chatKey, false)),
    }),
    ResetMainSizes: ({ projectId }) => saved({
      projects: withProjectLayout(model.projects, projectId, (layout) => ({
        ...layout,
        mainSizes: [...DEFAULT_TERMINAL_MAIN_SIZES],
      })),
    }),
    ChangedMainSizes: ({ projectId, sizes }) => {
      if (sizes.length !== 2) return saved(model)
      const normalized = normalizeSizes(sizes) as [number, number]
      return saved({
        projects: withProjectLayout(model.projects, projectId, (layout) => ({
          ...layout,
          mainSizes: normalized,
        })),
      })
    },
    ChangedTerminalSizes: ({ projectId, sizes }) => saved({
      projects: withProjectLayout(model.projects, projectId, (layout) => {
        if (sizes.length !== layout.terminals.length) return layout
        const normalizedSizes = normalizeSizes(sizes)
        return {
          ...layout,
          terminals: layout.terminals.map((terminal, index) => ({
            ...terminal,
            size: normalizedSizes[index] ?? terminal.size,
          })),
        }
      }),
    }),
    ClearedProject: ({ projectId }) => {
      const { [projectId]: _removed, ...rest } = model.projects
      return saved({ projects: rest })
    },
    CompletedSave: () => ({ model }),
  })

export const DEFAULT_PROJECT_TERMINAL_LAYOUT: ProjectTerminalLayout = {
  isVisible: false,
  mainSizes: [...DEFAULT_TERMINAL_MAIN_SIZES],
  terminals: [],
  nextTerminalIndex: 0,
}

export function getDefaultProjectTerminalLayout() {
  return {
    ...DEFAULT_PROJECT_TERMINAL_LAYOUT,
    mainSizes: [...DEFAULT_PROJECT_TERMINAL_LAYOUT.mainSizes] as [number, number],
    terminals: [],
  }
}

/** A project's layout, or the default for one with none yet. */
export function projectTerminalLayout(model: Model, projectId: string): StoredLayout {
  return model.projects[projectId] ?? DEFAULT_PROJECT_TERMINAL_LAYOUT
}
