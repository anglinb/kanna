/**
 * Radix's FocusScope and FocusGuards (@radix-ui/react-focus-scope,
 * @radix-ui/react-focus-guards) without React. Plain DOM functions with a
 * cleanup, for overlay Mounts to call.
 */

// FOCUS GUARDS

let guardCount = 0

function createFocusGuard(document: Document) {
  const element = document.createElement("span")
  element.setAttribute("data-radix-focus-guard", "")
  element.tabIndex = 0
  element.style.outline = "none"
  element.style.opacity = "0"
  element.style.position = "fixed"
  element.style.pointerEvents = "none"
  return element
}

/**
 * The two invisible tabbable spans Radix keeps at the very start and end of
 * <body> while any focus-managing overlay is open, so focus leaving the page
 * edge is caught by focusin. Same attribute as Radix's, so the two share
 * guards while both apps run side by side.
 */
export function installFocusGuards(document: Document): () => void {
  const edgeGuards = document.querySelectorAll("[data-radix-focus-guard]")
  document.body.insertAdjacentElement("afterbegin", edgeGuards[0] ?? createFocusGuard(document))
  document.body.insertAdjacentElement("beforeend", edgeGuards[1] ?? createFocusGuard(document))
  guardCount++
  return () => {
    if (guardCount === 1) document.querySelectorAll("[data-radix-focus-guard]").forEach((node) => node.remove())
    guardCount--
  }
}

// FOCUS SCOPE

export interface FocusScopeOptions {
  /** Keep focus inside: focus leaving is pulled back. */
  trapped: boolean
  /** Tab from the last tabbable goes to the first, and back. */
  loop: boolean
  /**
   * What happens on mount when focus isn't inside already. Default: the first
   * tabbable candidate (links excluded), or the container itself.
   * Return true to say "handled" (Radix's onMountAutoFocus preventDefault).
   */
  onMountAutoFocus?: (container: HTMLElement) => boolean
  /**
   * What happens on unmount. Default: focus goes back to what had it before
   * the scope mounted. Return true to say "handled" (preventDefault).
   */
  onUnmountAutoFocus?: (previouslyFocused: HTMLElement | null) => boolean
}

interface ScopeHandle {
  paused: boolean
}

let scopeStack: ScopeHandle[] = []

function addScope(scope: ScopeHandle) {
  const active = scopeStack[0]
  if (active && active !== scope) active.paused = true
  scopeStack = [scope, ...scopeStack.filter((candidate) => candidate !== scope)]
}

function removeScope(scope: ScopeHandle) {
  scopeStack = scopeStack.filter((candidate) => candidate !== scope)
  const next = scopeStack[0]
  if (next) next.paused = false
}

function isSelectableInput(element: unknown): element is HTMLInputElement {
  return element instanceof HTMLInputElement && "select" in element
}

export function focusElement(element: HTMLElement | null | undefined, { select = false } = {}) {
  if (element && element.focus) {
    const previouslyFocused = document.activeElement
    element.focus({ preventScroll: true })
    if (element !== previouslyFocused && isSelectableInput(element) && select) element.select()
  }
}

export function getTabbableCandidates(container: HTMLElement): HTMLElement[] {
  const nodes: HTMLElement[] = []
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_ELEMENT, {
    acceptNode: (node) => {
      const element = node as HTMLElement & { disabled?: boolean; type?: string }
      const isHiddenInput = element.tagName === "INPUT" && element.type === "hidden"
      if (element.disabled || element.hidden || isHiddenInput) return NodeFilter.FILTER_SKIP
      return element.tabIndex >= 0 ? NodeFilter.FILTER_ACCEPT : NodeFilter.FILTER_SKIP
    },
  })
  while (walker.nextNode()) nodes.push(walker.currentNode as HTMLElement)
  return nodes
}

function isHidden(node: HTMLElement, upTo: HTMLElement) {
  if (getComputedStyle(node).visibility === "hidden") return true
  let current: HTMLElement | null = node
  while (current) {
    if (current === upTo) return false
    if (getComputedStyle(current).display === "none") return true
    current = current.parentElement
  }
  return false
}

function findVisible(elements: HTMLElement[], container: HTMLElement) {
  return elements.find((element) => !isHidden(element, container))
}

/** Focuses the first candidate that takes focus. */
export function focusFirst(candidates: HTMLElement[], { select = false } = {}) {
  const previouslyFocused = document.activeElement
  for (const candidate of candidates) {
    focusElement(candidate, { select })
    if (document.activeElement !== previouslyFocused) return
  }
}

/**
 * Manages focus for `container` until the cleanup runs: auto-focus on mount,
 * trapping, looping Tab, and returning focus on unmount (a tick later, as
 * Radix does, after the DOM has settled).
 */
export function installFocusScope(container: HTMLElement, options: FocusScopeOptions): () => void {
  const scope: ScopeHandle = { paused: false }
  let lastFocused: HTMLElement | null = null
  const cleanups: Array<() => void> = []

  if (options.trapped) {
    const handleFocusIn = (event: FocusEvent) => {
      if (scope.paused) return
      const target = event.target as HTMLElement | null
      if (target && container.contains(target)) lastFocused = target
      else focusElement(lastFocused, { select: true })
    }
    const handleFocusOut = (event: FocusEvent) => {
      if (scope.paused) return
      const relatedTarget = event.relatedTarget as HTMLElement | null
      if (relatedTarget === null) return
      if (!container.contains(relatedTarget)) focusElement(lastFocused, { select: true })
    }
    const observer = new MutationObserver((mutations) => {
      if (document.activeElement !== document.body) return
      for (const mutation of mutations) {
        if (mutation.removedNodes.length > 0) focusElement(container)
      }
    })
    document.addEventListener("focusin", handleFocusIn)
    document.addEventListener("focusout", handleFocusOut)
    observer.observe(container, { childList: true, subtree: true })
    cleanups.push(() => {
      document.removeEventListener("focusin", handleFocusIn)
      document.removeEventListener("focusout", handleFocusOut)
      observer.disconnect()
    })
  }

  if (options.loop || options.trapped) {
    const handleKeyDown = (event: KeyboardEvent) => {
      if (scope.paused) return
      const isTabKey = event.key === "Tab" && !event.altKey && !event.ctrlKey && !event.metaKey
      const focused = document.activeElement
      if (!isTabKey || !focused) return
      const candidates = getTabbableCandidates(container)
      const first = findVisible(candidates, container)
      const last = findVisible([...candidates].reverse(), container)
      if (!first || !last) {
        if (focused === container) event.preventDefault()
      } else if (!event.shiftKey && focused === last) {
        event.preventDefault()
        if (options.loop) focusElement(first, { select: true })
      } else if (event.shiftKey && focused === first) {
        event.preventDefault()
        if (options.loop) focusElement(last, { select: true })
      }
    }
    container.addEventListener("keydown", handleKeyDown)
    cleanups.push(() => container.removeEventListener("keydown", handleKeyDown))
  }

  addScope(scope)
  const previouslyFocused = document.activeElement as HTMLElement | null
  if (!container.contains(previouslyFocused)) {
    const handled = options.onMountAutoFocus?.(container) ?? false
    if (!handled) {
      focusFirst(getTabbableCandidates(container).filter((item) => item.tagName !== "A"), { select: true })
      if (document.activeElement === previouslyFocused) focusElement(container)
    }
  }

  return () => {
    cleanups.forEach((cleanup) => cleanup())
    setTimeout(() => {
      const handled = options.onUnmountAutoFocus?.(previouslyFocused) ?? false
      if (!handled) focusElement(previouslyFocused ?? document.body, { select: true })
      removeScope(scope)
    }, 0)
  }
}
