import type { MessageSource } from "../../shared/types"

/** The senders this client draws a prompt for: see `SourcedMessage`. */
const DRAWN_SOURCE_KINDS: ReadonlySet<string> = new Set<string>(["agent", "report", "schedule"])

/**
 * A prompt's source, if it is one this client draws; otherwise none, and the
 * prompt reads as the user's own.
 *
 * Transcripts outlive the features that wrote them. A delegator's from the
 * ticket board still holds the user's replies on tickets (`ticket`) and
 * Kanna's reminders to post on them (`ticket_nudge`), and a newer server may
 * send a kind this build has never heard of. Read as the user's prompt, each
 * shows what a person wrote and nothing else: the `<system-message>` header
 * the agent was given is stripped as any prompt's is, which leaves a reply's
 * words, and of a reminder nothing at all, so it draws no row.
 */
export function drawnMessageSource(source: MessageSource | undefined): MessageSource | undefined {
  return source && DRAWN_SOURCE_KINDS.has(source.kind) ? source : undefined
}
