import { Effect, Layer } from "effect"
import { CLOUD_PAIR_SESSION_PATH, CLOUD_FLEET_PATH, CLOUD_WS_ENDPOINT_PATH } from "../../shared/cloud-api"
import { capturePlatform } from "../platform"
import { FileSystem } from "effect"
import { HostProcess } from "../platform/host-process"
import { Machine } from "../platform/machine"
import { ProcessSpawner } from "../platform/process-spawner"
import { getMachineDisplayName } from "../machine-name"
import { CloudFeature, isCloudPath, type CloudFeatureOptions } from "./feature"
import { CloudFleet } from "./fleet"
import { classifyCloudRequest, isAllowedCloudWsUpgrade } from "./guard"
import { createCloudRuntime, type CloudRuntime } from "./index"
import { writeCloudIdentity } from "./identity"
import { createPairSessionManager } from "./pair-session"

type CloudPlatform = FileSystem.FileSystem | HostProcess | Machine | ProcessSpawner
export const CloudFeatureLive = (options: CloudFeatureOptions) => Layer.effect(CloudFeature, Effect.gen(function* () {
  const platform = yield* capturePlatform<CloudPlatform>()
  const fleet = yield* CloudFleet.pipe(Effect.provide(CloudFleet.layer()))
  let cloud = options.runtime ?? null
  let owned: CloudRuntime | null = null
  const classify = (request: Request) => cloud ? classifyCloudRequest(request, cloud.identity.proxySecret) : "local" as const
  const pairSession = options.allowPairing && !cloud ? yield* createPairSessionManager({
    machineName: yield* getMachineDisplayName(),
    onPaired: (identity) => Effect.gen(function* () {
      yield* writeCloudIdentity(identity)
      const runtime = createCloudRuntime(identity)
      owned = runtime
      cloud = runtime
      yield* runtime.start({ localUrl: options.localUrl() })
    }).pipe(Effect.provide(platform)),
  }) : null
  yield* Effect.addFinalizer(() => Effect.gen(function* () {
    if (pairSession) yield* pairSession.stop
    if (owned) yield* owned.stop
  }))
  const json = (body: unknown) => Response.json(body, { headers: { "Cache-Control": "no-store" } })
  const handleRequest = Effect.fn("CloudFeature.handleRequest")(function* (request: Request) {
    const url = new URL(request.url)
    if (!isCloudPath(url.pathname)) return undefined
    if (url.pathname === CLOUD_PAIR_SESSION_PATH) {
      if (classify(request) !== "local") return new Response(null, { status: 404 })
      if (request.method !== "GET" && request.method !== "POST") return new Response(null, { status: 405, headers: { Allow: "GET, POST" } })
      if (cloud) return json({ status: "paired", appOrigin: cloud.identity.appOrigin })
      if (!pairSession) return json({ status: "unsupported" })
      return json(yield* (request.method === "POST" ? pairSession.start : pairSession.status))
    }
    if (url.pathname === CLOUD_FLEET_PATH) {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } })
      return json(yield* fleet.get(cloud?.identity ?? null))
    }
    if (url.pathname === CLOUD_WS_ENDPOINT_PATH) {
      if (request.method !== "GET") return new Response(null, { status: 405, headers: { Allow: "GET" } })
      if (cloud && classify(request) === "proxied") {
        const minted = cloud.connectTokens.mint()
        return json({ wsUrl: `wss://${cloud.identity.tunnelHost}/ws`, connectToken: minted.token, expiresInMs: minted.expiresInMs })
      }
      return json({ wsUrl: null })
    }
    return new Response(null, { status: 404 })
  })
  return {
    enabled: true,
    connected: () => cloud !== null,
    classify,
    allowsWebSocket: (request: Request) => cloud !== null && isAllowedCloudWsUpgrade(request, {
      appOrigin: cloud.identity.appOrigin,
      validateToken: cloud.connectTokens.validate,
    }),
    handleRequest,
  }
}))
