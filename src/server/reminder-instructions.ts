/**
 * The system-prompt block that teaches an agent to schedule its own wake-ups.
 *
 * Appended for every provider — Claude via `systemPrompt.append`, codex via
 * `developer_instructions`, pi via `appendSystemPrompt` — alongside the
 * attribution, ask-secret and pull-request blocks.
 *
 * Kept short: it is paid for on every turn of every chat. The single most
 * valuable line is the one telling the agent *not* to sleep in a loop, which is
 * what it will otherwise reach for when the user says "check back in 30".
 */

import { CLI_COMMAND } from "../shared/branding"
import { resolveCliFallbackPath } from "./secret-instructions"

/**
 * `chatId` is baked into the example command for providers that cannot carry a
 * per-chat `KANNA_CHAT_ID`: codex shares one app-server process across every
 * chat in a project, so the env var Claude gets is not available there. Without
 * it the server has to infer the chat from the working directory, which is
 * ambiguous the moment two chats in the same project are running at once.
 */
export function reminderInstructionsBlock(chatId?: string): string | null {
  return buildReminderInstructions(resolveCliFallbackPath(), chatId)
}

export function buildReminderInstructions(
  cliPath: string = resolveCliFallbackPath(),
  chatId?: string,
): string {
  const chatFlag = chatId ? ` --chat ${chatId}` : ""
  return [
    "# Coming back to this later",
    "",
    "When something should happen after a wait — the user says \"check back in 30\", a deploy",
    "needs time to settle, a rate limit resets in an hour — schedule it and end your turn:",
    "",
    `  ${CLI_COMMAND} remind --in 30m${chatFlag} "re-run the metrics query and compare to the numbers above"`,
    `  ${CLI_COMMAND} remind --in 2h${chatFlag} "check whether the migration finished"`,
    `  ${CLI_COMMAND} remind --clear${chatFlag}   # cancel the pending one`,
    "",
    "At that time Kanna starts a new turn in this chat with the message you gave, so write the",
    "message to your future self: it arrives with none of your current context loaded, and what",
    "you believe right now may be stale by then. Say what to do and what to compare against.",
    "",
    "- Do not sleep, poll, or loop waiting for a time to pass. It burns the turn and dies with",
    "  the process. The schedule is persisted and survives a restart; your process will not.",
    "- A chat has one pending reminder — scheduling another replaces it.",
    `- If \`${CLI_COMMAND}\` is not on PATH, use \`${cliPath}\`.`,
  ].join("\n")
}
