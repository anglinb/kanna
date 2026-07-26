import { describe, expect, test } from "bun:test"
import { getMacOptionInputSequence, getTerminalOptions, TERMINAL_THEMES } from "./TerminalPane"

describe("getTerminalOptions", () => {
  test("treats Option as Meta on macOS", () => {
    const options = getTerminalOptions(1_000, { foreground: "#fff" }, "MacIntel")

    expect(options.macOptionIsMeta).toBe(true)
    expect(options.scrollback).toBe(1_000)
    expect(options.lineHeight).toBe(1)
  })

  test("does not enable macOS Option behavior on non-mac platforms", () => {
    const options = getTerminalOptions(500, { foreground: "#fff" }, "Linux x86_64")

    expect(options.macOptionIsMeta).toBe(false)
    expect(options.scrollback).toBe(500)
  })

  // Reading `terminal.unicode` throws from xterm's _checkProposedApi() without
  // this, which crashes the whole pane at construction.
  test("opts into proposed API so the Unicode version can be set", () => {
    expect(getTerminalOptions(1_000, { foreground: "#fff" }, "Linux x86_64").allowProposedApi).toBe(true)
  })
})

describe("terminal themes", () => {
  // xterm's css.toColor() cannot parse the CSS keyword "transparent"; it throws
  // and the theme silently falls back to opaque black. The DOM renderer masks
  // that, the WebGL renderer paints it into the canvas.
  test("use a parseable zero-alpha background rather than the transparent keyword", () => {
    for (const theme of TERMINAL_THEMES) {
      expect(theme.background).not.toBe("transparent")
      expect(theme.background).toMatch(/^rgba\(\s*\d+\s*,\s*\d+\s*,\s*\d+\s*,\s*0(\.0+)?\s*\)$/)
    }
  })
})

describe("getMacOptionInputSequence", () => {
  test("maps plain arrow keys to standard escape sequences", () => {
    expect(getMacOptionInputSequence({
      key: "ArrowUp",
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    }, "MacIntel")).toBe("\x1b[A")

    expect(getMacOptionInputSequence({
      key: "ArrowDown",
      altKey: false,
      ctrlKey: false,
      metaKey: false,
    }, "MacIntel")).toBe("\x1b[B")
  })

  test("maps Option+Left and Option+Right to shell word motion on macOS", () => {
    expect(getMacOptionInputSequence({
      key: "ArrowLeft",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
    }, "MacIntel")).toBe("\x1bb")

    expect(getMacOptionInputSequence({
      key: "ArrowRight",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
    }, "MacIntel")).toBe("\x1bf")
  })

  test("maps Option+Backspace to backward delete word on macOS", () => {
    expect(getMacOptionInputSequence({
      key: "Backspace",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
    }, "MacIntel")).toBe("\x1b\x7f")
  })

  test("maps Command+Delete to kill backward and forward by line on macOS", () => {
    expect(getMacOptionInputSequence({
      key: "Backspace",
      altKey: false,
      ctrlKey: false,
      metaKey: true,
    }, "MacIntel")).toBe("\x15")

    expect(getMacOptionInputSequence({
      key: "Delete",
      altKey: false,
      ctrlKey: false,
      metaKey: true,
    }, "MacIntel")).toBe("\x0b")
  })

  test("ignores non-mac or modified key combinations", () => {
    expect(getMacOptionInputSequence({
      key: "ArrowLeft",
      altKey: true,
      ctrlKey: false,
      metaKey: false,
    }, "Linux x86_64")).toBeNull()

    expect(getMacOptionInputSequence({
      key: "ArrowLeft",
      altKey: true,
      ctrlKey: true,
      metaKey: false,
    }, "MacIntel")).toBeNull()
  })
})
