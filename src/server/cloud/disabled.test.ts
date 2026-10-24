import { expect, test } from "bun:test"
import { Effect } from "effect"
import { CloudFeature } from "./feature"
import { CloudFeatureDisabled } from "./disabled"
import { PortTunnels, PortTunnelsDisabled } from "../port-tunnels"

test("disabled cloud runs without any platform services and grants no cloud authority", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const cloud = yield* CloudFeature
    expect(cloud.enabled).toBe(false)
    expect(cloud.connected()).toBe(false)
    const request = new Request("http://localhost/api/cloud/pair-session", { method: "POST", headers: { "x-kanna-proxy-auth": "secret" } })
    expect(cloud.classify(request)).toBe("local")
    expect(cloud.allowsWebSocket(request)).toBe(false)
    expect((yield* cloud.handleRequest(request))?.status).toBe(404)
    expect(yield* cloud.handleRequest(new Request("http://localhost/api/projects"))).toBeUndefined()
  }).pipe(Effect.provide(CloudFeatureDisabled)))
})

test("disabled public exposure never needs a filesystem or a process spawner", async () => {
  await Effect.runPromise(Effect.gen(function* () {
    const ports = yield* PortTunnels
    expect(yield* ports.list).toEqual([])
    expect(yield* ports.publicUrl(3000)).toBeUndefined()
    const result = yield* Effect.result(ports.expose(3000))
    expect(result._tag).toBe("Failure")
    if (result._tag === "Failure") expect(result.failure._tag).toBe("@kanna/server/CloudDisabledError")
  }).pipe(Effect.provide(PortTunnelsDisabled)))
})
