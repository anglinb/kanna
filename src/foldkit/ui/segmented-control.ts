import { Schema } from "effect"
import { CustomElement } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import type { Child } from "./attributes"
import type { Icon } from "./icon"

type SegmentedSize = "sm" | "md"

export interface SegmentedOption<T extends string> {
  value: T
  label: ReadonlyArray<Child>
  icon?: Icon
  disabled?: boolean
}

export interface SegmentedControlOptions<T extends string, Message> {
  value: T
  onValueChange: (value: T) => Message
  options: ReadonlyArray<SegmentedOption<T>>
  size?: SegmentedSize
  class?: string
  optionClass?: string
}

const sizeClasses: Record<SegmentedSize, string> = {
  sm: "text-sm px-2.5 py-1",
  md: "text-sm px-3 py-1.5",
}

/**
 * The sliding highlight behind the active segment. React measured the active
 * button in a layout effect and rendered the span at that left and width;
 * here the span is a custom element that measures itself the same way, so
 * the control stays a plain view helper with no Model of its own.
 *
 * It measures when it is inserted and again when the value, the options or
 * the size change (its properties), exactly the cases React's effect
 * re-ran for: not on resize, which React ignored too. The first placement
 * doesn't animate, so the indicator only slides when it moves between
 * segments, not when it appears.
 */
const INDICATOR_TAG = "kanna-segmented-indicator"

// Registered where there is a DOM: tests (Story, Scene) import this module
// under Bun, where HTMLElement doesn't exist.
function defineIndicatorElement() {
  if (typeof customElements === "undefined" || customElements.get(INDICATOR_TAG)) return
  class SegmentedIndicator extends HTMLElement {
    private placed = false
    private current = { value: "", optionsKey: "", size: "" }

    // Set by Foldkit as properties (see `Indicator` below), before and after
    // the element is connected.
    set value(value: string) {
      this.update({ ...this.current, value })
    }
    set optionsKey(optionsKey: string) {
      this.update({ ...this.current, optionsKey })
    }
    set size(size: string) {
      this.update({ ...this.current, size })
    }

    connectedCallback() {
      this.place()
    }

    private update(next: typeof this.current) {
      const changed = next.value !== this.current.value || next.optionsKey !== this.current.optionsKey || next.size !== this.current.size
      this.current = next
      if (changed && this.isConnected) this.place()
    }

    private place() {
      const container = this.parentElement
      const active = container
        ? Array.from(container.children).find((child): child is HTMLElement =>
          child instanceof HTMLElement && child.tagName === "BUTTON" && child.dataset.segmentValue === this.current.value)
        : undefined
      if (!container || !active) return
      const containerRect = container.getBoundingClientRect()
      const rect = active.getBoundingClientRect()
      if (!this.placed) this.style.transition = "none"
      // `left` on the absolute indicator resolves against the container's padding
      // box, but these rects are border-box — subtract the left border width so
      // the indicator doesn't sit one border-width to the right at every position.
      this.style.left = `${rect.left - containerRect.left - container.clientLeft}px`
      this.style.width = `${rect.width}px`
      if (!this.placed) {
        // Commit the first position without a transition, then hand the
        // transition back for the moves that follow.
        void this.offsetWidth
        this.style.removeProperty("transition")
        this.placed = true
      }
    }
  }

  customElements.define(INDICATOR_TAG, SegmentedIndicator)
}
defineIndicatorElement()

const Indicator = CustomElement.define({
  tag: INDICATOR_TAG,
  properties: { value: Schema.String, optionsKey: Schema.String, size: Schema.String },
  events: {},
})

/**
 * `<SegmentedControl>` (src/client/components/ui/segmented-control.tsx). The
 * React `tooltip` option isn't ported: no caller uses it.
 *
 *   segmentedControl({ value: model.tool, onValueChange: (tool) => ChoseTool({ tool }), options: TOOLS, size: "sm" }, h)
 */
export function segmentedControl<T extends string, Message>(
  options: SegmentedControlOptions<T, Message>,
  h: HtmlBuilder<Message>,
): Html {
  const size = options.size ?? "md"
  const hasActive = options.options.some((option) => option.value === options.value)
  const indicator = Indicator.withMessage(h)
  return h.div(
    [h.Class(cn(
      "relative inline-flex items-center rounded-lg border border-border p-[3px] bg-slate-200 dark:bg-transparent",
      options.class,
    ))],
    [
      hasActive
        ? indicator([
          h.Key("indicator"),
          h.AriaHidden(true),
          indicator.Value(options.value),
          indicator.OptionsKey(options.options.map((option) => `${option.value}:${option.disabled ? 1 : 0}`).join(",")),
          indicator.Size(size),
          h.Class(cn(
            "pointer-events-none absolute top-[3px] bottom-[3px] rounded-[4px] border",
            "bg-white dark:bg-muted border-slate-300 dark:border-white/10",
            "transition-[left,width] duration-200 ease-in-out",
          )),
        ])
        : null,
      ...options.options.map((option) => {
        const isActive = option.value === options.value
        return h.keyed("button")(option.value, [
          h.Type("button"),
          h.DataAttribute("segment-value", option.value),
          h.OnClick(options.onValueChange(option.value)),
          ...(option.disabled ? [h.Disabled(true)] : []),
          h.AriaPressed(String(isActive)),
          h.Class(cn(
            "relative z-10 rounded-[4px] border border-transparent transition-colors",
            option.icon ? "grid grid-cols-[auto_auto] items-center gap-2" : "inline-flex items-center",
            sizeClasses[size],
            isActive
              ? "text-slate-900 dark:text-slate-200"
              : "text-slate-800 hover:text-slate-900 dark:text-muted-foreground dark:hover:text-foreground",
            option.disabled && "opacity-50 pointer-events-none",
            options.optionClass,
          )),
        ], [
          option.icon ? option.icon({ class: size === "sm" ? "h-3.5 w-3.5" : "h-4 w-4" }, h) : null,
          h.span([], option.label),
        ])
      }),
    ],
  )
}
