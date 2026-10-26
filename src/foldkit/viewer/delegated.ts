import { Effect } from "effect"
import { Mount } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { delegatedListTitle, delegatedThreads, isUnnamedDelegator } from "../../client/lib/delegators"
import { flattenSidebarThreads } from "../../client/lib/thread-sections"
import { cn } from "../../client/lib/utils"
import type { AppModel } from "../app/slice"
import { sidebarThread } from "../chat/chatReference"
import { Message } from "./message"
import type { Model } from "./model"
import { VIEWER_END_PAD_CLASS, viewerSurface, type LayerContext } from "./surface"

// DelegatedList (app/ChatPage/DelegatedList.tsx): the chats under a
// delegator, as a list to pick from. The navbar's button opens it, in the
// viewer's pane or, on a phone, over the transcript, and it is in the pane
// the first time a delegator's page is opened. While the pane is open it is
// what everything opened on a delegator's page sits over
// (`lib/viewer-levels`).

type H = HtmlBuilder<Message>

export const DELEGATED_CARD_KEY = "delegated"

/** A list for a chat that is no longer a delegator has nothing to be a list of. */
export const ReportNotDelegator = Mount.define("ViewerReportNotDelegator", {
  messages: [Message.LostPreviewedChat],
  execute: () => Effect.succeed(Message.LostPreviewedChat()),
})

export function delegatedList(model: Model, context: LayerContext, app: AppModel, item: { chatId: string }, h: H): Html {
  const delegator = sidebarThread(app, item.chatId)
  const threads = delegatedThreads(flattenSidebarThreads(app.stores.sidebar.data), item.chatId)
  // The header is the delegator's name and nothing else; what the pane is
  // stays in its accessible name, which has no navbar to lean on.
  const title = delegatedListTitle(delegator?.title)
  const named = delegator !== null && !isUnnamedDelegator(delegator.title)
  const stillDelegator = Boolean(delegator?.row.delegator)
  return viewerSurface(model, context, {
    cardKey: DELEGATED_CARD_KEY,
    label: named ? `Delegated chats, ${title}` : "Delegated chats",
    title,
    // Back from a chat is a new card: it opens where the list was left.
    scrollMemoryKey: `delegated:${item.chatId}`,
    // There when a delegator's page opens, without having been asked for.
    quietFocus: true,
    body: [
      // The sidebar's own gutter, so the rows sit in the card as they sit in the sidebar.
      h.div([h.Class(cn("px-[7px] pb-2", VIEWER_END_PAD_CLASS))], [
        threads.length === 0
          ? h.p([h.Class("px-[10px] py-6 text-sm text-muted-foreground")], [
            "No chats yet. The ones this delegator starts or messages are listed here.",
          ])
          // The rows are the sidebar's (ThreadSections, its hover card and
          // menu), which are the sidebar slice's to draw. Not ported here:
          // the demo has no delegator with chats under it.
          : h.div([], []),
      ]),
      app.stores.sidebar.ready && !stillDelegator && app.stores.viewer.floor === null
        ? h.keyed("span")(`not-delegator:${item.chatId}`, [h.Hidden(true), h.OnMount(ReportNotDelegator())], [])
        : null,
    ],
  }, h)
}
