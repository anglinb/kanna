import type { Plugin } from "vite"

/**
 * Build-time patch for `@shadcn/react`'s message-scroller primitive.
 *
 * Its content-height measure (`pe`) called `getBoundingClientRect` on every
 * row, on every scroll event and every content resize. A streaming turn
 * resizes the content on every push, so that sweep was a forced layout of the
 * whole transcript per push (8-12 ms per push in a profile). The content box
 * already ends where its last child plus padding-end does, so one rect gives
 * the same number.
 *
 * Done here rather than through `bun patch`: a `patchedDependencies` entry in
 * package.json must find its patch file at install time, and anything that
 * installs against this package.json without the repo checkout (the nightly
 * reinstall did) fails outright. A Vite transform needs nothing outside the
 * repo. The build fails loudly if the primitive changes under it, which is the
 * cue to re-check the patch on a version bump.
 */
const ORIGINAL =
  "function pe({content:e,spacer:t,viewport:r}){let n=re(e,t),o=$e(e),l=r.getBoundingClientRect(),a=r.scrollTop,s=o.start+o.end;for(let p of n){let E=p.getBoundingClientRect();s=Math.max(s,E.bottom-l.top+a+o.end);}return s}"
const PATCHED =
  "function pe({content:e,spacer:t,viewport:r}){let o=$e(e),l=r.getBoundingClientRect(),a=r.scrollTop,s=o.start+o.end;let E=e.getBoundingClientRect();return Math.max(s,E.bottom-l.top+a)}"

export function messageScrollerPatch(): Plugin {
  return {
    name: "kanna:message-scroller-patch",
    enforce: "pre",
    transform(code, id) {
      if (!id.includes("@shadcn/react/dist/message-scroller/")) return null
      if (!code.includes(ORIGINAL)) {
        throw new Error(
          "kanna:message-scroller-patch: the message-scroller primitive changed; re-check vite-plugin-message-scroller.ts",
        )
      }
      return { code: code.replace(ORIGINAL, PATCHED), map: null }
    },
  }
}
