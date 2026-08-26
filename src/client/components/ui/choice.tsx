import { Check } from "lucide-react"
import { cn } from "../../lib/utils"

/**
 * Building blocks for the inline "pick one of these" cards that appear in the
 * transcript flow — the AskUserQuestion prompt and the ask-for-secret prompt.
 *
 * Shared rather than copied so the two read as the same control. Each card
 * builds its own header (they differ: one carries a progress bar, the other a
 * secret name), but the rows and the check indicator come from here.
 */

/** The card shell. Rows inside separate themselves with `border-b`. */
export function ChoiceCard({
  className,
  children,
}: {
  className?: string
  children: React.ReactNode
}) {
  return (
    <div className={cn("overflow-hidden rounded-2xl border border-border", className)}>
      {children}
    </div>
  )
}

/**
 * Circle for single-select, square for multi — matching native radio/checkbox
 * semantics.
 *
 * Renders a `span` unless given its own `onClick`: inside `ChoiceRow` the row
 * is already the button, and a nested `button` is invalid markup.
 */
export function ChoiceCheckbox({
  selected,
  multiSelect,
  onClick,
  disabled,
}: {
  selected: boolean
  multiSelect?: boolean
  onClick?: () => void
  disabled?: boolean
}) {
  const className = cn(
    "flex h-5 w-5 flex-shrink-0 items-center justify-center border-1",
    multiSelect ? "rounded" : "rounded-full",
    selected ? "border-slate-500/0 bg-foreground" : "border-muted-foreground/50 bg-background",
    onClick && selected && "cursor-pointer",
  )

  const mark = selected ? (
    <Check strokeWidth={3} className="h-3 w-3 translate-y-[0.5px] text-white dark:text-background" />
  ) : null

  if (!onClick) {
    return (
      <span aria-hidden className={className}>
        {mark}
      </span>
    )
  }

  return (
    <button type="button" onClick={onClick} disabled={disabled} className={className}>
      {mark}
    </button>
  )
}

export function ChoiceOptionContent({
  label,
  description,
}: {
  label: string
  description?: string
}) {
  return (
    <>
      <span className="text-sm text-foreground">{label}</span>
      {description && <p className="mt-0.5 text-xs text-muted-foreground">{description}</p>}
    </>
  )
}

/**
 * One selectable row. Renders as a plain div when `onClick` is omitted, which
 * is how the read-only transcript views show the same list without offering
 * to change it.
 */
export function ChoiceRow({
  label,
  description,
  icon,
  selected,
  multiSelect,
  onClick,
  disabled,
  isLast,
}: {
  label: string
  description?: string
  icon?: React.ReactNode
  selected: boolean
  multiSelect?: boolean
  onClick?: () => void
  disabled?: boolean
  isLast?: boolean
}) {
  const baseClasses = "w-full bg-background p-3 pl-4 pr-5 pt-2.5 text-left"
  const borderClass = !isLast ? "border-b border-border" : ""

  const body = (
    <div className="flex items-center justify-between gap-3">
      {icon ? (
        <span className={cn("flex-shrink-0", selected ? "text-foreground" : "text-muted-foreground")}>
          {icon}
        </span>
      ) : null}
      <div className="min-w-0 flex-1">
        <ChoiceOptionContent label={label} description={description} />
      </div>
      <ChoiceCheckbox selected={selected} multiSelect={multiSelect} disabled={disabled} />
    </div>
  )

  if (!onClick) {
    return <div className={cn(baseClasses, borderClass)}>{body}</div>
  }

  return (
    <button
      type="button"
      onClick={onClick}
      disabled={disabled}
      className={cn(
        baseClasses,
        borderClass,
        "cursor-pointer transition-all",
        disabled && "cursor-not-allowed opacity-50",
      )}
    >
      {body}
    </button>
  )
}
