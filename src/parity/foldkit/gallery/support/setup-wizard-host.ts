// The setup slice (src/foldkit/setup) on a gallery page, with as much of the
// root as it reads: the provider-auth store (open or closed, as the slice's
// asks move it) and the server's capabilities. In support/, not gallery/, so
// main.ts's glob doesn't take it for a page.
import { Option, Schema } from "effect"
import { Command, Subscription } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import type { ProviderAuthSnapshot } from "../../../../shared/types"
import type { AppAction } from "../../../../foldkit/app/action"
import type { AppModel, SliceOutMessage } from "../../../../foldkit/app/slice"
import * as ProviderAuth from "../../../../foldkit/core/stores/providerAuth"
import * as Setup from "../../../../foldkit/setup"
import { galleryPage } from "../../gallery-page"

const Model = Schema.Struct({ setup: Setup.Model, open: Schema.Boolean })
type Model = typeof Model.Type
const Message = defineMessageUnion({ GotSetupMessage: { message: Setup.Message } })
type Message = typeof Message.Type

const lift = (message: Setup.Message) => Message.GotSetupMessage({ message })

export interface WizardHostOptions {
  snapshot: ProviderAuthSnapshot
  /** Open as the page loads (else the page opens it through `window.__kannaOpenSetup`). */
  open: boolean
  cloud: boolean
  /** Runs before the slice starts (a stand-in for the Mac app, a stubbed fetch). */
  before?: () => void
}

/** What the root does with the slice's asks: only the wizard's own store changes matter here. */
function perform(open: boolean, action: AppAction): boolean {
  if (action._tag === "Batch") return (action.actions as AppAction[]).reduce(perform, open)
  if (action._tag !== "Store" || action.message._tag !== "GotProviderAuthMessage") return open
  const tag = action.message.message._tag
  if (tag === "OpenedSetupWizard") return true
  if (tag === "DismissedSetupWizard" || tag === "CompletedSetupWizard") return false
  return open
}

export function wizardHostPage(options: WizardHostOptions) {
  const appFor = (open: boolean) => ({
    stores: {
      providerAuth: { ...ProviderAuth.initialModel, snapshot: options.snapshot, setupWizardOpen: open, setupLoaded: true, setupShown: true },
      serverCapabilities: { value: options.cloud ? { cloud: true, publicSharing: true } : null },
    },
  }) as unknown as AppModel

  /** The slice's update, then its effects, as the root runs them. */
  function settle(model: Model, result: { model: Setup.Model; commands?: ReadonlyArray<unknown>; outMessage?: SliceOutMessage }) {
    const open = result.outMessage ? perform(model.open, result.outMessage.action) : model.open
    const observed = Setup.observe(result.model, appFor(model.open), appFor(open))
    const commands = [...(result.commands ?? []), ...(observed.commands ?? [])] as unknown as ReadonlyArray<Command.Command<Setup.Message>>
    return { model: { setup: observed.model, open }, commands: Command.mapMessages(commands, lift) }
  }

  return galleryPage<Model, Message>({
    Model,
    init: () => {
      options.before?.()
      return settle({ setup: Setup.init(), open: options.open }, { model: { ...Setup.init(), launchDecided: true } })
    },
    update: (model, message) => settle(model, Setup.update(model.setup, message.message, appFor(model.open))),
    view: (model, h: HtmlBuilder<Message>): Document => ({
      title: "Kanna",
      body: h.div([], [
        h.submodel({
          slotId: "setup",
          model: model.setup,
          view: Setup.view,
          viewInputs: { app: appFor(model.open) },
          toParentMessage: lift,
        }),
      ]),
    }),
    subscriptions: Subscription.lift(Setup.subscriptions)<Model, Message>({
      read: (model) => Option.some(model.setup),
      toParentMessage: (message) => lift(message as Setup.Message),
    }) as unknown as Subscription.Subscriptions<Model, Message>,
  })
}
