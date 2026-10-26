import { Submodel } from "foldkit"
import type { SliceViewInputs } from "../app/slice"
import { Message } from "./message"
import { init, Model } from "./model"
import { pageView } from "./view"

// The chat page at /chat/:chatId (src/client/app/ChatPage). Owns the page
// shell (navbar, tabs, layout, empty state) and composes the sub-slices,
// each its own folder and Submodel: transcript/, composer/, widgets/,
// viewer/, terminal/. Their requests to the root pass through unchanged,
// but for three the page answers itself, as ChatPage's handlers did: the
// composer's send on the new chat page with a delegator picked
// (newChatDelegate.ts), and a file link in this project from the transcript
// or the viewer (it opens in the viewer). What it hands them on top of `app`
// is `page` (pageInputs.ts).
//
//   model.ts             the Model: the sub-slices, and what ChatPage kept in state
//   message.ts           the Messages
//   update.ts            what they do; the page's effects (`ObservedPage`)
//   subscriptions.ts     window width, the page leaving, the usage-limits topic
//   view.ts              the layout: panes, terminal split, composer dock
//   navbar.ts            ChatNavbar, its wash, title, menus, a delegator's list button
//   chatTabs.ts          ChatTabs: the open chats as tabs (the Chat Tabs setting)
//   tabHoverCard.ts      the sidebar's chat card beneath the tab under the pointer
//   chatRowMenu.ts       a chat's right-click menu (ThreadRowMenu), as data
//   openExternal.ts      "Open in…": the split button, its list, the menu rows
//   editorIcons.ts       the editors', terminals' and Finder's app icons
//   widgetsColumn.ts     the widget column beside the chat (desktop), its peek (edgePeek.ts)
//   emptyState.ts        the new chat page, drawn inside the transcript
//   emptyStateProject.ts its setup card and the project's chats
//   newChatDelegate.ts   delegating from the new chat page
//   terminalPane.ts      the terminal toggle's rules (useTerminalToggleAnimation)
//   resizable.ts         react-resizable-panels' DOM, and a separator's drag
//   effects.ts           Mounts and Commands against the live DOM
//   page.ts              what the page reads off the root Model
//
// For other slices (leaves: import the file, not this index, to stay out of
// a cycle with the sub-slices this composes):
//   shareDialog.ts        StandaloneShareDialog, for the root to render at layout level
//   contextWindowMeter.ts ContextWindowMeter, for the composer
//   chatReference.ts      chat-reference / ChatOpenMenuItems / useOpenChat, for
//                         whatever shows another chat inside this one

export { Message, Model, init }
export { update, observe } from "./update"
export { subscriptions } from "./subscriptions"
export type { ChatPageContext, ChatPageSliceInputs } from "./pageInputs"

export const view = Submodel.defineView<Model, Message, SliceViewInputs>((model, { app }, h) => pageView(model, app, h))
