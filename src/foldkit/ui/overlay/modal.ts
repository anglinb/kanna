/**
 * What a modal Radix overlay does to the rest of the page, without React:
 * `hideOthers` (the aria-hidden package Radix uses) and the scroll lock of
 * react-remove-scroll. Plain DOM functions with a cleanup, for overlay Mounts.
 */

// HIDE OTHERS

const hiddenCount = new WeakMap<Element, number>()
const markerCount = new WeakMap<Element, number>()
const uncontrolled = new WeakSet<Element>()

/**
 * Marks everything outside `target` (and anything aria-live, and scripts)
 * aria-hidden, so the accessibility tree holds only the modal, as the
 * aria-hidden package does for Radix. Counted, so stacked modals undo in any
 * order. Returns the undo.
 */
export function hideOthers(target: Element): () => void {
  const document = target.ownerDocument
  const parent = document.body
  const targets = [target, ...Array.from(parent.querySelectorAll("[aria-live], script"))].filter((element) => parent.contains(element))
  const keep = new Set<Node>()
  const stop = new Set<Node>(targets)
  const markKeep = (node: Node | null) => {
    if (!node || keep.has(node)) return
    keep.add(node)
    markKeep(node.parentNode)
  }
  targets.forEach(markKeep)

  const hidden: Element[] = []
  const walk = (node: Element) => {
    if (stop.has(node)) return
    for (const child of Array.from(node.children)) {
      if (keep.has(child)) {
        walk(child)
        continue
      }
      const attribute = child.getAttribute("aria-hidden")
      const alreadyHidden = attribute !== null && attribute !== "false"
      const count = (hiddenCount.get(child) ?? 0) + 1
      const marker = (markerCount.get(child) ?? 0) + 1
      hiddenCount.set(child, count)
      markerCount.set(child, marker)
      hidden.push(child)
      if (count === 1 && alreadyHidden) uncontrolled.add(child)
      if (marker === 1) child.setAttribute("data-aria-hidden", "true")
      if (!alreadyHidden) child.setAttribute("aria-hidden", "true")
    }
  }
  walk(parent)

  return () => {
    for (const node of hidden) {
      // Released on its way to <body> (`releaseHidden`): nothing left to undo.
      if (!hiddenCount.has(node)) continue
      const count = (hiddenCount.get(node) ?? 1) - 1
      const marker = (markerCount.get(node) ?? 1) - 1
      hiddenCount.set(node, count)
      markerCount.set(node, marker)
      if (!count) {
        if (!uncontrolled.has(node)) node.removeAttribute("aria-hidden")
        uncontrolled.delete(node)
      }
      if (!marker) node.removeAttribute("data-aria-hidden")
    }
  }
}

/**
 * An overlay moving out of the app for <body> takes off the marks a modal
 * gave it while it was still inside. A Radix portal is the body's own from
 * its first frame, so a modal that hid the page before it arrived never
 * reached it (a chat card coming up beside the context menu that opened in
 * the same frame stays in the accessibility tree).
 */
export function releaseHidden(element: Element) {
  if (!hiddenCount.get(element)) return
  hiddenCount.delete(element)
  markerCount.delete(element)
  if (!uncontrolled.has(element)) element.removeAttribute("aria-hidden")
  uncontrolled.delete(element)
  element.removeAttribute("data-aria-hidden")
}

// SCROLL LOCK

const LOCK_ATTRIBUTE = "data-scroll-locked"
let lockStyle: HTMLStyleElement | null = null

function gapWidth(document: Document) {
  const window = document.defaultView!
  const style = window.getComputedStyle(document.body)
  const read = (value: string) => parseInt(value || "", 10) || 0
  const left = read(style.marginLeft)
  const top = read(style.marginTop)
  const right = read(style.marginRight)
  const documentWidth = document.documentElement.clientWidth
  const windowWidth = window.innerWidth
  return { left, top, right, gap: Math.max(0, windowWidth - documentWidth + right - left) }
}

// react-remove-scroll-bar's styles, gapMode "margin", !important, with
// `position: relative` (Radix doesn't pass noRelative).
function lockStyles({ left, top, right, gap }: ReturnType<typeof gapWidth>) {
  return `
  .with-scroll-bars-hidden {
   overflow: hidden !important;
   padding-right: ${gap}px !important;
  }
  body[${LOCK_ATTRIBUTE}] {
    overflow: hidden !important;
    overscroll-behavior: contain;
    position: relative !important;
    padding-left: ${left}px;
    padding-top: ${top}px;
    padding-right: ${right}px;
    margin-left:0;
    margin-top:0;
    margin-right: ${gap}px !important;
    }
  .right-scroll-bar-position {
    right: ${gap}px !important;
  }
  .width-before-scroll-bar {
    margin-right: ${gap}px !important;
  }
  .right-scroll-bar-position .right-scroll-bar-position {
    right: 0 !important;
  }
  .width-before-scroll-bar .width-before-scroll-bar {
    margin-right: 0 !important;
  }
  body[${LOCK_ATTRIBUTE}] {
    --removed-body-scroll-bar-size: ${gap}px;
  }
`
}

/**
 * Locks page scroll the way Radix's RemoveScroll does: the same stylesheet on
 * <body>, a counted `data-scroll-locked` attribute, and wheel and touch
 * scrolling blocked except inside `shards` (the overlay content). Returns the
 * unlock.
 */
export function lockScroll(document: Document, shards: ReadonlyArray<Element>): () => void {
  const body = document.body
  const counter = parseInt(body.getAttribute(LOCK_ATTRIBUTE) || "0", 10) || 0
  if (counter === 0 || !lockStyle) {
    // Measured once per lock, used by the first: react-style-singleton keeps
    // the first stylesheet while any lock holds.
    if (!lockStyle) {
      lockStyle = document.createElement("style")
      lockStyle.textContent = lockStyles(gapWidth(document))
      document.head.appendChild(lockStyle)
    }
  }
  body.setAttribute(LOCK_ATTRIBUTE, String(counter + 1))

  const isInShard = (target: EventTarget | null) => target instanceof Node && shards.some((shard) => shard.contains(target))
  const blockScroll = (event: Event) => {
    if (!isInShard(event.target)) event.preventDefault()
  }
  document.addEventListener("wheel", blockScroll, { passive: false })
  document.addEventListener("touchmove", blockScroll, { passive: false })

  return () => {
    document.removeEventListener("wheel", blockScroll)
    document.removeEventListener("touchmove", blockScroll)
    const next = (parseInt(body.getAttribute(LOCK_ATTRIBUTE) || "0", 10) || 0) - 1
    if (next <= 0) {
      body.removeAttribute(LOCK_ATTRIBUTE)
      lockStyle?.remove()
      lockStyle = null
    } else {
      body.setAttribute(LOCK_ATTRIBUTE, String(next))
    }
  }
}
