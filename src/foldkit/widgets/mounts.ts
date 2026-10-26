import { Effect, Schema } from "effect"
import { Mount } from "foldkit"
import { domStream } from "../ui/overlay/stream"
import { Message } from "./message"
import { Entry, Watch } from "./model"

// The column's Mounts that report to its own Message: what WidgetsSidebar's
// effects ran on, and the reads its rows started as they appeared.

/**
 * Keyed on the page facts it carries, so it mounts again whenever one of
 * them changes, and reports them: WidgetsSidebar's effects on their deps
 * (the polls follow `active`, a new chat's stops are its own).
 */
export const ObserveWidgetsPage = Mount.define("ObserveWidgetsPage", {
  args: { watch: Watch, paths: Schema.Array(Schema.String) },
  messages: [Message.ObservedPage],
  execute: ({ watch, paths }) => Effect.succeed(Message.ObservedPage({ watch, paths })),
})

/** A short fingerprint of a list of strings, for a key. */
export function fingerprint(values: ReadonlyArray<string>): string {
  let hash = 5381
  for (const value of values) {
    for (let index = 0; index < value.length; index += 1) hash = ((hash << 5) + hash + value.charCodeAt(index)) | 0
    hash = ((hash << 5) + hash) | 0
  }
  return `${values.length}:${(hash >>> 0).toString(36)}`
}

/** useBranchDetails for one row: its branch's details, read as the row appears. */
export const RequestBranchDetails = Mount.define("RequestWidgetBranchDetails", {
  args: { entry: Entry },
  messages: [Message.RequestedBranchDetails],
  execute: ({ entry }) => Effect.succeed(Message.RequestedBranchDetails({ entry })),
})

/**
 * A quick action's row: the page's own click runs it (`requests.runQuickAction`),
 * and this hears the same click (the check mark, the ports re-check). Enter
 * and Space on the row click it, so both hear them too.
 */
export const QuickActionRow = Mount.defineStream("WidgetQuickActionRow", {
  args: { id: Schema.String },
  messages: [Message.RanQuickAction],
  execute: ({ element, id }) => domStream<typeof Message.RanQuickAction.Type>((emit) => {
    const click = () => emit(Message.RanQuickAction({ id }))
    const keydown = (event: KeyboardEvent) => {
      if (event.target !== event.currentTarget) return
      if (event.key !== "Enter" && event.key !== " ") return
      event.preventDefault()
      ;(element as HTMLElement).click()
    }
    element.addEventListener("click", click)
    element.addEventListener("keydown", keydown as EventListener)
    return () => {
      element.removeEventListener("click", click)
      element.removeEventListener("keydown", keydown as EventListener)
    }
  }),
})
