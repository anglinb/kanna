import { describe, expect, test } from "bun:test"
import { resolveCloudEnabled } from "./server-capabilities"

describe("cloud startup policy", () => {
  test("defaults to enabled and distinguishes a disabled feature from credentials", () => {
    expect(resolveCloudEnabled()).toBe(true)
    expect(resolveCloudEnabled("{}")).toBe(true)
    expect(resolveCloudEnabled('{"cloud":{"enabled":false}}')).toBe(false)
    expect(resolveCloudEnabled('{"cloud":{"enabled":true}}')).toBe(true)
  })
  test("CLI wins over environment, which wins over configuration", () => {
    expect(resolveCloudEnabled('{"cloud":{"enabled":true}}', "false")).toBe(false)
    expect(resolveCloudEnabled('{"cloud":{"enabled":false}}', "true")).toBe(true)
    expect(resolveCloudEnabled("not json", "invalid", false)).toBe(false)
    expect(resolveCloudEnabled("not json", "0", true)).toBe(true)
    expect(resolveCloudEnabled(undefined, "0")).toBe(false)
    expect(resolveCloudEnabled(undefined, "1")).toBe(true)
  })
  test("rejects invalid policy instead of accidentally enabling cloud", () => {
    expect(() => resolveCloudEnabled('{"cloud":{"enabled":"false"}}')).toThrow("boolean")
    expect(() => resolveCloudEnabled(undefined, "yes")).toThrow("KANNA_CLOUD_ENABLED")
    expect(() => resolveCloudEnabled("false")).toThrow("object")
    expect(() => resolveCloudEnabled("{")).toThrow()
  })
})
