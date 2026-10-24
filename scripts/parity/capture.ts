import type { Page } from "playwright"
import type { Capture, PaintItem } from "./compare"

const SETTLE_QUIET_MS = 300
const SETTLE_TIMEOUT_MS = 15_000

// Computed styles compared on every painted element. Chosen for what a
// screenshot can't show or shows only as a few pixels: cursor, outline,
// weight and family, an off-by-one color.
const STYLE_PROPERTIES = [
  "color",
  "background-color",
  "background-image",
  "font-family",
  "font-size",
  "font-weight",
  "font-style",
  "line-height",
  "letter-spacing",
  "text-align",
  "text-transform",
  "text-decoration-line",
  "white-space",
  "text-overflow",
  "border-top-width",
  "border-right-width",
  "border-bottom-width",
  "border-left-width",
  "border-top-color",
  "border-right-color",
  "border-bottom-color",
  "border-left-color",
  "border-top-left-radius",
  "border-top-right-radius",
  "border-bottom-right-radius",
  "border-bottom-left-radius",
  "box-shadow",
  "opacity",
  "outline-style",
  "outline-width",
  "outline-color",
  "cursor",
  "pointer-events",
  "user-select",
  "overflow-x",
  "overflow-y",
  "z-index",
] as const

/** Installed before any page script: tracks the last DOM mutation and console errors. */
export async function instrumentPage(page: Page, errors: string[]) {
  await page.addInitScript(() => {
    const w = window as unknown as { __parityMutatedAt: number }
    w.__parityMutatedAt = performance.now()
    new MutationObserver(() => {
      w.__parityMutatedAt = performance.now()
    }).observe(document, { subtree: true, childList: true, attributes: true, characterData: true })
  })
  page.on("console", (message) => {
    if (message.type() === "error") errors.push(message.text())
  })
  page.on("pageerror", (error) => errors.push(`${error.name}: ${error.message}`))
}

/** Waits until neither the socket nor the DOM has moved for SETTLE_QUIET_MS. */
export async function settle(page: Page, errors: string[]) {
  await page.evaluate(() => document.fonts.ready.then(() => undefined))
  const deadline = Date.now() + SETTLE_TIMEOUT_MS
  for (;;) {
    const state = await page.evaluate(() => {
      const w = window as unknown as { __parity?: { quietFor(): number }; __parityMutatedAt: number }
      return { socket: w.__parity?.quietFor() ?? Infinity, dom: performance.now() - w.__parityMutatedAt }
    })
    if (state.socket >= SETTLE_QUIET_MS && state.dom >= SETTLE_QUIET_MS) break
    if (Date.now() > deadline) {
      errors.push(`page did not settle within ${SETTLE_TIMEOUT_MS}ms (socket quiet ${Math.round(state.socket)}ms, dom quiet ${Math.round(state.dom)}ms)`)
      break
    }
    await page.waitForTimeout(100)
  }
  // Two frames, so layout from the last mutation has painted.
  await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))))
}

export async function capture(page: Page, errors: string[]): Promise<{ capture: Capture; screenshot: Buffer }> {
  const screenshot = await page.screenshot({ animations: "disabled", caret: "hide" })
  const paint = await page.evaluate((properties: readonly string[]) => {
    const items: PaintItem[] = []
    const viewportWidth = window.innerWidth
    const viewportHeight = window.innerHeight
    const transparent = (value: string) => value === "transparent" || value === "rgba(0, 0, 0, 0)"
    const visit = (element: Element) => {
      const style = getComputedStyle(element)
      if (style.display === "none") return
      const rect = element.getBoundingClientRect()
      const onScreen = rect.width > 0 && rect.height > 0 && rect.right > 0 && rect.bottom > 0 && rect.left < viewportWidth && rect.top < viewportHeight
      const tag = element.tagName.toLowerCase()
      // An <svg> is one picture: compare it whole, not its paths.
      const leaf = tag === "svg" || tag === "img" || tag === "canvas" || tag === "video" || tag === "iframe"
      if (onScreen && style.visibility !== "hidden") {
        let text = ""
        for (const node of element.childNodes) {
          if (node.nodeType === Node.TEXT_NODE) text += node.textContent ?? ""
        }
        text = text.replace(/\s+/g, " ").trim()
        const bordered = ["top", "right", "bottom", "left"].some(
          (side) => style.getPropertyValue(`border-${side}-width`) !== "0px" && !transparent(style.getPropertyValue(`border-${side}-color`)),
        )
        const paints = text !== ""
          || leaf
          || !transparent(style.backgroundColor)
          || style.backgroundImage !== "none"
          || bordered
          || style.boxShadow !== "none"
          || style.outlineStyle !== "none"
          || tag === "input" || tag === "textarea" || tag === "select" || tag === "hr"
        if (paints) {
          const picked: Record<string, string> = {}
          for (const property of properties) picked[property] = style.getPropertyValue(property)
          items.push({
            tag,
            box: [Math.round(rect.x), Math.round(rect.y), Math.round(rect.width), Math.round(rect.height)],
            text: text.slice(0, 200),
            style: picked,
          })
        }
      }
      if (leaf) return
      for (const child of element.children) visit(child)
    }
    visit(document.body)
    items.sort((a, b) => a.box[1] - b.box[1] || a.box[0] - b.box[0])
    return items
  }, STYLE_PROPERTIES)
  const aria = await page.locator("body").ariaSnapshot()
  const probe = await page.evaluate(() => {
    const p = (window as unknown as { __parity?: { commands(): unknown[]; subscriptions(): unknown[]; unhandled(): unknown[] } }).__parity
    return p
      ? { commands: p.commands(), subscriptions: p.subscriptions(), unhandled: p.unhandled() }
      : { commands: [], subscriptions: [], unhandled: [] }
  })
  return {
    capture: { url: page.url(), title: await page.title(), paint, aria, ...probe, errors: [...errors] },
    screenshot,
  }
}
