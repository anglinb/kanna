import { Option, Schema, Stream } from "effect"
import { Dom, Subscription } from "foldkit"
import { macSetupAvailable, type MacSetupState } from "../core/macApp"
import { bindingMatchesEvent, getBindingsForAction } from "../../client/lib/keybindings"
import type { KannaSocketService } from "../core/socket"
import { Message } from "./message"
import type { Model } from "./model"
import * as Usage from "./usage"

/** Window event that opens the command palette from anywhere (CommandPalette's OPEN_COMMAND_PALETTE_EVENT). */
export const OPEN_COMMAND_PALETTE_EVENT = "kanna:open-command-palette" as const

/** The phone layout, where the sidebar is a page and not a column (KannaSidebar's `isPhoneLayout`). */
const PHONE_LAYOUT_QUERY = "(max-width: 767px)"

/** The window, with the app's own events it hears. */
const appWindow = () => window as Dom.TypedEventTarget<{
  "kanna:open-command-palette": CustomEvent<{ page?: string } | undefined>
  "kanna:mac-setup": CustomEvent<MacSetupState>
}>

export const subscriptions = Subscription.make<Model, Message, KannaSocketService>()((entry) => ({
  // The openCommandPalette keybinding toggles the palette from anywhere.
  paletteShortcut: entry({ bindings: Schema.Array(Schema.String) }, {
    modelToDependencies: (model) => ({ bindings: getBindingsForAction(model.keybindings, "openCommandPalette") }),
    dependenciesToStream: ({ bindings }) => Dom.streamFromEventFilterMap({
      target: () => window,
      type: "keydown",
      filterMapEvent: (event) => {
        if (!bindings.some((binding) => bindingMatchesEvent(binding, event))) return Option.none()
        event.preventDefault()
        return Option.some(Message.PressedPaletteShortcut({ at: Date.now() }))
      },
    }),
  }),
  // Programmatic open (the mobile nav's search button, the sidebar's "New
  // chat in…"). An optional `detail.page` deep-links to a sub-page.
  paletteOpenRequests: Subscription.persistentEntry(
    Dom.streamFromEvent({
      target: appWindow,
      type: OPEN_COMMAND_PALETTE_EVENT,
      mapEvent: (event) => Message.ReceivedOpenRequest({
        page: event.detail?.page ?? null,
        at: Date.now(),
      }),
    }),
  ),
  // This Mac's switches, as Kanna for Mac reports them (useMacSetupStore).
  paletteMacSetup: Subscription.persistentEntry(
    Dom.streamFromEvent({
      target: appWindow,
      type: "kanna:mac-setup",
      mapEvent: (event) => Message.ReceivedMacSetup({
        state: macSetupAvailable() ? event.detail : null,
      }),
    }),
  ),
  // The Usage… page's useUsageLimits, while it shows.
  paletteUsage: entry({ active: Schema.Boolean }, {
    modelToDependencies: (model) => ({ active: model.usage.active }),
    dependenciesToStream: ({ active }) => active
      ? Usage.streams().pipe(Stream.map((message) => Message.GotUsageMessage({ message })))
      : Stream.empty,
  }),
  palettePhoneLayout: Subscription.persistentEntry(
    Dom.streamFromMediaQuery({
      query: PHONE_LAYOUT_QUERY,
      mapMatches: (phone) => Message.ChangedPhoneLayout({ phone }),
    }),
  ),
}))
