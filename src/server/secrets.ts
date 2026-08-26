/**
 * On-disk half of ask-for-secret (see `shared/secrets.ts` for the contract).
 *
 * One file per secret so an agent can source exactly the credential it needs
 * and nothing else:
 *   project scope → `<project>/.kanna/secrets/<NAME>.env`
 *   global scope  → `~/.kanna/secrets/<NAME>.env`
 *
 * Files are 0600 and their directories 0700. Project scope also appends a
 * single `.kanna/secrets/` line to `.gitignore`, which covers every secret
 * the project will ever hold.
 */

import { constants } from "node:fs"
import { access, chmod, lstat, mkdir, open, readdir, readFile, rm, writeFile } from "node:fs/promises"
import { homedir } from "node:os"
import path from "node:path"
import { getGlobalSecretsDir, PROJECT_SECRETS_DIR_RELATIVE } from "../shared/branding"
import {
  buildSecretLoadCommand,
  coversSecretsDir,
  formatSecretEnvFile,
  isValidSecretName,
  secretFileName,
  SECRET_VALUE_MAX_BYTES,
  SECRETS_GITIGNORE_ENTRY,
  type SecretScope,
} from "../shared/secrets"

const SECRET_FILE_MODE = 0o600
const SECRET_DIR_MODE = 0o700

export interface SecretLocation {
  scope: SecretScope
  name: string
  path: string
}

export interface WriteSecretArgs {
  scope: SecretScope
  name: string
  value: string
  /** Required for project scope; ignored for global. */
  projectPath?: string | null
}

export interface WriteSecretResult extends SecretLocation {
  loadCommand: string
  gitignoreUpdated: boolean
}

async function pathExists(target: string): Promise<boolean> {
  try {
    await access(target, constants.F_OK)
    return true
  } catch {
    return false
  }
}

export function getProjectSecretsDir(projectPath: string): string {
  return path.join(projectPath, PROJECT_SECRETS_DIR_RELATIVE)
}

export function getSecretsDir(scope: SecretScope, projectPath?: string | null): string {
  if (scope === "global") {
    return getGlobalSecretsDir(homedir())
  }
  if (!projectPath) {
    throw new Error("A project path is required for project-scoped secrets")
  }
  return getProjectSecretsDir(projectPath)
}

export function resolveSecretFilePath(
  scope: SecretScope,
  name: string,
  projectPath?: string | null,
): string {
  if (!isValidSecretName(name)) {
    throw new Error(
      `Invalid secret name '${name}' — use letters, digits and underscores, starting with a letter or underscore`,
    )
  }
  return path.join(getSecretsDir(scope, projectPath), secretFileName(name))
}

/**
 * Add `.kanna/secrets/` to the project's `.gitignore`, unless git isn't in
 * play or something already covers the directory. Returns true only when the
 * file was actually changed.
 */
export async function ensureSecretsIgnored(projectPath: string): Promise<boolean> {
  // No repo, nothing to leak into. A bare `.git` file (worktree/submodule
  // pointer) counts just as much as a directory.
  if (!(await pathExists(path.join(projectPath, ".git")))) {
    return false
  }

  const gitignorePath = path.join(projectPath, ".gitignore")
  let current = ""
  try {
    current = await readFile(gitignorePath, "utf8")
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }

  if (current.split("\n").some(coversSecretsDir)) {
    return false
  }

  const prefix = current.length === 0 || current.endsWith("\n") ? "" : "\n"
  const block = `${prefix}\n# Kanna secrets — never commit\n${SECRETS_GITIGNORE_ENTRY}\n`
  await writeFile(gitignorePath, `${current}${block}`, "utf8")
  return true
}

export async function writeSecret(args: WriteSecretArgs): Promise<WriteSecretResult> {
  const { scope, name, value, projectPath } = args

  if (!isValidSecretName(name)) {
    throw new Error(
      `Invalid secret name '${name}' — use letters, digits and underscores, starting with a letter or underscore`,
    )
  }
  if (value.length === 0) {
    throw new Error("Secret value is empty")
  }
  if (Buffer.byteLength(value, "utf8") > SECRET_VALUE_MAX_BYTES) {
    throw new Error("Secret value is too large")
  }
  if (scope === "project" && !projectPath) {
    throw new Error("A project path is required for project-scoped secrets")
  }

  const dir = getSecretsDir(scope, projectPath)
  await mkdir(dir, { recursive: true, mode: SECRET_DIR_MODE })

  // `mkdir` is satisfied by a symlink that happens to point at a directory,
  // so confirm what we actually got. Anything but a real directory here means
  // someone pre-staged the path to redirect the write.
  const dirStats = await lstat(dir)
  if (!dirStats.isDirectory()) {
    throw new Error(`Refusing to write a secret: ${dir} is not a directory`)
  }

  // mkdir's mode is masked by umask on creation and skipped entirely when the
  // directory already exists, so the permissions are set explicitly.
  await chmod(dir, SECRET_DIR_MODE)

  const filePath = path.join(dir, secretFileName(name))

  // O_NOFOLLOW fails with ELOOP rather than following a symlink at the final
  // component — otherwise a pre-created `<NAME>.env` link would send the
  // credential wherever it pointed. Writing through the handle keeps the
  // check and the write on the same file, with no window between them.
  let handle
  try {
    handle = await open(
      filePath,
      constants.O_WRONLY | constants.O_CREAT | constants.O_TRUNC | constants.O_NOFOLLOW,
      SECRET_FILE_MODE,
    )
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ELOOP") {
      throw new Error(`Refusing to write a secret: ${filePath} is a symbolic link`)
    }
    throw error
  }

  try {
    // An existing file keeps its old mode through O_CREAT, so set it here.
    await handle.chmod(SECRET_FILE_MODE)
    await handle.writeFile(formatSecretEnvFile(name, value), "utf8")
  } finally {
    await handle.close()
  }

  const gitignoreUpdated = scope === "project" && projectPath
    ? await ensureSecretsIgnored(projectPath)
    : false

  return {
    scope,
    name,
    path: filePath,
    loadCommand: buildSecretLoadCommand(filePath),
    gitignoreUpdated,
  }
}

/**
 * Locate an already-stored secret. Project scope wins over global so a repo
 * can override a machine-wide default with its own value.
 */
export async function findExistingSecret(
  name: string,
  projectPath?: string | null,
): Promise<SecretLocation | null> {
  if (!isValidSecretName(name)) return null

  const candidates: SecretLocation[] = []
  if (projectPath) {
    candidates.push({ scope: "project", name, path: resolveSecretFilePath("project", name, projectPath) })
  }
  candidates.push({ scope: "global", name, path: resolveSecretFilePath("global", name) })

  for (const candidate of candidates) {
    if (await pathExists(candidate.path)) return candidate
  }
  return null
}

/** Names only — this never reads a secret's contents. */
export async function listSecrets(projectPath?: string | null): Promise<SecretLocation[]> {
  const found: SecretLocation[] = []

  const scan = async (scope: SecretScope, dir: string) => {
    let entries: string[]
    try {
      entries = await readdir(dir)
    } catch {
      return
    }
    for (const entry of entries) {
      if (!entry.endsWith(".env")) continue
      const name = entry.slice(0, -".env".length)
      if (!isValidSecretName(name)) continue
      found.push({ scope, name, path: path.join(dir, entry) })
    }
  }

  if (projectPath) await scan("project", getProjectSecretsDir(projectPath))
  await scan("global", getGlobalSecretsDir(homedir()))

  return found.sort((a, b) => a.name.localeCompare(b.name) || a.scope.localeCompare(b.scope))
}

export async function deleteSecret(
  scope: SecretScope,
  name: string,
  projectPath?: string | null,
): Promise<boolean> {
  const filePath = resolveSecretFilePath(scope, name, projectPath)
  if (!(await pathExists(filePath))) return false
  await rm(filePath, { force: true })
  return true
}
