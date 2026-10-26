import { releaseHidden } from "./modal"

/**
 * Moves an overlay's root element to the end of <body>, where Radix's Portal
 * puts it, and removes it again on cleanup.
 *
 * End of body, not a shared portal root: Radix appends each portal as the
 * body's last child when it mounts, so the overlay follows the app in tree
 * order. That order is what the accessibility tree lists and what stacks
 * equal z-indexes, so matching it is what keeps aria and paint parity.
 * (@foldkit/ui's Anchor prepends a shared root instead, which reorders both.)
 *
 * Foldkit's patcher tolerates an element moved out of its parent (it skips it
 * as an insertion reference and removes it wherever it is), so the overlay
 * can sit anywhere in the view: conventionally the trigger's last child.
 */
export function portalToBody(element: Element): () => void {
  element.ownerDocument.body.appendChild(element)
  releaseHidden(element)
  return () => {
    try {
      element.remove()
    } catch {
      // Already gone with its vnode.
    }
  }
}
