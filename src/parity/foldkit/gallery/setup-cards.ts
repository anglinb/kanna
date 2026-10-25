// settings/auth-cards.ts (AuthCard, setupCard) in the setup wizard's rows
// (setup/rows.ts) against the React cards (gallery/setup-cards.tsx).
import { Schema } from "effect"
import { Command } from "foldkit"
import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { AuthServiceSnapshot } from "../../../shared/types"
import * as ProviderAuth from "../../../foldkit/core/stores/providerAuth"
import * as AuthCard from "../../../foldkit/settings/auth-cards"
import { setupList } from "../../../foldkit/setup/rows"
import { HEADER_STATES, LOGIN_STATES, SETUP_CARD_SNAPSHOT } from "../../react/gallery/support/setup-states"
import { galleryPage } from "../gallery-page"

const Model = Schema.Struct({ cards: Schema.Record(Schema.String, AuthCard.Model) })
type Model = typeof Model.Type

const Message = defineMessageUnion({
  GotAuthCardMessage: { id: Schema.String, message: AuthCard.Message },
  ClickedSetupCard: {},
})
type Message = typeof Message.Type

const providerAuth: ProviderAuth.Model = { ...ProviderAuth.initialModel, snapshot: SETUP_CARD_SNAPSHOT, setupLoaded: true }

type Return = { model: Model; commands?: ReadonlyArray<Command.Command<Message>> }

function update(model: Model, message: Message): Return {
  switch (message._tag) {
    case "GotAuthCardMessage": {
      // Typing a code is local; anything that would reach the server goes nowhere here.
      if (message.message._tag !== "ChangedCode") return { model }
      const result = AuthCard.update(model.cards[message.id] ?? AuthCard.init(message.id), message.message)
      return { model: { cards: { ...model.cards, [message.id]: result.model } } }
    }
    default:
      return { model }
  }
}

function card(model: Model, slot: string, service: AuthServiceSnapshot, row: boolean, h: HtmlBuilder<Message>): Html {
  const id = `${slot}-${AuthCard.cardId(service)}`
  return h.submodel({
    slotId: id,
    model: model.cards[id] ?? AuthCard.init(id),
    view: AuthCard.view,
    viewInputs: { service, row },
    toParentMessage: (message) => Message.GotAuthCardMessage({ id, message }),
  })
}

export default galleryPage<Model, Message>({
  Model,
  init: () => ({ model: { cards: {} } }),
  update,
  view: (model, h: HtmlBuilder<Message>): Document => ({
    title: "Kanna",
    body: h.div([h.Class("min-h-dvh bg-background p-6 text-foreground")], [
      h.div([h.Class("grid grid-cols-[400px_400px_400px] items-start justify-center gap-6")], [
        setupList({}, HEADER_STATES.map((service) => card(model, "header", service, true, h)), h),
        setupList({}, LOGIN_STATES.map((service) => card(model, "login", service, true, h)), h),
        h.div([h.Class("space-y-3")], [
          AuthCard.setupCard({ providerAuth, onOpen: Message.ClickedSetupCard() }, h),
          card(model, "alone", HEADER_STATES[2]!, false, h),
          card(model, "alone", LOGIN_STATES[2]!, false, h),
          card(model, "alone", LOGIN_STATES[4]!, false, h),
        ]),
      ]),
    ]),
  }),
})
