import { afterEach, expect, test } from "bun:test"
import { mkdtemp, mkdir, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import { Effect } from "effect"
import { Machine } from "./platform/machine"
import { runTest } from "./effect/testing"
import { readRuntimePolicy } from "./runtime-policy"

const dirs: string[] = []
afterEach(async () => { await Promise.all(dirs.splice(0).map(dir => rm(dir, { recursive: true, force: true }))) })

test("reads runtime-profile config separately from cloud credentials", async () => {
  const home = await mkdtemp(join(tmpdir(), "kanna-policy-")); dirs.push(home)
  await mkdir(join(home, ".kanna-dev"))
  await writeFile(join(home, ".kanna-dev/config.json"), '{"cloud":{"enabled":false}}')
  const policy = await runTest(Effect.gen(function* () {
    const original = yield* Machine
    const machine = { ...original, homeDirectory: home, env: { ...original.env, snapshot: () => ({ KANNA_RUNTIME_PROFILE: "dev" }) } }
    return yield* readRuntimePolicy().pipe(Effect.provideService(Machine, machine))
  }))
  expect(policy.cloudEnabled).toBe(false)
})
