// The command palette (components/command-palette/*, ui/command.tsx), open
// over any page. The slice contract is app/slice.ts.
//
//   model.ts          what CommandPalette held (stack, query, selection, the
//                     Add Project pages' state, the directory browser)
//   message.ts        its Messages
//   derive.ts         its render: the actions, the results, each page's rows
//   update.ts         the handlers, the effects keyed on what changed,
//                     `requestOpen` (AppAction.OpenCommandPalette) and `observe`
//   steps.ts          open, close, the page stack, the project requests
//   cmdk.ts           cmdk's markup, selection and keyboard model
//   view.ts, rows.ts, threadRow.ts, icons.ts   the markup
//   mounts.ts         the Radix dialog content, the root's keydown
//   commands.ts       socket requests, the repo metadata fetch, window calls
//   subscriptions.ts  the shortcut, This Mac, the phone layout
//   composer.ts       lib/composer + useComposer, for the model/mode rows
//   openIn.ts         the "Open in…" destinations

export { init, Model } from "./model"
export { Message } from "./message"
export { observe, requestOpen, update } from "./update"
export { view } from "./view"
export { subscriptions } from "./subscriptions"
