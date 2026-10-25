import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { SIDEBAR_FOCUS_MODE_STORAGE_KEY } from "../../../client/lib/storageKeys"
import type { SidebarData, SidebarProjectGroup } from "../../../shared/types"
import { readStorageItem, writeStorageItem } from "../storage"

// Port of src/client/stores/focusModeStore.ts.

/**
 * Focus mode: the sidebar shows one project instead of all of them.
 *
 * The store holds a flag and nothing else. *Which* project is focused is always
 * the current one, read where the sidebar already knows it. So opening a chat in
 * another project re-points focus with no bookkeeping, and there is never a
 * frame where a stored project id and the open chat disagree.
 */
export const Model = Schema.Struct({ enabled: Schema.Boolean })
export type Model = typeof Model.Type

export const initialModel: Model = { enabled: false }

export function load(storage?: Storage): Model {
  return { enabled: readStorageItem(SIDEBAR_FOCUS_MODE_STORAGE_KEY, storage) === "1" }
}

export const Message = defineMessageUnion({
  /** `setFocusMode`, for key handlers and palette actions. */
  ChangedFocusMode: { enabled: Schema.Boolean },
  ToggledFocusMode: {},
  CompletedSave: {},
})
export type Message = typeof Message.Type

export const SaveFocusMode = Command.define("SaveFocusMode", {
  args: { enabled: Schema.Boolean },
  messages: [Message.CompletedSave],
  execute: ({ enabled }) => writeStorageItem(SIDEBAR_FOCUS_MODE_STORAGE_KEY, enabled ? "1" : "0").pipe(Effect.as(Message.CompletedSave())),
})

function setEnabled(model: Model, enabled: boolean): Update.Return<Model, Message> {
  if (model.enabled === enabled) return { model }
  return { model: { enabled }, commands: [SaveFocusMode({ enabled })] }
}

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    ChangedFocusMode: ({ enabled }) => setEnabled(model, enabled),
    ToggledFocusMode: () => setEnabled(model, !model.enabled),
    CompletedSave: () => ({ model }),
  })

/** `useFocusModeEnabled` / `isFocusModeEnabled`. */
export function focusModeEnabled(model: Model): boolean {
  return model.enabled
}

/**
 * The project focus mode is pinned to, or null when it is off. A focused
 * project that has left the snapshot (hidden, deleted) resolves to null, so the
 * sidebar falls back to showing everything rather than going blank.
 */
export function resolveFocusedProjectGroup(
  groups: SidebarProjectGroup[],
  enabled: boolean,
  currentProjectId: string | null
): SidebarProjectGroup | null {
  if (!enabled || !currentProjectId) return null
  return groups.find((group) => group.groupKey === currentProjectId) ?? null
}

/** The snapshot the sidebar renders: every project, or just the focused one. */
export function focusSidebarData(data: SidebarData, focused: SidebarProjectGroup | null): SidebarData {
  if (!focused) return data
  if (data.projectGroups.length === 1 && data.projectGroups[0] === focused) return data
  return { ...data, projectGroups: [focused] }
}
