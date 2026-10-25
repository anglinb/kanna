import { Duration, Effect, Option, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import type { MacSetupState } from "../core/macApp"
import type { KannaSocketService } from "../core/socket"
import * as CloudPair from "../settings/cloud-pair"
import { macSetup } from "../settings/macApp"
import { domStream } from "../ui/overlay/stream"
import { Message, type Model } from "./model"

/** The window, with the Mac app's event it hears. */
const appWindow = () => window as Dom.TypedEventTarget<{ "kanna:mac-setup": CustomEvent<MacSetupState> }>

const own = Subscription.make<Model, Message, KannaSocketService>()((entry) => ({
  // Kanna › Setup… in the Mac app opens this wizard; its Fleet menu's Put
  // This Mac Online… opens it at the Kanna Cloud step.
  setupOpenRequests: Subscription.persistentEntry(
    domStream<Message>((emit) => {
      window.__kannaOpenSetup = (requested?: string) => {
        emit(Message.RequestedOpen({ step: requested === "cloud" ? "cloud" : null }))
      }
      return () => {
        delete window.__kannaOpenSetup
      }
    }),
  ),
  // useMacSetupStore: whatever the app reports, whenever it does.
  setupMacState: Subscription.persistentEntry(
    Stream.suspend(() => Dom.streamFromEvent({
      target: appWindow(),
      type: "kanna:mac-setup",
      mapEvent: (event) => Message.ReceivedMacState({ state: event.detail }),
    }) as Stream.Stream<Message>),
  ),
  // useMacSetupState: re-reads the live state every second while the wizard
  // is open, so a switch flipped in System Settings shows up.
  setupMacRefresh: entry({ active: Schema.Boolean }, {
    modelToDependencies: (model) => ({ active: model.macStepEnabled && model.wasOpen }),
    dependenciesToStream: ({ active }) => active
      ? Stream.tick(Duration.seconds(1)).pipe(
        Stream.mapEffect(() => Effect.sync(() => {
          macSetup.refresh()
          return Message.CompletedMacRequest()
        })),
      )
      : Stream.empty,
  }),
}))

/** useCloudPairSession's poll, while it is enabled (open, on a server that can use Kanna Cloud). */
const cloud = Subscription.lift(CloudPair.subscriptions)<Model, Message>({
  read: (model) => Option.some(model.cloud),
  toParentMessage: (message) => Message.GotCloudMessage({ message }),
  when: (model) => model.effectInputs?.cloudEnabled === true,
})

// Keys are app-wide (Settings has a "poll" of its own), so
// the wizard's copies go under names of their own.
export const subscriptions = Subscription.aggregate(own, {
  setupCloudPoll: cloud.poll,
  setupCloudReturnToView: cloud.returnToView,
})
