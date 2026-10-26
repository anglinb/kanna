import { Subscription } from "foldkit"
import type { KannaSocketService } from "../core/socket"
import type { Model } from "./model"
import type { Message } from "./message"

// Terminals: the /terminal page (src/client/app/TerminalPage.tsx) and the
// chat page's terminal workspace (TerminalWorkspace, TerminalPane), one
// Submodel serving both. The root embeds it as `terminalPage` and renders
// the page; the chat page embeds it as `terminal` and renders the workspace
// by passing its `page` context (chat/pageInputs.ts) in the view inputs, or
// a ready `workspace` (see view.ts).
//
// The pieces:
//   view.ts           TerminalPage and TerminalWorkspace's markup
//   update.ts         their handlers, and TerminalPage's effects (`observe`)
//   mounts.ts         the pane's xterm and the scroller, as Mounts
//   pane.ts, xterm.ts TerminalPane's effects, without React
//   resizable/        react-resizable-panels' Group/Panel/Separator and the
//                     shadcn wrappers (the chat page can use them too)
//
// The chat page reads two facts off the Messages it folds in:
// `SentPaneCommand` (onTerminalCommandSent) and `SentInitialCommand`
// (onInitialTerminalCommandSent).

export { init, Model } from "./model"
export { Message, Surface } from "./message"
export { HOME_TERMINAL_LAYOUT_KEY, observe, update } from "./update"
export { chatWorkspaceOptions, view, workspaceView, type ChatTerminalContext, type ViewInputs, type WorkspaceOptions } from "./view"
export { disposeCachedTerminal } from "./pane"

/**
 * None: the root and the chat page both lift these, and a keyed entry would
 * collide across the two lifts. The panes get the socket by a Command
 * (socketBridge.ts) and their streams through their Mounts.
 */
export const subscriptions = Subscription.make<Model, Message, KannaSocketService>()(() => ({}))
