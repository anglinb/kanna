/**
 * The system-prompt block that teaches an agent about ask-for-secret.
 *
 * Appended for every provider — Claude via `systemPrompt.append`, codex via
 * `developer_instructions`, pi via `appendSystemPrompt` — because the CLI is
 * the one affordance all three share. It rides alongside the git-attribution
 * block (see attribution.ts) and is kept deliberately short: it is paid for
 * on every single turn.
 */

import { fileURLToPath } from "node:url"
import { CLI_COMMAND } from "../shared/branding"

/**
 * Absolute path to the bundled CLI, for the case where kanna was run from a
 * source checkout and never installed onto PATH.
 */
export function resolveCliFallbackPath(): string {
  try {
    return fileURLToPath(new URL("../../bin/kanna", import.meta.url))
  } catch {
    return CLI_COMMAND
  }
}

export function buildAskSecretInstructions(cliPath: string = resolveCliFallbackPath()): string {
  return [
    "# Secrets",
    "",
    "When you need a credential you do not have (API key, token, password), never ask for it",
    "in chat — anything the user types there enters your context and the transcript. Instead run:",
    "",
    `  ${CLI_COMMAND} ask-secret <NAME> --reason "<why you need it>"`,
    "",
    "The user types the value into Kanna and chooses project or global scope. The command",
    "prints a shell snippet that loads it, e.g. `set -a; . <path>/<NAME>.env; set +a` — run that",
    "in the same shell command as the work that needs it, then use $<NAME>.",
    "",
    "- <NAME> must be a valid shell variable name, e.g. OPENAI_API_KEY.",
    "- It waits up to 5 minutes, so give the command a generous timeout. If it times out the",
    "  prompt is still open: re-running the same command resumes the same wait.",
    "- Exit code 3 means the user declined. Do not ask again — continue without it or say what",
    "  you cannot do.",
    "- Never cat, read, echo, grep or print the .env file or the variable. The value is kept out",
    "  of your context on purpose; reading it defeats the entire mechanism.",
    `- If \`${CLI_COMMAND}\` is not on PATH, use \`${cliPath}\`.`,
  ].join("\n")
}
