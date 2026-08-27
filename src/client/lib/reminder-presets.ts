/**
 * The reminder choices offered in the sidebar's right-click menu.
 *
 * Presets rather than a time picker: the menu is for the two-second decision
 * ("not now — after lunch"). Anything more specific is what `kanna remind --at`
 * is for, and an agent can set one from inside the chat.
 */

export interface ReminderPreset {
  label: string
  /** Absolute epoch ms this preset means, given the current time. */
  resolve: (now: number) => number
}

const MINUTE_MS = 60_000
const HOUR_MS = 60 * MINUTE_MS

/** Local-time hour that "tomorrow morning" means. */
const MORNING_HOUR = 9

/**
 * The next {@link MORNING_HOUR} in the *viewer's* timezone.
 *
 * Built from local date parts rather than by adding 24h, so it lands on the
 * clock hour across a DST boundary instead of an hour either side of it. Late
 * evening still means the next calendar day; 2am means later this morning,
 * which is what someone awake at 2am means by "the morning".
 */
export function nextMorning(now: number, hour: number = MORNING_HOUR): number {
  const date = new Date(now)
  const morning = new Date(date.getFullYear(), date.getMonth(), date.getDate(), hour, 0, 0, 0)
  if (morning.getTime() <= now) morning.setDate(morning.getDate() + 1)
  return morning.getTime()
}

export const REMINDER_PRESETS: ReminderPreset[] = [
  { label: "In 15 minutes", resolve: (now) => now + 15 * MINUTE_MS },
  { label: "In 1 hour", resolve: (now) => now + HOUR_MS },
  { label: "In 3 hours", resolve: (now) => now + 3 * HOUR_MS },
  { label: "Tomorrow morning", resolve: (now) => nextMorning(now) },
]

/**
 * How a pending reminder reads in the menu and on the row: "in 12m", "in 3h",
 * "in 2d", or "now" once it is due but the tick has not yet caught it.
 */
export function formatReminderDue(dueAt: number, now: number): string {
  const remaining = dueAt - now
  if (remaining <= 0) return "now"
  const minutes = Math.round(remaining / MINUTE_MS)
  if (minutes < 60) return `in ${Math.max(1, minutes)}m`
  const hours = Math.round(remaining / HOUR_MS)
  if (hours < 24) return `in ${hours}h`
  return `in ${Math.round(hours / 24)}d`
}
