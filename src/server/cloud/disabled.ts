import { Effect, Layer } from "effect"
import { CloudFeature, isCloudPath } from "./feature"

/** No filesystem, network, process, timer, or Scope requirements. */
export const CloudFeatureDisabled = Layer.succeed(CloudFeature, {
  enabled: false,
  connected: () => false,
  classify: () => "local",
  allowsWebSocket: () => false,
  handleRequest: (request) => Effect.sync(() => isCloudPath(new URL(request.url).pathname)
    ? Response.json({ error: "Cloud is disabled." }, { status: 404, headers: { "Cache-Control": "no-store" } })
    : undefined),
})
