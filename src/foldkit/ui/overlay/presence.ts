import { Effect } from "effect"

/**
 * Radix's Presence (@radix-ui/react-presence): content that is closing stays
 * mounted, with `data-state="closed"`, until its exit animation ends (the
 * `.floating-surface[data-state="closed"]` fade in index.css). Content with no
 * exit animation unmounts at once.
 *
 * Overlays keep a `Closing` state in their Model and run this from a Command
 * when they enter it; its completion Message moves them to `Closed`. The wait
 * starts a frame later, once the closed state is rendered, and gives up after
 * a second in case an animation never reports its end.
 */
export function waitForExitAnimation(find: () => Element | null): Effect.Effect<void> {
  return Effect.callback<void>((resume) => {
    let settled = false
    let timeout = 0
    const done = () => {
      if (settled) return
      settled = true
      window.clearTimeout(timeout)
      resume(Effect.void)
    }
    timeout = window.setTimeout(done, 1000)
    requestAnimationFrame(() => {
      const element = find()
      if (!element) return done()
      const styles = getComputedStyle(element)
      const animationName = styles.animationName || "none"
      if (animationName === "none" || styles.display === "none") return done()
      const animations = element.getAnimations().filter((animation) => animation instanceof CSSAnimation)
      if (animations.length === 0) return done()
      void Promise.allSettled(animations.map((animation) => animation.finished)).then(done)
    })
    return Effect.sync(() => window.clearTimeout(timeout))
  })
}
