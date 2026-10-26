import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { SIDEBAR_DELEGATORS_EXPANDED_STORAGE_KEY, SIDEBAR_PINNED_EXPANDED_STORAGE_KEY } from "../../../client/lib/storageKeys"
import { readStorageItem, writeStorageItem } from "../storage"

// Port of src/client/stores/sidebarSectionStore.ts.

/**
 * Which sidebar sections you have opened or folded, against their defaults.
 *
 * Held here rather than in the lists themselves because the lists come and
 * go: opening a channel replaces the channel list with that project's chats,
 * and going back mounts the channel list anew. In a component's own state
 * every such trip would put each section back to its default.
 *
 * One set of overrides per list (`scope`), keyed by the section's stable key.
 *
 * In memory, so a reload starts from the defaults, except for Pinned and
 * Delegators, which are kept in this browser. The other sections are named
 * for what is in them today (a date, "Relevant"), and a fold that outlived
 * the day would hide tomorrow's chats under the same name. Those two are the
 * same thing every day, and folding one is a standing choice.
 */

const SectionOverrides = Schema.Record(Schema.String, Schema.Boolean)
type SectionOverrides = typeof SectionOverrides.Type

export const Model = Schema.Struct({
  overrides: Schema.Record(Schema.String, SectionOverrides),
})
export type Model = typeof Model.Type

export const initialModel: Model = { overrides: {} }

const NO_OVERRIDES: SectionOverrides = {}

/**
 * The sections whose fold is remembered across reloads, and where. One
 * storage key each, holding a map of list to expanded: Pinned's was there
 * first, in that shape, and a second key leaves it as it is.
 */
const PERSISTED_SECTIONS: Readonly<Record<string, string>> = {
  pinned: SIDEBAR_PINNED_EXPANDED_STORAGE_KEY,
  delegators: SIDEBAR_DELEGATORS_EXPANDED_STORAGE_KEY,
}

export function load(storage?: Storage): Model {
  const overrides: Record<string, Record<string, boolean>> = {}
  for (const [sectionKey, storageKey] of Object.entries(PERSISTED_SECTIONS)) {
    try {
      const parsed: unknown = JSON.parse(readStorageItem(storageKey, storage) ?? "{}")
      if (!parsed || typeof parsed !== "object") continue
      for (const [scope, expanded] of Object.entries(parsed)) {
        if (typeof expanded === "boolean") (overrides[scope] ??= {})[sectionKey] = expanded
      }
    } catch {
      // Unreadable: that section starts from its default.
    }
  }
  return { overrides }
}

export const Message = defineMessageUnion({
  /** A section's toggle, or a command folding one from outside the list (`setSectionExpanded`). */
  ChangedSectionExpanded: { scope: Schema.String, sectionKey: Schema.String, expanded: Schema.Boolean },
  CompletedSave: {},
})
export type Message = typeof Message.Type

export const SaveSectionOverrides = Command.define("SaveSectionOverrides", {
  args: { storageKey: Schema.String, json: Schema.String },
  messages: [Message.CompletedSave],
  execute: ({ storageKey, json }) => writeStorageItem(storageKey, json).pipe(Effect.as(Message.CompletedSave())),
})

/** The write for a remembered section: every list's override for it, as one map. */
function persistOverrides(sectionKey: string, overrides: Model["overrides"]) {
  const storageKey = PERSISTED_SECTIONS[sectionKey]
  if (!storageKey) return []
  const stored = Object.fromEntries(
    Object.entries(overrides).flatMap(([scope, sections]) => (
      sectionKey in sections ? [[scope, sections[sectionKey]]] : []
    ))
  )
  return [SaveSectionOverrides({ storageKey, json: JSON.stringify(stored) })]
}

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    ChangedSectionExpanded: ({ scope, sectionKey, expanded }) => {
      const overrides = {
        ...model.overrides,
        [scope]: { ...model.overrides[scope], [sectionKey]: expanded },
      }
      return { model: { overrides }, commands: persistOverrides(sectionKey, overrides) }
    },
    CompletedSave: () => ({ model }),
  })

/** `useSectionOverrides`'s value: a list's overrides (the setter is `ChangedSectionExpanded`). */
export function sectionOverrides(model: Model, scope: string): SectionOverrides {
  return model.overrides[scope] ?? NO_OVERRIDES
}

/** A section's override as the model holds it now, or undefined for its default. */
export function sectionExpanded(model: Model, scope: string, sectionKey: string): boolean | undefined {
  return model.overrides[scope]?.[sectionKey]
}
