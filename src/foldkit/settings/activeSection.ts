import { Effect, Schema } from "effect"
import { Mount } from "foldkit"

// A React section ran its effects while it was mounted: Providers read the
// LLM provider, Skills listed what's installed, Usage subscribed to its topic
// and polled. Here a section's content element carries this Mount, which
// reports `MountedSection` when it arrives (the section's mount work, and the
// page's `activeSection` that Subscriptions key on), and `h.OnUnmount`
// reports it leaving.

/**
 * useSettingsRowHashScroll: scrolls the row matching `#rowId` into view and
 * briefly highlights it (the command palette's "jump to setting" entries).
 * Runs when the section's content arrives, retrying for a few frames while
 * the row renders.
 */
function scrollToHashRow(): () => void {
  const hash = window.location.hash
  const rowId = hash.startsWith("#") ? hash.slice(1) : hash
  if (!rowId) return () => {}

  let cancelled = false
  let attempts = 0
  let timeoutId: number | null = null

  function tryScroll() {
    if (cancelled) return
    const element = document.getElementById(rowId)
    if (!element) {
      attempts += 1
      if (attempts < 20) {
        requestAnimationFrame(tryScroll)
      }
      return
    }

    element.scrollIntoView({ block: "center" })
    element.classList.add("bg-muted", "transition-colors", "duration-700")
    timeoutId = window.setTimeout(() => {
      element.classList.remove("bg-muted")
    }, 900)
  }

  requestAnimationFrame(tryScroll)

  return () => {
    cancelled = true
    if (timeoutId !== null) window.clearTimeout(timeoutId)
  }
}

/**
 * The Mount a section's content element carries. Each section defines its own
 * (a Mount names the Message it produces).
 */
export function makeSectionMount<Name extends string, M>(name: Name, message: Schema.Schema<M>, mounted: () => M) {
  return Mount.define(name, {
    messages: [message],
    execute: () => Effect.gen(function* () {
      yield* Effect.acquireRelease(Effect.sync(scrollToHashRow), (stop) => Effect.sync(stop))
      return mounted()
    }),
  })
}
