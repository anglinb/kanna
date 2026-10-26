import type { ChildAttribute, Html, HtmlBuilder, TextareaAttribute } from "foldkit/html"
import { cn } from "../../client/lib/utils"

export interface TextareaOptions<Message> {
  class?: string
  value?: string
  placeholder?: string
  rows?: number
  disabled?: boolean
  onInput?: (value: string) => Message
  attributes?: ReadonlyArray<TextareaAttribute<Message> | ChildAttribute>
}

/**
 * `<Textarea>` (src/client/components/ui/textarea.tsx), with the attributes
 * that keep Grammarly and 1Password out of it.
 *
 *   textarea({ value: model.message, rows: 3, onInput: (value) => ChangedMessage({ value }) }, h)
 */
export function textarea<Message>(options: TextareaOptions<Message>, h: HtmlBuilder<Message>): Html {
  const attributes: Array<TextareaAttribute<Message> | ChildAttribute> = [
    h.DataAttribute("gramm", "false"),
    h.DataAttribute("gramm_editor", "false"),
    h.DataAttribute("enable-grammarly", "false"),
    h.DataAttribute("1p-ignore", "true"),
    h.Autocomplete("off"),
    h.Class(cn(
      "flex w-full rounded-lg border border-border bg-background px-2.5 py-2 text-sm placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
      options.class,
    )),
    ...(options.value !== undefined ? [h.Value(options.value)] : []),
    ...(options.placeholder !== undefined ? [h.Placeholder(options.placeholder)] : []),
    ...(options.rows !== undefined ? [h.Rows(options.rows)] : []),
    ...(options.disabled ? [h.Disabled(true)] : []),
    ...(options.onInput ? [h.OnInput(options.onInput)] : []),
    ...(options.attributes ?? []),
  ]
  return h.textarea(attributes)
}
