/**
 * Ask-for-secret: the agent asks Kanna for a credential by name, the user
 * types it into Kanna's UI, and it lands in a file the agent sources into a
 * shell. The value never travels through the agent's context — not in the
 * tool call, not in the tool result, not in the transcript.
 *
 * This module is the wire contract shared by client, server, and the CLI, so
 * it stays free of Bun/node imports (see CLAUDE.md).
 */

export type SecretScope = "project" | "global"

/**
 * Secrets are sourced into a shell, so a name has to be a valid POSIX
 * variable name — anything else would produce a file that `.` cannot read.
 */
export const SECRET_NAME_PATTERN = /^[A-Za-z_][A-Za-z0-9_]*$/
export const SECRET_NAME_MAX_LENGTH = 128
/** Generous enough for a PEM private key, small enough to bound a stray paste. */
export const SECRET_VALUE_MAX_BYTES = 64 * 1024
export const SECRET_REASON_MAX_LENGTH = 500

/** Path prefix for the loopback-only HTTP API the CLI talks to. */
export const SECRETS_API_PATH_PREFIX = "/__local/secrets"
/** Header carrying the instance token minted at server start. */
export const SECRETS_API_TOKEN_HEADER = "x-kanna-token"
/**
 * Set on the environment of a spawned harness so `ask-secret` can name the
 * chat it was run from. Absent for providers Kanna does not spawn with a
 * per-chat environment, where the server falls back to matching the running
 * turn against the CLI's cwd.
 */
export const SECRET_CHAT_ID_ENV_VAR = "KANNA_CHAT_ID"

export interface PendingSecretRequest {
  id: string
  name: string
  /** Why the agent needs it — shown to the user verbatim. */
  reason: string
  /** Absolute project root, when the CLI's cwd resolved to a known project. */
  projectPath: string | null
  projectTitle: string | null
  /** Directory the agent ran the CLI from. */
  cwd: string
  /**
   * Chat the asking agent is running in, when it could be determined. Drives
   * the transcript notice written when the prompt settles.
   */
  chatId: string | null
  /** The agent's suggestion; the user still picks in the dialog. */
  suggestedScope: SecretScope | null
  createdAt: number
}

export interface SecretRequestsSnapshot {
  requests: PendingSecretRequest[]
}

/** Terminal states for one ask. `pending` means the dialog is still open. */
export type SecretRequestStatus = "pending" | "saved" | "cancelled" | "expired"

export interface SecretRequestResolution {
  status: SecretRequestStatus
  /** Absolute path of the written file. Present only when `saved`. */
  path?: string
  scope?: SecretScope
  /** Shell snippet that loads the secret. Present only when `saved`. */
  loadCommand?: string
  /** True when the user's answer also added a `.gitignore` entry. */
  gitignoreUpdated?: boolean
}

export function isValidSecretName(name: string): boolean {
  return (
    name.length > 0
    && name.length <= SECRET_NAME_MAX_LENGTH
    && SECRET_NAME_PATTERN.test(name)
  )
}

/** The single file that holds one secret, e.g. `OPENAI_API_KEY.env`. */
export function secretFileName(name: string): string {
  return `${name}.env`
}

/**
 * Wrap a value in single quotes for `sh`. The only character that cannot
 * appear inside a single-quoted string is `'` itself, which is closed,
 * escaped, and reopened — the standard POSIX dance.
 */
export function shellSingleQuote(value: string): string {
  return `'${value.replaceAll("'", "'\\''")}'`
}

/**
 * Body of a `<NAME>.env` file. Deliberately a bare `NAME=value` assignment
 * rather than `export NAME=value`: it stays readable by dotenv-style loaders,
 * and `set -a` around the `.` handles exporting.
 */
export function formatSecretEnvFile(name: string, value: string): string {
  return [
    `# Written by Kanna — holds the secret ${name}.`,
    "# Do not commit this file, and do not print or cat it.",
    `${name}=${shellSingleQuote(value)}`,
    "",
  ].join("\n")
}

/** The shell snippet handed back to the agent. Exports the name, prints nothing. */
export function buildSecretLoadCommand(filePath: string): string {
  return `set -a; . ${shellSingleQuote(filePath)}; set +a`
}

/** The one `.gitignore` line that covers every project-scoped secret. */
export const SECRETS_GITIGNORE_ENTRY = ".kanna/secrets/"

/**
 * Patterns that already keep `.kanna/secrets/` out of git. Checked before
 * appending so repos that ignore all of `.kanna/` are left alone.
 */
export function coversSecretsDir(gitignoreLine: string): boolean {
  const trimmed = gitignoreLine.trim()
  if (!trimmed || trimmed.startsWith("#")) return false
  const normalized = trimmed.replace(/^\/+/, "").replace(/\/+$/, "")
  return (
    normalized === ".kanna"
    || normalized === ".kanna/*"
    || normalized === ".kanna/secrets"
    || normalized === ".kanna/secrets/*"
  )
}
