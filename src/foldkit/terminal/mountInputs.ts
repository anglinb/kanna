import { Schema } from "effect"
import { CustomElement } from "foldkit"
import type { Attribute, HtmlBuilder } from "foldkit/html"

// A Mount's args are read once, when its element enters the DOM. The React
// components these Mounts replace re-ran effects when a prop changed (a
// pane's theme, a panel's minimum width, a separator turning disabled)
// without remounting the element. So the view also writes those inputs onto
// the element as a DOM property, through Foldkit's declarative property
// channel (CustomElement's property factories, which work on any element),
// and the Mount watches that property for changes.
//
// The value is JSON, so an unchanged render writes nothing and the Mount
// only hears of real changes.

const binding = CustomElement.define({
  tag: "kanna-mount-inputs",
  properties: { kannaMountInputs: Schema.String },
  events: {},
})

const PROPERTY = "kannaMountInputs"

/** The attribute that hands `inputs` to the element's Mount. */
export function mountInputs<Message>(inputs: unknown, h: HtmlBuilder<Message>): Attribute<Message> {
  return binding.withMessage(h).KannaMountInputs(JSON.stringify(inputs))
}

export interface WatchedInputs<T> {
  /** The latest inputs the view wrote. */
  readonly current: () => T
  /** Puts the plain property back. */
  readonly stop: () => void
}

/**
 * Reads the inputs the view wrote on `element` and calls `onChange` with
 * each later change. `onChange` runs after the patch that wrote them has
 * finished (a microtask later), as React's effects ran after its commit,
 * so it sees the whole new DOM rather than the element half-patched.
 */
export function watchMountInputs<T>(element: Element, onChange: (next: T, previous: T) => void): WatchedInputs<T> {
  const target = element as unknown as Record<string, unknown>
  let raw = typeof target[PROPERTY] === "string" ? (target[PROPERTY] as string) : "null"
  let current = JSON.parse(raw) as T
  let reported = current
  let scheduled = false
  let stopped = false
  Object.defineProperty(element, PROPERTY, {
    configurable: true,
    enumerable: true,
    get: () => raw,
    set: (next: unknown) => {
      if (typeof next !== "string" || next === raw) return
      raw = next
      current = JSON.parse(next) as T
      if (scheduled) return
      scheduled = true
      queueMicrotask(() => {
        scheduled = false
        if (stopped) return
        const previous = reported
        reported = current
        onChange(current, previous)
      })
    },
  })
  return {
    current: () => current,
    stop: () => {
      stopped = true
      Object.defineProperty(element, PROPERTY, { configurable: true, enumerable: true, writable: true, value: raw })
    },
  }
}
