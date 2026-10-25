import { Schema } from "effect"
import * as Tooltip from "../ui/tooltip"

// What TerminalWorkspace held in its own state (the scroller's width, each
// pane's path and clear count) and what TerminalPane rendered from its own
// (the error line). The layout itself, which survives the workspace, is
// `app.stores.terminalLayout`; the preferences are `terminalPreferences`.
//
// One Model per embedding: the root's /terminal page, the chat page's panel.

export const Model = Schema.Struct({
  /** The scroller's width, from its ResizeObserver; 0 until measured. */
  viewportWidth: Schema.Number,
  pathsByTerminalId: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  errorsByTerminalId: Schema.Record(Schema.String, Schema.NullOr(Schema.String)),
  /**
   * Bumped by Clear. A pane takes the count it mounts with as its zero (see
   * pane.ts), so these never need resetting.
   */
  clearVersionsByTerminalId: Schema.Record(Schema.String, Schema.Number),
  /** Each pane's split button tooltip, made the first time it is used. */
  tooltips: Schema.Record(Schema.String, Tooltip.Model),
  /** The /terminal page asked for its first shell and is waiting for the id. */
  seeding: Schema.Boolean,
  /** The /terminal page sent this non-dev-box away and waits for the route to change. */
  leaving: Schema.Boolean,
})
export type Model = typeof Model.Type

export function init(): Model {
  return {
    viewportWidth: 0,
    pathsByTerminalId: {},
    errorsByTerminalId: {},
    clearVersionsByTerminalId: {},
    tooltips: {},
    seeding: false,
    leaving: false,
  }
}

/** The tooltip's id: unique on the page, as Radix's useId was. */
export function splitTooltipId(terminalId: string) {
  return `terminal-split-${terminalId}`
}
