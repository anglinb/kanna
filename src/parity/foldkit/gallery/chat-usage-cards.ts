// src/foldkit/chat/usageCards.ts against the React cards (gallery/chat-usage-cards.tsx).
import { Command } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { modifyFields } from "foldkit/struct"
import type { AppModel } from "../../../foldkit/app/slice"
import * as ChatPreferences from "../../../foldkit/core/stores/chatPreferences"
import * as Tooltip from "../../../foldkit/ui/tooltip"
import { Message } from "../../../foldkit/chat/message"
import { init, Model } from "../../../foldkit/chat/model"
import { usageCardKey, usageCardsView, usageTooltip } from "../../../foldkit/chat/usageCards"
import { USAGE_SNAPSHOTS } from "../../gallery-support/usage-snapshots"
import { galleryPage } from "../gallery-page"

const app = {
  stores: {
    sidebar: { data: { projectGroups: [] }, ready: true },
    chatPreferences: ChatPreferences.initialModel,
  },
} as unknown as AppModel

type Return = { model: Model; commands?: ReadonlyArray<Command.Command<Message>> }

function update(model: Model, message: Message): Return {
  switch (message._tag) {
    case "ClickedUsageCard": {
      const key = usageCardKey(null, message.provider)
      return { model: modifyFields(model, { usageCards: (cards) => ({ ...cards, expanded: { ...cards.expanded, [key]: !cards.expanded[key] } }) }) }
    }
    case "GotUsageTooltipMessage": {
      const result = Tooltip.update(usageTooltip(model, message.provider), message.message)
      return {
        model: modifyFields(model, { usageCards: (cards) => ({ ...cards, tooltips: { ...cards.tooltips, [message.provider]: result.model } }) }),
        commands: Command.mapMessages(result.commands, (inner: Tooltip.Message) => Message.GotUsageTooltipMessage({ provider: message.provider, message: inner })),
      }
    }
    default:
      return { model }
  }
}

export default galleryPage<Model, Message>({
  Model,
  init: () => ({ model: { ...init(), usageLimits: { providers: USAGE_SNAPSHOTS } as never } }),
  update,
  view: (model, h: HtmlBuilder<Message>): Document => ({
    title: "Kanna",
    body: h.div([h.Class("min-h-dvh bg-background p-6 pt-24 text-foreground")], [
      h.div([h.Class("mx-auto w-full max-w-[840px]")], [usageCardsView(model, app, null, h)]),
    ]),
  }),
})
