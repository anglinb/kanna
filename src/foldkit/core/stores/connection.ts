import { Effect, Queue, Schema, Stream } from "effect"
import { Command, Subscription, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import {
  CLOUD_BROWSER_PATH_PREFIX,
  CLOUD_FLEET_PATH,
  type CloudLocalFleetResponse,
  type CloudMachineSummary,
  type CloudMachinesResponse,
} from "../../../shared/cloud-api"
import type { ServerCapabilities } from "../../../shared/server-capabilities"
import { opaque } from "../schema"
import { getServerCapabilities } from "./serverCapabilities"

// Port of src/client/stores/connectionStore.ts.

/**
 * Cloud-mode detection + the paired-machine list for the sidebar switcher.
 *
 * Feature detection: `GET /__cloud/machines` is answered by the kanna.sh
 * proxy on machine subdomains (never forwarded); the machine's own server
 * explicitly 404s the prefix, so a JSON 200 means "cloud", anything else
 * means "local". Not persisted — the answer is a property of the origin.
 *
 * On the machine's own address (localhost) there's no kanna.sh session, so
 * a paired machine lists its Fleet itself, with its machine credentials
 * (`GET /api/cloud/fleet`, src/server/cloud/fleet.ts), and names itself.
 *
 * Kanna for Mac also knows which machine the window shows, and shows this
 * Mac at its local address. So it hands the page the list
 * (`pushFleet` in macos/src/window.ts), and while it does, that list
 * wins, on localhost or on a machine subdomain.
 *
 * `load` was an async action; here it is `LoadConnection`, whose requests
 * resolve to one of three Messages, and update decides with the Model as it
 * is when the answer lands (the store read `fromMacApp` after its awaits
 * too). The module-level `kanna:fleet` listener is `subscriptions.macAppFleet`.
 */

export type ConnectionMode = "unknown" | "local" | "cloud"

/** What Kanna for Mac pushes: null while signed out or still loading. */
export interface MacAppFleet {
  machines: CloudMachineSummary[]
  /** This Mac's subdomain; absent when it isn't on Kanna Cloud. */
  thisMachine?: string
  /** The machine the window shows; absent for an unpaired this Mac. */
  showing?: string
}

const Machines = Schema.Array(opaque<CloudMachineSummary>("CloudMachineSummary"))

export const Model = Schema.Struct({
  mode: Schema.Literals(["unknown", "local", "cloud"]),
  machines: Machines,
  /** The machine serving this page, when it knows (localhost, Kanna for Mac). */
  thisMachine: Schema.NullOr(Schema.String),
  showingMachine: Schema.NullOr(Schema.String),
  fromMacApp: Schema.Boolean,
})
export type Model = typeof Model.Type

export const initialModel: Model = {
  mode: "unknown",
  machines: [],
  thisMachine: null,
  showingMachine: null,
  fromMacApp: false,
}

/** What update reads from outside: the server capabilities, once known. */
export interface Context {
  capabilities: ServerCapabilities | null
}

export const Message = defineMessageUnion({
  /** The server says it isn't a cloud machine: local, whatever else said otherwise. */
  FoundServerNotCloud: {},
  /** `/__cloud/machines` answered with JSON: the proxy is in front. */
  ReceivedCloudMachines: { machines: Machines },
  /** No proxy; the machine's own Fleet, or null when it had none to give. */
  ReceivedLocalFleet: { fleet: Schema.NullOr(opaque<CloudLocalFleetResponse>("CloudLocalFleetResponse")) },
  /** Kanna for Mac pushed its list (`window.__kannaFleet`, `kanna:fleet`); null when signed out. */
  ReceivedMacAppFleet: { fleet: Schema.NullOr(opaque<MacAppFleet>("MacAppFleet")) },
})
export type Message = typeof Message.Type

export function findCurrentMachine(
  machines: ReadonlyArray<CloudMachineSummary>,
  host: string = typeof window !== "undefined" ? window.location.host : "",
): CloudMachineSummary | null {
  const hostname = host.split(":")[0].toLowerCase()
  return machines.find((machine) => {
    try {
      return new URL(machine.appOrigin).hostname.toLowerCase() === hostname
    } catch {
      return false
    }
  }) ?? null
}

async function loadLocalFleet(fetchImpl: typeof fetch): Promise<CloudLocalFleetResponse | null> {
  try {
    const response = await fetchImpl(CLOUD_FLEET_PATH, { headers: { Accept: "application/json" } })
    if (!response.ok || !(response.headers.get("content-type") ?? "").includes("application/json")) return null
    const payload = await response.json() as CloudLocalFleetResponse
    return Array.isArray(payload.machines) ? payload : null
  } catch {
    return null
  }
}

/** The requests `load` made, as the Message they end in. Exported for tests, which pass a fetch. */
type LoadedMessage =
  | typeof Message.FoundServerNotCloud.Type
  | typeof Message.ReceivedCloudMachines.Type
  | typeof Message.ReceivedLocalFleet.Type

export function loadConnection(fetchImpl: typeof fetch = globalThis.fetch): Effect.Effect<LoadedMessage> {
  return Effect.promise(async (): Promise<LoadedMessage> => {
    const capabilities = await getServerCapabilities(fetchImpl)
    if (!capabilities.cloud) return Message.FoundServerNotCloud()
    try {
      const response = await fetchImpl(`${CLOUD_BROWSER_PATH_PREFIX}/machines`, {
        headers: { Accept: "application/json" },
      })
      if (response.ok && (response.headers.get("content-type") ?? "").includes("application/json")) {
        const payload = await response.json() as CloudMachinesResponse
        if (Array.isArray(payload.machines)) return Message.ReceivedCloudMachines({ machines: payload.machines })
      }
    } catch {
      // Unreachable → treat as local.
    }
    return Message.ReceivedLocalFleet({ fleet: await loadLocalFleet(fetchImpl) })
  })
}

/** Detect mode + load the machine list. Safe to send repeatedly. */
export const LoadConnection = Command.define("LoadConnection", {
  messages: [Message.FoundServerNotCloud, Message.ReceivedCloudMachines, Message.ReceivedLocalFleet],
  execute: Effect.suspend(() => loadConnection()),
})

const LOCAL: Model = { mode: "local", machines: [], thisMachine: null, showingMachine: null, fromMacApp: false }

export const update = (model: Model, message: Message, context: Context): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    FoundServerNotCloud: () => ({ model: LOCAL }),
    ReceivedCloudMachines: ({ machines }) => ({
      model: model.fromMacApp ? model : { ...model, mode: "cloud", machines },
    }),
    ReceivedLocalFleet: ({ fleet }) => {
      if (model.fromMacApp) return { model }
      if (fleet && fleet.self && fleet.machines.length > 0) {
        return { model: { ...model, mode: "cloud", machines: fleet.machines, thisMachine: fleet.self, showingMachine: fleet.self } }
      }
      return { model: { ...model, mode: "local", machines: [] } }
    },
    ReceivedMacAppFleet: ({ fleet }) => {
      if (context.capabilities?.cloud === false) return { model: LOCAL }
      if (fleet && Array.isArray(fleet.machines)) {
        return {
          model: {
            mode: "cloud",
            machines: fleet.machines,
            thisMachine: fleet.thisMachine ?? null,
            showingMachine: fleet.showing ?? null,
            fromMacApp: true,
          },
        }
      }
      // Signed out: back to the page's own detection (MachineSwitcher reloads
      // on "unknown").
      if (model.fromMacApp) {
        return { model: { mode: "unknown", machines: [], thisMachine: null, showingMachine: null, fromMacApp: false } }
      }
      return { model }
    },
  })

declare global {
  interface Window {
    __kannaFleet?: MacAppFleet | null
  }
}

/** What the store's module-level listener did: the list already on the page, then every push. */
export const macAppFleetStream: Stream.Stream<Message> = Stream.callback<Message>((queue) =>
  Effect.gen(function* () {
    if (typeof window === "undefined" || typeof window.addEventListener !== "function") return
    const apply = (fleet: MacAppFleet | null | undefined) => {
      if (fleet !== undefined) Queue.offerUnsafe(queue, Message.ReceivedMacAppFleet({ fleet }))
    }
    apply(window.__kannaFleet)
    const listener = (event: Event) => apply((event as CustomEvent<MacAppFleet | null>).detail)
    yield* Effect.acquireRelease(
      Effect.sync(() => window.addEventListener("kanna:fleet", listener)),
      () => Effect.sync(() => window.removeEventListener("kanna:fleet", listener)),
    )
  }),
)

export const subscriptions = Subscription.make<Model, Message>()(() => ({
  macAppFleet: Subscription.persistentEntry(macAppFleetStream),
}))
