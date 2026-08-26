import { describe, expect, test } from "bun:test"
import {
  buildSecretLoadCommand,
  coversSecretsDir,
  formatSecretEnvFile,
  isValidSecretName,
  secretFileName,
  shellSingleQuote,
} from "./secrets"

describe("isValidSecretName", () => {
  test("accepts shell-legal variable names", () => {
    expect(isValidSecretName("OPENAI_API_KEY")).toBe(true)
    expect(isValidSecretName("_private")).toBe(true)
    expect(isValidSecretName("key2")).toBe(true)
  })

  test("rejects names that could not be sourced into a shell", () => {
    expect(isValidSecretName("")).toBe(false)
    expect(isValidSecretName("2FA_TOKEN")).toBe(false)
    expect(isValidSecretName("MY-KEY")).toBe(false)
    expect(isValidSecretName("MY KEY")).toBe(false)
    expect(isValidSecretName("../escape")).toBe(false)
    expect(isValidSecretName("a".repeat(129))).toBe(false)
  })

  test("rejects path separators, so a name can never escape the secrets dir", () => {
    expect(isValidSecretName("a/b")).toBe(false)
    expect(isValidSecretName("..")).toBe(false)
    expect(secretFileName("OPENAI_API_KEY")).toBe("OPENAI_API_KEY.env")
  })
})

describe("shellSingleQuote", () => {
  test("wraps plain values", () => {
    expect(shellSingleQuote("sk-abc123")).toBe("'sk-abc123'")
  })

  test("escapes embedded single quotes with the POSIX close/escape/reopen dance", () => {
    expect(shellSingleQuote("it's")).toBe("'it'\\''s'")
  })

  test("leaves shell metacharacters inert", () => {
    expect(shellSingleQuote("$(rm -rf /)")).toBe("'$(rm -rf /)'")
    expect(shellSingleQuote("a\nb")).toBe("'a\nb'")
    expect(shellSingleQuote('back`tick`')).toBe("'back`tick`'")
  })
})

describe("formatSecretEnvFile", () => {
  test("emits a bare assignment that both sh and dotenv can read", () => {
    const file = formatSecretEnvFile("TOKEN", "abc123")
    expect(file).toContain("TOKEN='abc123'")
    expect(file.endsWith("\n")).toBe(true)
  })

  test("warns against committing or printing the file", () => {
    const file = formatSecretEnvFile("TOKEN", "abc123")
    expect(file).toContain("Do not commit")
    expect(file.split("\n")[0].startsWith("#")).toBe(true)
  })

  test("a value containing a quote survives the round trip", () => {
    const file = formatSecretEnvFile("TOKEN", "pa'ss")
    expect(file).toContain("TOKEN='pa'\\''ss'")
  })
})

describe("buildSecretLoadCommand", () => {
  test("exports the variable without printing it", () => {
    const command = buildSecretLoadCommand("/tmp/proj/.kanna/secrets/TOKEN.env")
    expect(command).toBe("set -a; . '/tmp/proj/.kanna/secrets/TOKEN.env'; set +a")
    expect(command).not.toContain("cat")
    expect(command).not.toContain("echo")
  })

  test("quotes paths containing spaces", () => {
    expect(buildSecretLoadCommand("/tmp/my proj/TOKEN.env"))
      .toBe("set -a; . '/tmp/my proj/TOKEN.env'; set +a")
  })
})

describe("coversSecretsDir", () => {
  test("recognises patterns that already ignore the secrets dir", () => {
    expect(coversSecretsDir(".kanna/secrets/")).toBe(true)
    expect(coversSecretsDir(".kanna/secrets")).toBe(true)
    expect(coversSecretsDir("/.kanna/")).toBe(true)
    expect(coversSecretsDir(".kanna")).toBe(true)
    expect(coversSecretsDir(".kanna/*")).toBe(true)
    expect(coversSecretsDir("  .kanna/secrets/  ")).toBe(true)
  })

  test("ignores comments, blanks and unrelated entries", () => {
    expect(coversSecretsDir("# .kanna/secrets/")).toBe(false)
    expect(coversSecretsDir("")).toBe(false)
    expect(coversSecretsDir("node_modules")).toBe(false)
    expect(coversSecretsDir(".kanna/uploads")).toBe(false)
  })
})
