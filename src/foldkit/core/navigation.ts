import { Effect, Queue, Stream } from "effect"
import { Navigation } from "foldkit"

// Where the app is and how it moves, in place of foldkit's Navigation for
// every push, replace, back and forward the app makes.
//
// The browser history keeps React Router's `idx` in `history.state`, as
// BrowserRouter did: "open the sidebar" and "leave a project's page" go back
// when there is a page of this app to go back to (idx > 0) and push
// otherwise. Foldkit's own pushUrl writes `{}`, which would read as idx 0
// for ever.
//
// The memory history is for the demo, which lives in an iframe on kanna.sh
// and must not move the frame's address (React's MemoryRouter). It holds
// its entries here and tells the root of each move with an event the root
// subscribes to (`memoryUrlChanges`); foldkit's own listeners read the real
// location and are never told.

const MEMORY_URL_CHANGE = "kanna:memoryurlchange"

interface MemoryHistory {
  entries: string[]
  index: number
}

let memory: MemoryHistory | null = null

/** Start the memory history at `initialPath` (before the app boots). */
export function startMemoryHistory(initialPath: string) {
  memory = { entries: [initialPath], index: 0 }
}

export function isMemoryHistory() {
  return memory !== null
}

/** The current location as an absolute href: the memory entry, or the browser's. */
export function currentHref(): string {
  if (memory) return new URL(memory.entries[memory.index]!, window.location.origin).toString()
  return window.location.href
}

/** Path and search, as `${location.pathname}${location.search}` read. */
export function currentPathAndSearch(): string {
  const url = new URL(currentHref())
  return `${url.pathname}${url.search}`
}

export function currentHash(): string {
  return new URL(currentHref()).hash
}

/** React Router's `history.state.idx`: how many of this app's pages are behind this one. */
export function historyIndex(): number {
  if (memory) return memory.index
  const state = window.history.state as { idx?: unknown } | null
  return typeof state?.idx === "number" ? state.idx : 0
}

/** As createBrowserHistory did on load: a first entry without an index gets idx 0. */
export function stampInitialHistoryIndex() {
  if (memory || typeof window === "undefined") return
  const state = window.history.state as { idx?: unknown } | null
  if (typeof state?.idx === "number") return
  window.history.replaceState({ ...(state ?? {}), idx: 0 }, "")
}

function announceMemoryMove() {
  window.dispatchEvent(new CustomEvent(MEMORY_URL_CHANGE))
}

export const pushUrl = (url: string) => Effect.suspend(() => {
  if (memory) {
    return Effect.sync(() => {
      memory!.entries = [...memory!.entries.slice(0, memory!.index + 1), url]
      memory!.index += 1
      announceMemoryMove()
    })
  }
  return Effect.sync(() => {
    window.history.pushState({ idx: historyIndex() + 1 }, "", url)
    window.dispatchEvent(new CustomEvent("foldkit:urlchange"))
  })
})

export const replaceUrl = (url: string) => Effect.suspend(() => {
  if (memory) {
    return Effect.sync(() => {
      memory!.entries[memory!.index] = url
      announceMemoryMove()
    })
  }
  return Effect.sync(() => {
    window.history.replaceState({ idx: historyIndex() }, "", url)
    window.dispatchEvent(new CustomEvent("foldkit:urlchange"))
  })
})

export const back = () => Effect.suspend(() => {
  if (!memory) return Navigation.back()
  return Effect.sync(() => {
    if (memory!.index === 0) return
    memory!.index -= 1
    announceMemoryMove()
  })
})

export const forward = () => Effect.suspend(() => {
  if (!memory) return Navigation.forward()
  return Effect.sync(() => {
    if (memory!.index >= memory!.entries.length - 1) return
    memory!.index += 1
    announceMemoryMove()
  })
})

/** Each move of the memory history, as the href moved to. Nothing in the browser history. */
export function memoryUrlChanges(): Stream.Stream<string> {
  return Stream.callback<string>((queue) => Effect.acquireRelease(
    Effect.sync(() => {
      const listener = () => {
        Queue.offerUnsafe(queue, currentHref())
      }
      window.addEventListener(MEMORY_URL_CHANGE, listener)
      return listener
    }),
    (listener) => Effect.sync(() => window.removeEventListener(MEMORY_URL_CHANGE, listener)),
  ))
}
