import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../client/lib/utils"

export interface SwitchOptions<Message> {
  checked: boolean
  /** The Message for a click, given the state the switch moves to. */
  onCheckedChange: (checked: boolean) => Message
  disabled?: boolean
  class?: string
  ariaLabel?: string
}

/**
 * A binary on/off control. Settings used an "Off | On" segmented control for
 * these, which read like a choice between two modes rather than a toggle.
 *
 *   switchControl({ checked: model.sounds, onCheckedChange: (checked) => ToggledSounds({ checked }), ariaLabel: "Sounds" }, h)
 */
export function switchControl<Message>(options: SwitchOptions<Message>, h: HtmlBuilder<Message>): Html {
  const { checked } = options
  return h.button(
    [
      h.Type("button"),
      h.Role("switch"),
      h.AriaChecked(checked),
      ...(options.ariaLabel !== undefined ? [h.AriaLabel(options.ariaLabel)] : []),
      ...(options.disabled ? [h.Disabled(true)] : []),
      h.OnClick(options.onCheckedChange(!checked)),
      h.Class(cn(
        "group relative inline-flex h-6 w-10 shrink-0 cursor-pointer items-center rounded-full border-2 border-transparent",
        // Opacity too, so a switch disabled by another setting dims as its knob
        // slides off rather than before.
        "transition-[background-color,opacity] duration-350 ease-glide",
        "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 focus-visible:ring-offset-background",
        "disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-logo" : "bg-slate-300 dark:bg-white/15",
        options.class,
      )),
    ],
    [
      // On is the brand colour in both themes, so the thumb is white in
      // both, on or off.
      //
      // Pressing stretches the thumb toward the side it will travel to, as
      // an iOS switch does: the press is answered on pointer-down, before
      // the click commits. Width rather than scaleX, which would flatten
      // the round ends; the thumb is 20px inside a fixed track, so nothing
      // else reflows. Checked, it moves left by the stretch so its right
      // edge stays put. Reduced motion drops the stretch and the slide;
      // the track's colour still says which way it went.
      h.span([
        h.AriaHidden(true),
        h.Class(cn(
          "pointer-events-none block h-5 w-5 rounded-full bg-white shadow-sm",
          // The slide takes 350ms so the travel reads; the stretch stays at 150ms
          // because it answers the press and has to feel immediate.
          "[transition:translate_350ms_var(--ease-glide),width_150ms_var(--ease-snappy)]",
          "motion-safe:group-enabled:group-active:w-6 motion-reduce:transition-none",
          checked
            ? "translate-x-4 motion-safe:group-enabled:group-active:translate-x-3"
            : "translate-x-0",
        )),
      ]),
    ],
  )
}
