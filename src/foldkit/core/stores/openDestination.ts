import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { OPEN_EXTERNAL_SELECT_STORAGE_KEY, OPEN_FILE_DESTINATION_STORAGE_KEY } from "../../../client/lib/storageKeys"
import { readStorageItem, writeStorageItem } from "../storage"

// Port of src/client/stores/openDestinationStore.ts.

/**
 * The destination the navbar's "Open in…" split button last opened, kept in a
 * store rather than the navbar's own state so the context menus elsewhere can
 * name the same editor the button would use. Persisted under the key the
 * navbar has always used, so an existing choice survives this move.
 *
 * The raw string is stored, not an `OpenAppValue`: this module is imported by
 * the menu that owns that type, and validating here would invert that.
 */
export const Model = Schema.Struct({
  value: Schema.NullOr(Schema.String),
  /**
   * The viewer's "Open in…" for one file, remembered apart from the
   * navbar's: a file can open in Preview or its default app, which the
   * navbar (a whole project) doesn't offer, and picking one for a file
   * shouldn't change where the project opens.
   */
  fileValue: Schema.NullOr(Schema.String),
})
export type Model = typeof Model.Type

export const initialModel: Model = { value: null, fileValue: null }

// Private-mode Safari and friends: remembering the choice is a nicety, so an
// unreadable key reads as no choice (readStorageItem catches).
export function load(storage?: Storage): Model {
  return {
    value: readStorageItem(OPEN_EXTERNAL_SELECT_STORAGE_KEY, storage),
    fileValue: readStorageItem(OPEN_FILE_DESTINATION_STORAGE_KEY, storage),
  }
}

export const Message = defineMessageUnion({
  ChoseDestination: { value: Schema.String },
  ChoseFileDestination: { value: Schema.String },
  CompletedSave: {},
})
export type Message = typeof Message.Type

/** Not persisted when storage refuses, but still honoured for this session. */
export const SaveOpenDestination = Command.define("SaveOpenDestination", {
  args: { key: Schema.String, value: Schema.String },
  messages: [Message.CompletedSave],
  execute: ({ key, value }) => writeStorageItem(key, value).pipe(Effect.as(Message.CompletedSave())),
})

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    ChoseDestination: ({ value }) => ({
      model: modifyFields(model, { value: () => value }),
      commands: [SaveOpenDestination({ key: OPEN_EXTERNAL_SELECT_STORAGE_KEY, value })],
    }),
    ChoseFileDestination: ({ value }) => ({
      model: modifyFields(model, { fileValue: () => value }),
      commands: [SaveOpenDestination({ key: OPEN_FILE_DESTINATION_STORAGE_KEY, value })],
    }),
    CompletedSave: () => ({ model }),
  })
