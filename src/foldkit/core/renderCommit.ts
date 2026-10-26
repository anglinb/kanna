import { Context, Effect, Option } from "effect"

/**
 * The runtime's commit signal: foldkit's internal `RenderCommit` service
 * (foldkit/dist/render/commit.js), looked up by its key, since the package
 * doesn't export it. Whether a render is scheduled and not yet patched in,
 * and a call for the next patch.
 *
 * React rendered an event's state change before the event returned; Foldkit
 * renders on the next frame. Code that read the DOM right after a press in
 * React (a timer, a frame later) waits here for the press's render instead
 * of counting frames, which a touch's late click outruns.
 */
export class RenderCommitSignal extends Context.Service<RenderCommitSignal, {
  readonly isCommitPending: () => boolean
  readonly onNextCommit: (callback: () => void) => () => void
}>()("@foldkit/RenderCommit") {}

export type RenderCommit = RenderCommitSignal["Service"]

/** The signal, where there is a runtime (none in tests). */
export const renderCommit: Effect.Effect<RenderCommit | null> = Effect.map(Effect.serviceOption(RenderCommitSignal), Option.getOrNull)

/** Runs `callback` once the render outstanding now is patched in, or at once when there is none. */
export function afterPendingRender(signal: RenderCommit | null, callback: () => void): () => void {
  if (!signal || !signal.isCommitPending()) {
    callback()
    return () => {}
  }
  return signal.onNextCommit(callback)
}
