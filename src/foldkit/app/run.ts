import { Runtime } from "foldkit"
import type { AppSettingsSnapshot } from "../../shared/types"
import { Flags, Message, Model, init, managedResources, readFlags, subscriptions, update, view } from "./main"

// Kept apart from main.ts so tests can import the program without booting it.

export interface RunKannaOptions {
  /** The demo and the parity fixture seed settings, as their React entries seed the store. */
  initialAppSettings?: AppSettingsSnapshot | null
}

export function runKanna(container: HTMLElement, options: RunKannaOptions = {}) {
  const application = Runtime.makeApplication({
    Model,
    Flags,
    init,
    update,
    view,
    subscriptions,
    managedResources,
    container,
    routing: {
      onUrlRequest: (request) => Message.ClickedLink({ request }),
      onUrlChange: (url) => Message.ChangedUrl({ url }),
    },
  })
  Runtime.run(application, { flags: readFlags(options) })
}
