import { Schema } from "effect"
import { defineMessageUnion } from "foldkit/message"
import * as Tooltip from "../ui/tooltip"
import * as Resizable from "./resizable"

/**
 * Where a workspace sits, which decides what closing a pane does:
 * - `page`: the /terminal page. A split closes and its shell is killed.
 * - `chat`: the chat page's panel. The only pane hides the panel and keeps
 *   its shell; a split closes, its shell is killed and its xterm dropped.
 */
export const Surface = Schema.Literals(["page", "chat"])
export type Surface = typeof Surface.Type

export const Message = defineMessageUnion({
  // The pane header's buttons.
  ClickedClearTerminal: { terminalId: Schema.String },
  ClickedAddTerminal: { layoutKey: Schema.String, afterTerminalId: Schema.String },
  ClickedRemoveTerminal: {
    layoutKey: Schema.String,
    terminalId: Schema.String,
    surface: Surface,
    /** The chat whose own visibility hiding the panel changes (chat surface). */
    chatKey: Schema.NullOr(Schema.String),
  },
  /** The new terminal's id, made (addTerminal's id) for an add. */
  MadeTerminalId: {
    layoutKey: Schema.String,
    terminalId: Schema.String,
    afterTerminalId: Schema.NullOr(Schema.String),
  },
  GotTooltipMessage: { terminalId: Schema.String, message: Tooltip.Message },
  /** The panel group's `onLayoutChanged`. */
  GotGroupMessage: { layoutKey: Schema.String, message: Resizable.Message },

  // From the pane Mounts (TerminalPane's callbacks and its own state).
  ChangedPanePath: { terminalId: Schema.String, path: Schema.NullOr(Schema.String) },
  ChangedPaneError: { terminalId: Schema.String, error: Schema.NullOr(Schema.String) },
  /**
   * `onCommandSent`: the pane sent a line. The chat page refreshes its diff
   * on this one; it reads it off `GotTerminalMessage` before folding.
   */
  SentPaneCommand: { terminalId: Schema.String },
  /** `onInitialCommandSent`: the pane ran the command it was opened with (chat page). */
  SentInitialCommand: { terminalId: Schema.String },

  MeasuredWorkspace: { width: Schema.Number },
  CompletedSideEffect: {},
})
export type Message = typeof Message.Type
