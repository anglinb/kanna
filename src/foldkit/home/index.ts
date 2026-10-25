import { Effect, Stream } from "effect"
import { Subscription } from "foldkit"
import { statusStream, type KannaSocketService } from "../core/socket"
import { Message, type Model } from "./model"

// The projects page at /, /home and /project/:id: LocalProjectsPage, its
// LocalDev frame, and components/home/* (ProjectsHome, homeItems,
// useGitHubRecentRepos). The slice contract is app/slice.ts.
//
//   model.ts     what the page holds, its Messages
//   update.ts    what they do, the reads of the root the view shares, and
//                `observe` (a refetch when GitHub's sign-in changes)
//   commands.ts  the recent-repos request, window calls, the page's Mounts
//   view.ts      the page, the list, its menus and the archived-chats dialog

export { init, Message, Model } from "./model"
export { observe, update } from "./update"
export { view } from "./view"

/**
 * The socket's status with the time it changed: LocalDev's timers (setup
 * help after 1.5s of failing, the fade-in after a visible wait) count from
 * the changes. KannaSocket.onStatus is local; the server sees nothing.
 */
export const subscriptions = Subscription.make<Model, Message, KannaSocketService>()(() => ({
  socketStatus: Subscription.persistentEntry(
    statusStream.pipe(
      Stream.mapEffect((status) => Effect.sync(() => Message.ChangedSocketStatus({ status, at: Date.now() }))),
    ),
  ),
}))
