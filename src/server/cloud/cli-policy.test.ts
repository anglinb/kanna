import { expect, test } from "bun:test"
import { Effect } from "effect"
import { runCli, type CliRuntimeDeps, type CliServerOptions } from "../cli-runtime"
import { runTest } from "../effect/testing"

function setup(cloudEnabled = false) {
  const starts: CliServerOptions[] = []
  const warnings: string[] = []
  const forbidden = () => { throw new Error("disabled CLI touched a cloud dependency") }
  const deps: CliRuntimeDeps = {
    version: "0.3.0", bunVersion: "1.3.11",
    readRuntimePolicyImpl: (override) => Effect.succeed({ cloudEnabled: override ?? cloudEnabled }),
    startServer: (options) => Effect.sync(() => { starts.push(options); return { port: options.port, stop: Effect.void } }),
    fetchLatestVersion: () => Effect.succeed("0.3.0"),
    installVersion: forbidden, openUrl: forbidden,
    log: () => {}, warn: message => { warnings.push(message) },
    readCloudIdentityImpl: forbidden, createCloudRuntimeImpl: forbidden, runPairCommandImpl: forbidden, startShareTunnel: forbidden,
    claimInstanceImpl: Effect.succeed({ kind: "ours", attach: () => Effect.void, releasedFromParent: () => false }),
    probeExistingInstanceImpl: () => Effect.succeed(null),
    instanceStatusImpl: Effect.succeed(null),
  }
  return { deps, starts, warnings }
}

test("--no-cloud bypasses identity, pairing, connectors and cloud activation", async () => {
  const { deps, starts } = setup(true)
  const result = await runTest(runCli(["--no-cloud", "--no-open"], deps))
  expect(result.kind).toBe("started")
  expect(starts).toHaveLength(1)
  expect(starts[0]?.cloudEnabled).toBe(false)
  expect(starts[0]?.allowCloudPairing).toBe(false)
  expect(starts[0]?.trustProxy).toBe(false)
})

test("disabled policy applies before pair and public-share entry points", async () => {
  for (const argv of [["pair"], ["pair", "--enable"], ["--share", "--no-open"], ["--cloudflared", "token", "--no-open"]]) {
    const { deps, starts, warnings } = setup()
    const result = await runTest(runCli(argv, deps))
    expect(result).toEqual({ kind: "exited", code: 1 })
    expect(starts).toHaveLength(0)
    expect(warnings.join(" ")).toContain("cloud is disabled")
  }
})

test("a cloud-capable running process cannot be reused for a disabled launch", async () => {
  const { deps, starts, warnings } = setup()
  deps.probeExistingInstanceImpl = () => Effect.succeed({ localUrl: "http://localhost:3210", port: 3210, cloudEnabled: true })
  const result = await runTest(runCli(["--no-open"], deps))
  expect(result).toEqual({ kind: "exited", code: 1 })
  expect(starts).toHaveLength(0)
  expect(warnings.join(" ")).toContain("kanna stop")
})

test("an existing disabled process can be reused without touching cloud state", async () => {
  const { deps, starts } = setup()
  deps.probeExistingInstanceImpl = () => Effect.succeed({ localUrl: "http://localhost:3210", port: 3210, cloudEnabled: false })
  expect(await runTest(runCli(["--no-open"], deps))).toEqual({ kind: "exited", code: 0 })
  expect(starts).toHaveLength(0)
})
