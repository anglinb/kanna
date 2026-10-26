import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { fetchServerCapabilities } from "../../../client/lib/server-capabilities"
import type { ServerCapabilities } from "../../../shared/server-capabilities"

// Port of src/client/stores/serverCapabilitiesStore.ts. The store held the
// answer to one bootstrap request; here the Model holds it and
// `FetchServerCapabilities` asks for it. The request itself stays a
// module-level promise (`getServerCapabilities`), as in React: the socket's
// URL resolution (core/socket.ts) asks too, outside any update, and the two
// must share one request rather than make two.

const ServerCapabilitiesSchema = Schema.Struct({ cloud: Schema.Boolean, publicSharing: Schema.Boolean })

export const Model = Schema.Struct({
  /** Null until the bootstrap request has answered. */
  value: Schema.NullOr(ServerCapabilitiesSchema),
})
export type Model = typeof Model.Type

export const initialModel: Model = { value: null }

let pending: Promise<ServerCapabilities> | null = null

/** One neutral bootstrap request precedes cloud discovery, pairing, and WS URL resolution. */
export function getServerCapabilities(fetchImpl?: typeof fetch): Promise<ServerCapabilities> {
  // Injected transports are independent (tests and embedders); don't share their answers.
  if (fetchImpl && fetchImpl !== globalThis.fetch) return fetchServerCapabilities(fetchImpl)
  pending ??= fetchServerCapabilities()
  return pending
}

export const Message = defineMessageUnion({
  ReceivedServerCapabilities: { value: ServerCapabilitiesSchema },
})
export type Message = typeof Message.Type

/**
 * What `useServerCapabilities` did on mount: ask, once per page. The app's
 * init sends it; every later send resolves from the same request.
 * (`fetchServerCapabilities` never rejects: failures answer "disabled".)
 */
export const FetchServerCapabilities = Command.define("FetchServerCapabilities", {
  messages: [Message.ReceivedServerCapabilities],
  execute: Effect.promise(() => getServerCapabilities()).pipe(
    Effect.map((value) => Message.ReceivedServerCapabilities({ value })),
  ),
})

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    ReceivedServerCapabilities: ({ value }) => ({ model: { value } }),
  })

/** `useServerCapabilities`: null until known. */
export function serverCapabilities(model: Model): ServerCapabilities | null {
  return model.value
}
