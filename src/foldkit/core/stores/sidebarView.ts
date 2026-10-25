import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { SIDEBAR_VIEW_STORAGE_KEY } from "../../../client/lib/storageKeys"
import { readStorageItem, writeStorageItem } from "../storage"

// Port of src/client/stores/sidebarViewStore.ts.

/**
 * Which view the sidebar is in. A store rather than the sidebar's own state so
 * the view outlives the sidebar component and can be read outside it.
 */

/** Copied from components/chat-ui/sidebar/SidebarViewSwitcher.tsx (a React file). */
export const SidebarView = Schema.Literals(["recents", "projects", "channels", "archived"])
export type SidebarView = typeof SidebarView.Type

const ReturnView = Schema.Literals(["recents", "projects", "channels"])
type ReturnView = typeof ReturnView.Type

export const Model = Schema.Struct({
  view: SidebarView,
  /**
   * Where Archived hands you back to. Archived is somewhere you visit and get
   * returned from, so it is never persisted: what's stored is this, across
   * reloads as well as within a session.
   */
  returnView: ReturnView,
})
export type Model = typeof Model.Type

export const initialModel: Model = { view: "recents", returnView: "recents" }

/** The stored view, as the React store read it at module load. */
export function load(storage?: Storage): Model {
  const stored = readStorageItem(SIDEBAR_VIEW_STORAGE_KEY, storage)
  const view: ReturnView = stored === "projects" || stored === "channels" ? stored : "recents"
  return { view, returnView: view }
}

export const Message = defineMessageUnion({
  ChangedView: { view: SidebarView },
  /** Back to the view you were in before Archived. A no-op from anywhere else. */
  LeftArchived: {},
  CompletedSave: {},
})
export type Message = typeof Message.Type

export const SaveSidebarView = Command.define("SaveSidebarView", {
  args: { view: ReturnView },
  messages: [Message.CompletedSave],
  execute: ({ view }) => writeStorageItem(SIDEBAR_VIEW_STORAGE_KEY, view).pipe(Effect.as(Message.CompletedSave())),
})

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    ChangedView: ({ view }) => {
      if (view === "archived") return { model: modifyFields(model, { view: () => view }) }
      return { model: { view, returnView: view }, commands: [SaveSidebarView({ view })] }
    },
    LeftArchived: () => ({
      model: model.view === "archived" ? modifyFields(model, { view: () => model.returnView }) : model,
    }),
    CompletedSave: () => ({ model }),
  })
