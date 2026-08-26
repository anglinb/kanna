import { describe, expect, test } from "bun:test"
import { buildAskSecretInstructions, resolveCliFallbackPath } from "./secret-instructions"

const instructions = buildAskSecretInstructions("/opt/kanna/bin/kanna")

describe("buildAskSecretInstructions", () => {
  test("names the exact command an agent should run", () => {
    expect(instructions).toContain('kanna ask-secret <NAME> --reason "<why you need it>"')
  })

  test("forbids the two ways an agent would otherwise leak the value", () => {
    expect(instructions).toContain("never ask for it")
    expect(instructions).toContain("Never cat, read, echo, grep or print")
  })

  test("explains the timeout is not a failure", () => {
    expect(instructions).toContain("resumes the same wait")
  })

  test("documents the declined exit code so an agent stops retrying", () => {
    expect(instructions).toContain("Exit code 3")
  })

  test("offers the absolute path for agents without kanna on PATH", () => {
    expect(instructions).toContain("/opt/kanna/bin/kanna")
  })

  test("stays small enough to ride on every turn", () => {
    // Rough token estimate, matching the bound attribution.test.ts applies.
    expect(instructions.length / 3).toBeLessThan(400)
  })
})

describe("resolveCliFallbackPath", () => {
  test("points at the packaged bin", () => {
    expect(resolveCliFallbackPath()).toEndWith("/bin/kanna")
  })
})
