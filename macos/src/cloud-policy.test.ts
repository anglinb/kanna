import { expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { desktopCloudEnabled, serverCloudPolicyMatches } from "./cloud-policy"

test("desktop honors the same enabled default and config/environment policy", () => {
  const root = mkdtempSync(path.join(tmpdir(), "kanna-desktop-policy-"))
  try {
    expect(desktopCloudEnabled(root, {})).toBe(true)
    writeFileSync(path.join(root, "config.json"), '{"cloud":{"enabled":false}}')
    expect(desktopCloudEnabled(root, {})).toBe(false)
    expect(desktopCloudEnabled(root, { KANNA_CLOUD_ENABLED: "true" })).toBe(true)
    writeFileSync(path.join(root, "config.json"), '{"cloud":{"enabled":true}}')
    expect(desktopCloudEnabled(root, { KANNA_CLOUD_ENABLED: "0" })).toBe(false)
    writeFileSync(path.join(root, "config.json"), "{")
    expect(desktopCloudEnabled(root, {})).toBe(false)
  } finally { rmSync(root, { recursive: true, force: true }) }
})

test("desktop refuses servers with a different cloud policy and legacy servers when disabling", async () => {
  const manifest = (cloud: boolean) => (async () => Response.json({ capabilities: { cloud } })) as typeof fetch
  expect(await serverCloudPolicyMatches("http://localhost:3210", false, manifest(false))).toBe(true)
  expect(await serverCloudPolicyMatches("http://localhost:3210", false, manifest(true))).toBe(false)
  expect(await serverCloudPolicyMatches("http://localhost:3210", true, manifest(false))).toBe(false)
  const legacy = (async () => new Response(null, { status: 404 })) as typeof fetch
  expect(await serverCloudPolicyMatches("http://localhost:3210", false, legacy)).toBe(false)
  expect(await serverCloudPolicyMatches("http://localhost:3210", true, legacy)).toBe(true)
  expect(await serverCloudPolicyMatches("http://localhost:3210", false, (async () => { throw new Error("offline") }) as typeof fetch)).toBe(false)
})
