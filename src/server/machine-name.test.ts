import { afterEach, describe, expect, test } from "bun:test"
import { mkdtempSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import { getMachineDisplayName, readDevboxSubdomain, readMachineNameOverride } from "./machine-name"

let tempDir: string | null = null
const MISSING = "/nonexistent/never-here"

function tempFile(name: string, content: string) {
  tempDir ??= mkdtempSync(path.join(tmpdir(), "kanna-machine-name-"))
  const filePath = path.join(tempDir, name)
  writeFileSync(filePath, content)
  return filePath
}

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = null
})

describe("machine-name override file", () => {
  test("first non-empty line wins over everything", () => {
    const identity = tempFile("cloud.json", JSON.stringify({ mode: "direct", subdomain: "jakemor-remote" }))
    const override = tempFile("machine-name", "preview: main\nsecond line ignored\n")
    expect(readMachineNameOverride(override)).toBe("preview: main")
    expect(getMachineDisplayName(identity, override)).toBe("preview: main")
  })

  test("missing or blank override files fall through", () => {
    expect(readMachineNameOverride(MISSING)).toBeNull()
    expect(readMachineNameOverride(tempFile("machine-name", "\n \n"))).toBeNull()
  })
})

describe("dev-box display name", () => {
  test("a direct-mode identity names the machine after its subdomain", () => {
    const filePath = tempFile("cloud.json", JSON.stringify({ mode: "direct", subdomain: "jakemor-remote" }))
    expect(readDevboxSubdomain(filePath)).toBe("jakemor-remote")
    expect(getMachineDisplayName(filePath, MISSING)).toBe("jakemor-remote")
  })

  test("tunnel-mode identities keep the hostname-based name", () => {
    const filePath = tempFile("cloud.json", JSON.stringify({ mode: "tunnel", subdomain: "jakemor-mbp" }))
    expect(readDevboxSubdomain(filePath)).toBeNull()
  })

  test("missing or invalid identity files fall through", () => {
    expect(readDevboxSubdomain("/nonexistent/cloud.json")).toBeNull()
    const filePath = tempFile("cloud.json", "not json")
    expect(readDevboxSubdomain(filePath)).toBeNull()
    expect(getMachineDisplayName(filePath, MISSING)).not.toBe("")
  })
})
