import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import type { DelegatePreference } from "../../../client/lib/delegators"
import { opaque } from "../schema"
import { readPersistedStore, writePersistedStore } from "../storage"

// Port of src/client/stores/delegateStore.ts, and the template for every
// store under core/stores: the state as a Model, each action as a Message,
// a pure update that also returns the write zustand's persist would have
// done, and `load` for the app's Flags. Selectors stay plain functions.

/**
 * What this browser remembers about delegating. Per project, what the new
 * chat page's delegate control was last set to: whether delegating is on
 * there, and which delegator it last sent to (`resolveDelegateTarget` says
 * what that means). Per delegator, whether its list has been shown yet.
 */
export const Model = Schema.Struct({
  projects: Schema.Record(Schema.String, opaque<DelegatePreference>("DelegatePreference")),
  /**
   * The delegators whose page has shown its list in the pane once. The list
   * is there by default the first time a delegator is opened; from then on
   * the pane is as it was left, and this is what tells the two apart.
   */
  paneShown: Schema.Record(Schema.String, Schema.Literal(true)),
  /**
   * When each delegator's page was last opened here. A click on a project
   * with several opens the one last viewed (`resolveProjectNewChat`). Kept in
   * this browser like the rest: another device goes by its own, or by which
   * is most active.
   */
  viewedAt: Schema.Record(Schema.String, Schema.Number),
})
export type Model = typeof Model.Type

export const STORAGE_NAME = "delegate-preferences"
export const STORAGE_VERSION = 1

export const initialModel: Model = { projects: {}, paneShown: {}, viewedAt: {} }

/** The persisted state over the defaults, as zustand's persist hydrates. */
export function load(storage?: Storage): Model {
  return { ...initialModel, ...readPersistedStore<Model>(STORAGE_NAME, STORAGE_VERSION, undefined, storage) }
}

export const Message = defineMessageUnion({
  ChangedPreference: { projectId: Schema.String, preference: opaque<DelegatePreference>("DelegatePreference") },
  ShowedPane: { chatId: Schema.String },
  /** Carries the time it happened: update can't read the clock. See `ViewDelegator`. */
  ViewedDelegator: { chatId: Schema.String, at: Schema.Number },
  CompletedSave: {},
})
export type Message = typeof Message.Type

export const Save = Command.define("SaveDelegatePreferences", {
  args: { state: Model },
  messages: [Message.CompletedSave],
  execute: ({ state }) => writePersistedStore(STORAGE_NAME, STORAGE_VERSION, state).pipe(Effect.as(Message.CompletedSave())),
})

/** For a caller that has no time to hand: stamps `ViewedDelegator` with now. */
export const ViewDelegator = Command.define("ViewDelegator", {
  args: { chatId: Schema.String },
  messages: [Message.ViewedDelegator],
  execute: ({ chatId }) => Effect.sync(() => Message.ViewedDelegator({ chatId, at: Date.now() })),
})

// zustand's persist writes after every `set`, changed or not; so does this.
function saved(model: Model): Update.Return<Model, Message> {
  return { model, commands: [Save({ state: model })] }
}

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    ChangedPreference: ({ projectId, preference }) => {
      const current = model.projects[projectId]
      if (current?.on === preference.on && current?.chatId === preference.chatId) return saved(model)
      return saved(modifyFields(model, { projects: (projects) => ({ ...projects, [projectId]: preference }) }))
    },
    ShowedPane: ({ chatId }) => saved(
      model.paneShown[chatId] ? model : modifyFields(model, { paneShown: (shown) => ({ ...shown, [chatId]: true as const }) }),
    ),
    ViewedDelegator: ({ chatId, at }) => saved(modifyFields(model, { viewedAt: (viewedAt) => ({ ...viewedAt, [chatId]: at }) })),
    CompletedSave: () => ({ model }),
  })
