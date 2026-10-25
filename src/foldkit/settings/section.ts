import { Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { AppAction } from "../app/action"
import type { Model as AppModel } from "../app/model"
import type { KannaSocketService } from "../core/socket"
import { SETTINGS_SECTIONS, type SettingsSectionId } from "./registry"

// What every section module (general.ts, providers.ts, …) shares with the
// page (index.ts).
//
// A section asks the root for things as the page does, but a handler in
// React often did two at once: a store setter and then the settings write
// (`setScrollbackLines(next); handleWriteAppSettings(...)`). A slice's update
// emits one OutMessage, so a section names the whole list and the page runs
// them in order, one per update (index.ts `ContinuedAppActions`).

export type { AppModel }

export const SectionOutMessage = defineMessageUnion({
  RequestedAppActions: { actions: Schema.Array(AppAction) },
})
export type SectionOutMessage = typeof SectionOutMessage.Type

export type SectionReturn<Model, Message> = Update.ReturnWithOutMessage<Model, Message, SectionOutMessage, KannaSocketService>

/** A section's update that asks the root for these, in this order. */
export function requestActions<Model, Message>(
  model: Model,
  actions: ReadonlyArray<AppAction>,
  commands: SectionReturn<Model, Message>["commands"] = [],
): SectionReturn<Model, Message> {
  if (actions.length === 0) return { model, commands }
  return { model, commands, outMessage: SectionOutMessage.RequestedAppActions({ actions }) }
}

/**
 * Runs a UI primitive's update result into the section: writes the child
 * Model back and lifts its Commands. The caller acts on `outMessage`.
 */
export function liftChild<ChildModel, ChildMessage, ChildOutMessage, Model, Message, R>(
  result: Readonly<{ model: ChildModel; commands?: Update.Commands<ChildMessage, R>; outMessage?: ChildOutMessage }>,
  write: (child: ChildModel) => Model,
  wrap: (message: ChildMessage) => Message,
): { model: Model; commands: Update.Commands<Message, R>; outMessage: ChildOutMessage | undefined } {
  return {
    model: write(result.model),
    commands: Command.mapMessages(result.commands ?? [], wrap) as Update.Commands<Message, R>,
    outMessage: result.outMessage,
  }
}

/** Every section's view gets the root Model, read-only, and the page's bits. */
export interface SectionViewInputs {
  app: AppModel
  /** SDK_CLIENT_APP's version, "unknown" if it has none. */
  appVersion: string
  /** Another section was shown first since the page opened: this one fades in. */
  switched: boolean
}

export function sectionSubtitle(id: SettingsSectionId): string {
  return SETTINGS_SECTIONS.find((section) => section.id === id)?.subtitle ?? ""
}

export function sectionLabel(id: SettingsSectionId): string {
  return SETTINGS_SECTIONS.find((section) => section.id === id)?.label ?? ""
}
