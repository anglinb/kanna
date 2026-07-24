import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { getMachineDisplayName, readDevboxSubdomain } from "./machine-name"

let tempDir: string | null = null

function writeIdentity(content: string) {
  tempDir = mkdtempSync(path.join(tmpdir(), "kanna-machine-name-"))
  const filePath = path.join(tempDir, "cloud.json")
  writeFileSync(filePath, content)
  return filePath
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = null
})

describe("dev-box display name", () => {
  test("a direct-mode identity names the machine after its subdomain", () => {
    const filePath = writeIdentity(
      JSON.stringify({ mode: "direct", subdomain: "jakemor-remote" }),
    )
    expect(readDevboxSubdomain(filePath)).toBe("jakemor-remote")
    expect(getMachineDisplayName(filePath)).toBe("jakemor-remote")
  })

  test("tunnel-mode identities keep the hostname-based name", () => {
    const filePath = writeIdentity(
      JSON.stringify({ mode: "tunnel", subdomain: "jakemor-mbp" }),
    )
    expect(readDevboxSubdomain(filePath)).toBeNull()
  })

  test("missing or invalid identity files fall through", () => {
    expect(readDevboxSubdomain("/nonexistent/cloud.json")).toBeNull()
    const filePath = writeIdentity("not json")
    expect(readDevboxSubdomain(filePath)).toBeNull()
    expect(getMachineDisplayName(filePath)).not.toBe("")
  })
})
