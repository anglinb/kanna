function ZigZagLine({ size = 4 }: { size?: number }) {
  return (
    <svg className="flex-1" viewBox={`0 0 100 ${size}`} preserveAspectRatio="none" style={{ height: `${size}px` }}>
      <pattern id="zigzag" width={size} height={size} patternUnits="userSpaceOnUse">
        <path d={`M0 ${size} L${size / 2} 0 L${size} ${size}`} fill="none" stroke="currentColor" strokeWidth="0.5" className="text-muted-foreground/30" style={{ stroke: 'currentColor' }} />
      </pattern>
      <rect width="100%" height={size} fill="url(#zigzag)" className="text-muted-foreground/30" />
    </svg>
  )
}

export function CompactBoundaryMessage() {
  return (
    <div className="flex items-center gap-3">
      <ZigZagLine />
      <span className="text-[11px] tracking-widest text-muted-foreground uppercase flex-shrink-0">Compacted</span>
      <ZigZagLine />
    </div>
  )
}

export function ContextClearedMessage() {
  return (
    <div className="flex items-center gap-3">
      <ZigZagLine />
      <span className="text-[11px] tracking-widest text-muted-foreground uppercase flex-shrink-0">Context Cleared</span>
      <ZigZagLine />
    </div>
  )
}

/**
 * Outcome of an ask-for-secret prompt. Carries the name and what happened —
 * never the value, which is the point of the whole mechanism.
 */
export function SecretNoticeMessage({
  message,
}: {
  message: Extract<
    import("../../../shared/types").HydratedTranscriptMessage,
    { kind: "secret_notice" }
  >
}) {
  const label = message.outcome === "saved"
    ? `${message.secretName} saved${message.scope ? ` · ${message.scope}` : ""}`
    : message.outcome === "declined"
      ? `${message.secretName} declined`
      : `${message.secretName} expired`

  return (
    <div className="flex items-center gap-3">
      <ZigZagLine />
      <span className="flex-shrink-0 text-[11px] uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <ZigZagLine />
    </div>
  )
}

/**
 * A reminder fired and woke this chat.
 *
 * Reads as a divider rather than a message because that is its job: the prompt
 * directly below it was posted by the schedule, not typed by the user, and
 * without this line it reads as something they said and forgot.
 */
export function ReminderNoticeMessage({
  message,
}: {
  message: Extract<
    import("../../../shared/types").HydratedTranscriptMessage,
    { kind: "reminder_notice" }
  >
}) {
  const ago = formatScheduledAgo(message.scheduledAt, Date.parse(message.timestamp))
  const who = message.createdBy === "agent" ? "scheduled follow-up" : "reminder"
  const label = message.wokeAgent
    ? `${who}${ago ? ` · set ${ago} ago` : ""}`
    : `${who}${ago ? ` · set ${ago} ago` : ""} · no turn started`

  return (
    <div className="flex items-center gap-3">
      <ZigZagLine />
      <span className="flex-shrink-0 text-[11px] uppercase tracking-widest text-muted-foreground">
        {label}
      </span>
      <ZigZagLine />
    </div>
  )
}

/**
 * How long before firing the reminder was set. Coarse on purpose — "set 3h ago"
 * is the useful fact; minutes of precision on a thing that already happened is
 * noise. Returns null when the gap is under a minute or the timestamps are
 * unusable, so the label simply omits the clause.
 */
function formatScheduledAgo(scheduledAt: number, firedAt: number): string | null {
  if (!Number.isFinite(scheduledAt) || !Number.isFinite(firedAt)) return null
  const elapsed = firedAt - scheduledAt
  if (elapsed < 60_000) return null
  const minutes = Math.round(elapsed / 60_000)
  if (minutes < 60) return `${minutes}m`
  const hours = Math.round(elapsed / 3_600_000)
  if (hours < 24) return `${hours}h`
  return `${Math.round(hours / 24)}d`
}
