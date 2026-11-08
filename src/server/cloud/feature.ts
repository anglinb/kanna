import { Context, type Effect, Schema } from "effect"
import type { CloudRuntime } from "./index"

/** The only cloud capabilities the HTTP server needs. Implementations own their lifetimes. */
export class CloudFeature extends Context.Service<CloudFeature, {
  readonly enabled: boolean
  readonly connected: () => boolean
  readonly classify: (request: Request) => "local" | "proxied" | "untrusted"
  readonly allowsWebSocket: (request: Request) => boolean
  readonly handleRequest: (request: Request) => Effect.Effect<Response | undefined>
}>()("@kanna/server/CloudFeature") {}

export interface CloudFeatureOptions {
  runtime?: CloudRuntime | null
  allowPairing?: boolean
  /** Read when pairing completes, after the server knows its actual port. */
  localUrl: () => string
}

export const isCloudPath = (path: string) => path === "/api/cloud" || path.startsWith("/api/cloud/")
  || path === "/__cloud" || path.startsWith("/__cloud/")

export class CloudDisabledError extends Schema.TaggedError<CloudDisabledError>()(
  "@kanna/server/CloudDisabledError", {},
) { override get message() { return "Cloud is disabled. Restart Kanna with cloud enabled to use this feature." } }
