import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import * as AppNavigation from "./navigation"

// A window with just what navigation.ts touches: a location, a history that
// keeps state, and events.
function installWindow(href: string) {
  const target = new EventTarget()
  const entries: { url: string; state: unknown }[] = [{ url: href, state: null }]
  let index = 0
  const location = { get href() { return entries[index]!.url }, origin: new URL(href).origin }
  const history = {
    get state() { return entries[index]!.state },
    pushState(state: unknown, _title: string, url: string) {
      entries.splice(index + 1, entries.length, { url: new URL(url, location.href).toString(), state })
      index += 1
    },
    replaceState(state: unknown, _title: string, url?: string) {
      entries[index] = { url: url ? new URL(url, location.href).toString() : entries[index]!.url, state }
    },
    back() {
      if (index > 0) index -= 1
    },
    forward() {
      if (index < entries.length - 1) index += 1
    },
  }
  const fake = Object.assign(target, { location, history })
  ;(globalThis as { window?: unknown }).window = fake
  return fake
}

const run = <A>(effect: Effect.Effect<A>) => Effect.runSync(effect)

afterEach(() => {
  delete (globalThis as { window?: unknown }).window
})

describe("browser history", () => {
  beforeEach(() => {
    installWindow("https://kanna.test/home")
  })

  test("stamps idx 0 on the first entry, as createBrowserHistory did", () => {
    AppNavigation.stampInitialHistoryIndex()
    expect(window.history.state).toEqual({ idx: 0 })
    expect(AppNavigation.historyIndex()).toBe(0)
  })

  test("a push counts up idx, a replace keeps it", () => {
    AppNavigation.stampInitialHistoryIndex()
    run(AppNavigation.pushUrl("/chat/a"))
    run(AppNavigation.pushUrl("/chat/b"))
    expect(AppNavigation.historyIndex()).toBe(2)
    run(AppNavigation.replaceUrl("/chat/c"))
    expect(AppNavigation.historyIndex()).toBe(2)
    expect(AppNavigation.currentPathAndSearch()).toBe("/chat/c")
  })
})

describe("memory history (the demo)", () => {
  test("moves without touching the frame's address, and announces each move", () => {
    const fake = installWindow("https://kanna.sh/demo/")
    AppNavigation.startMemoryHistory("/chat/featured")
    const heard: string[] = []
    fake.addEventListener("kanna:memoryurlchange", () => heard.push(AppNavigation.currentPathAndSearch()))

    expect(AppNavigation.currentPathAndSearch()).toBe("/chat/featured")
    run(AppNavigation.pushUrl("/settings/general#theme"))
    expect(AppNavigation.currentHash()).toBe("#theme")
    expect(AppNavigation.historyIndex()).toBe(1)
    run(AppNavigation.back())
    expect(AppNavigation.historyIndex()).toBe(0)
    run(AppNavigation.back())
    run(AppNavigation.forward())
    run(AppNavigation.replaceUrl("/home"))

    expect(heard).toEqual(["/settings/general", "/chat/featured", "/settings/general", "/home"])
    expect(fake.location.href).toBe("https://kanna.sh/demo/")
    expect(fake.history.state).toBeNull()
  })

  test("a push after going back drops the entries ahead", () => {
    installWindow("https://kanna.sh/demo/")
    AppNavigation.startMemoryHistory("/a")
    run(AppNavigation.pushUrl("/b"))
    run(AppNavigation.back())
    run(AppNavigation.pushUrl("/c"))
    run(AppNavigation.forward())
    expect(AppNavigation.currentPathAndSearch()).toBe("/c")
  })
})
