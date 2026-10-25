import { Submodel } from "foldkit"
import type { SliceViewInputs } from "../app/slice"
import { Message } from "./message"
import { init, Model } from "./model"
import { pageView } from "./view"

// The chat page at /chat/:chatId (src/client/app/ChatPage). Owns the page
// shell (navbar, tabs, layout, empty state) and composes the sub-slices,
// each its own folder and Submodel: transcript/, composer/, widgets/,
// viewer/, terminal/. Their requests to the root pass through unchanged.
// What it hands them on top of `app` is `page` (pageInputs.ts).
//
//   model.ts          the Model: the sub-slices, and what ChatPage kept in state
//   message.ts        the Messages
//   update.ts         what they do; the page's effects (`ObservedPage`)
//   view.ts           the layout: panes, terminal split, composer dock
//   navbar.ts         ChatNavbar, its wash, title and menus
//   widgetsColumn.ts  the widget column beside the chat (desktop)
//   emptyState.ts     the new chat page, drawn inside the transcript
//   effects.ts        Mounts and Commands against the live DOM
//   page.ts           what the page reads off the root Model

export { Message, Model, init }
export { update } from "./update"
export { subscriptions } from "./subscriptions"
export type { ChatPageContext, ChatPageSliceInputs } from "./pageInputs"

export const view = Submodel.defineView<Model, Message, SliceViewInputs>((model, { app }, h) => pageView(model, app, h))
