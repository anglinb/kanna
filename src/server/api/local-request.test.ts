import { describe, expect, test } from "bun:test"
import { isDirectLocalRequest, isLoopbackAddress } from "./local-request"

const request = (headers: Record<string, string> = {}) =>
  new Request("http://127.0.0.1:3210/api/v1/projects", { headers })

describe("isLoopbackAddress", () => {
  test("accepts the loopback forms Bun reports", () => {
    expect(isLoopbackAddress("127.0.0.1")).toBe(true)
    expect(isLoopbackAddress("127.0.0.53")).toBe(true)
    expect(isLoopbackAddress("::1")).toBe(true)
    // Bun reports an IPv4 peer on a dual-stack socket in mapped form.
    expect(isLoopbackAddress("::ffff:127.0.0.1")).toBe(true)
  })

  test("rejects everything else, including a missing address", () => {
    expect(isLoopbackAddress("192.168.1.20")).toBe(false)
    expect(isLoopbackAddress("10.0.0.5")).toBe(false)
    expect(isLoopbackAddress("::ffff:192.168.1.20")).toBe(false)
    expect(isLoopbackAddress(null)).toBe(false)
    expect(isLoopbackAddress(undefined)).toBe(false)
  })
})

describe("isDirectLocalRequest", () => {
  test("a plain loopback request qualifies", () => {
    expect(isDirectLocalRequest(request(), "127.0.0.1")).toBe(true)
  })

  test("a LAN peer does not — this is the --remote case", () => {
    expect(isDirectLocalRequest(request(), "192.168.1.20")).toBe(false)
  })

  test("a relayed request does not, even from loopback", () => {
    // cloudflared (`--share`) runs on this machine, so the peer address alone
    // would let the whole public tunnel through.
    expect(isDirectLocalRequest(request({ "x-forwarded-for": "203.0.113.7" }), "127.0.0.1")).toBe(false)
    expect(isDirectLocalRequest(request({ "cf-connecting-ip": "203.0.113.7" }), "127.0.0.1")).toBe(false)
    expect(isDirectLocalRequest(request({ "cf-ray": "abc123" }), "127.0.0.1")).toBe(false)
    expect(isDirectLocalRequest(request({ forwarded: "for=203.0.113.7" }), "127.0.0.1")).toBe(false)
    expect(isDirectLocalRequest(request({ "x-real-ip": "203.0.113.7" }), "127.0.0.1")).toBe(false)
    expect(isDirectLocalRequest(request({ "x-forwarded-proto": "https" }), "127.0.0.1")).toBe(false)
  })

  test("header matching ignores case", () => {
    expect(isDirectLocalRequest(request({ "X-Forwarded-For": "203.0.113.7" }), "127.0.0.1")).toBe(false)
  })

  test("an unrelated header is harmless", () => {
    expect(isDirectLocalRequest(request({ "user-agent": "kanna-mcp" }), "127.0.0.1")).toBe(true)
  })
})
