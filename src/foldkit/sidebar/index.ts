// The left sidebar (src/client/app/KannaSidebar.tsx and everything it
// renders: components/chat-ui/sidebar/*, the channel list, the machine
// switcher). See app/slice.ts for the contract.
//
//   model.ts          its own state; the stores it reads stay in the root
//   message.ts        its Messages
//   update.ts         what they do; the root is asked through AppAction
//   view.ts           the card, header, list, footer, resize handle
//   subscriptions.ts  the clock, media queries, keys, resize and drag
//   derived.ts        what KannaSidebar worked out on every render
//   sections.ts / projects.ts / channels.ts   the Chats, Projects, Channels views
//   rows.ts           the chat row and its parts
//   menus.ts          the one right-click menu
//   hoverCard.ts      the list hover card and the chat card in it
//   machine.ts        the machine switcher and Kanna Cloud pairing
//   mounts.ts         the card's own element work (peek, scroll to active)

export { Model, init } from "./model"
export { Message } from "./message"
export { update } from "./update"
export { view } from "./view"
export { subscriptions } from "./subscriptions"
