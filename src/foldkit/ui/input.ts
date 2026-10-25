import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import type { ExtraAttributes } from "./attributes"

export interface InputOptions<Message> {
  type?: string
  class?: string
  /** The controlled value. Leave it out for an uncontrolled input. */
  value?: string
  placeholder?: string
  disabled?: boolean
  /** Turns each edit into a Message (React's onChange on an input). */
  onInput?: (value: string) => Message
  attributes?: ExtraAttributes<Message>
}

/**
 * `<Input>` (src/client/components/ui/input.tsx).
 *
 *   input({ type: "text", value: model.name, onInput: (value) => ChangedName({ value }) }, h)
 */
export function input<Message>(options: InputOptions<Message>, h: HtmlBuilder<Message>): Html {
  return h.input([
    ...(options.type !== undefined ? [h.Type(options.type)] : []),
    h.Class(cn(
      "flex w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
      options.class,
    )),
    ...(options.value !== undefined ? [h.Value(options.value)] : []),
    ...(options.placeholder !== undefined ? [h.Placeholder(options.placeholder)] : []),
    ...(options.disabled ? [h.Disabled(true)] : []),
    ...(options.onInput ? [h.OnInput(options.onInput)] : []),
    ...(options.attributes ?? []),
  ])
}
