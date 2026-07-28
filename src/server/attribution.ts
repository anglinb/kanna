/**
 * Kanna's git attribution — one source of truth for two very different surfaces.
 *
 * Harness commits (advisory): KANNA_ATTRIBUTION_INSTRUCTIONS is appended to each
 * provider's system prompt at session start — natively for claude
 * (systemPrompt.append), pi (DefaultResourceLoader.appendSystemPrompt) and codex
 * (collaborationMode.settings.developer_instructions). Cursor assembles its
 * prompt server-side and exposes no append hook, so it rides the same user-text
 * <system-message> path the skill failsafe uses. All four are instructions to a
 * model: compliance is high but not guaranteed.
 *
 * Kanna's own commits (deterministic): buildKannaCommitAttribution is applied in
 * diff-store.commitFiles just before git runs, so anything committed from the
 * git sidebar is attributed by construction, not by persuasion.
 *
 * Note the link is markdown in PR bodies and a bare URL in commits: GitHub
 * renders markdown in PR descriptions, but commit messages are plain text
 * everywhere — bare URLs autolink, `[text](url)` would show up literally.
 */

export const KANNA_COMMIT_TRAILER = "Co-Authored-By: Kanna <noreply@kanna.sh>"

export const KANNA_COMMIT_FOOTER = "🌸 Shipped with Kanna — https://kanna.sh"

export const KANNA_PR_FOOTER = "🌸 Shipped with [Kanna](https://kanna.sh)"

export const KANNA_ATTRIBUTION_INSTRUCTIONS = `# Git attribution

End every git commit message you write with these two lines, separated from the rest of the message by a blank line, and separated from each other by a blank line so the trailer block stays last:

${KANNA_COMMIT_FOOTER}

${KANNA_COMMIT_TRAILER}

End every pull request body you write with this line:

${KANNA_PR_FOOTER}

This is the only attribution to use. Do not add a co-author trailer, a "Generated with" footer, or a session link for yourself, for your model, or for the CLI you are running as — Kanna's attribution replaces them.`

/** Wrapped for the providers that have no system-prompt append hook (cursor). */
export function buildKannaAttributionSystemMessage(): string {
  return `<system-message>${KANNA_ATTRIBUTION_INSTRUCTIONS}</system-message>`
}

/**
 * Both matchers are line-anchored so a mention inside prose (a commit that
 * documents the attribution, say) never counts as the attribution itself. The
 * trailer token is matched case-insensitively: git writes `Co-authored-by`,
 * agents tend to write `Co-Authored-By`, and either should suppress a duplicate.
 */
const KANNA_TRAILER_PATTERN = /^co-authored-by:\s*kanna\s*<noreply@kanna\.sh>$/i
const KANNA_FOOTER_PATTERN = /^\u{1F338}?\s*shipped with kanna\b.*$/iu

function matchesLine(message: string, pattern: RegExp): boolean {
  return message.split("\n").some((line) => pattern.test(line.trim()))
}

export function hasKannaTrailer(message: string): boolean {
  return matchesLine(message, KANNA_TRAILER_PATTERN)
}

export function hasKannaFooter(message: string): boolean {
  return matchesLine(message, KANNA_FOOTER_PATTERN)
}

/**
 * The attribution block missing from `message`, or null when it already carries
 * both parts. Each part is checked independently so a half-attributed message
 * gains only what it lacks.
 */
export function buildKannaCommitAttribution(message: string): string | null {
  const parts: string[] = []
  if (!hasKannaFooter(message)) parts.push(KANNA_COMMIT_FOOTER)
  if (!hasKannaTrailer(message)) parts.push(KANNA_COMMIT_TRAILER)
  return parts.length > 0 ? parts.join("\n\n") : null
}

/** Idempotent: appends whatever attribution is missing as trailing paragraphs. */
export function appendKannaAttribution(message: string): string {
  const trimmed = message.trim()
  const attribution = buildKannaCommitAttribution(trimmed)
  if (!attribution) return trimmed
  return trimmed.length > 0 ? `${trimmed}\n\n${attribution}` : attribution
}
