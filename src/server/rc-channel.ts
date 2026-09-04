import process from "node:process"
import { spawnSync } from "node:child_process"
import { readFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { getRuntimeProfile, LOG_PREFIX, RC_PACKAGE_NAME, type RuntimeProfile } from "../shared/branding"
import {
  classifyInstallVersionFailure,
  compareVersions,
  fetchLatestPackageVersion,
  installPackageVersion,
  type UpdateInstallAttemptResult,
} from "./cli-runtime"
import { repairBunGlobalManifest } from "./nightly"
import { hasCommand } from "./process-utils"

// The fork's release-candidate channel. RC builds are not published to npm —
// `.github/workflows/rc-release.yml` packs the built checkout and attaches the
// tarball to a prerelease GitHub Release, and this module is the client half:
// it resolves the newest release and installs its asset globally.
//
// Everything here is fork-only. Keeping it in its own module (rather than
// threading rc cases through cli-runtime.ts) is deliberate — it keeps merges
// from upstream conflict-free.

export const RC_RELEASE_REPO = "anglinb/kanna"

/** Release tags are exactly `v<version>`; the workflow enforces the same shape. */
const RC_TAG_PATTERN = /^v(\d+\.\d+\.\d+-rc\.(\d+))$/

const GITHUB_API_ORIGIN = "https://api.github.com"

/**
 * Opt-in only. A token raises the unauthenticated rate limit and would let the
 * channel keep working if the fork ever goes private, but ambient GITHUB_TOKEN
 * / GH_TOKEN are deliberately *not* read — a credential the user set up for
 * something else shouldn't ride along on Kanna's update check.
 */
const RC_TOKEN_ENV_VAR = "KANNA_RC_GITHUB_TOKEN"

export function rcTag(version: string) {
  return `v${version}`
}

/**
 * `bun pm pack` names a scoped tarball `<scope>-<name>-<version>.tgz`. The
 * asset name and the tag both follow from the version, so installing needs no
 * extra API round trip — which is what lets the installer stay synchronous
 * and match the `installVersion` shape the CLI and UpdateManager already use.
 */
export function rcTarballAssetName(version: string) {
  return `${RC_PACKAGE_NAME.replace(/^@/, "").replace("/", "-")}-${version}.tgz`
}

export function rcTarballUrl(version: string) {
  return `https://github.com/${RC_RELEASE_REPO}/releases/download/${rcTag(version)}/${rcTarballAssetName(version)}`
}

/** The version inside an RC tag, or null when the tag isn't one of ours. */
export function parseRcTag(tag: string): string | null {
  return RC_TAG_PATTERN.exec(tag.trim())?.[1] ?? null
}

/** Highest RC version among the given tags, ignoring anything else. */
export function pickLatestRcVersion(tags: readonly string[]): string | null {
  let latest: string | null = null
  for (const tag of tags) {
    const version = parseRcTag(tag)
    if (!version) continue
    if (latest === null || compareVersions(latest, version) < 0) latest = version
  }
  return latest
}

/**
 * The next RC version for a base release: `0.66.0` plus the RC counter that
 * hasn't been used yet. The counter restarts whenever the base version moves,
 * so the fork's package.json keeps upstream's version verbatim and never
 * conflicts on a merge — the release workflow stamps the RC version at build
 * time instead of committing it.
 */
export function nextRcVersion(baseVersion: string, existingTags: readonly string[]): string {
  const base = baseVersion.trim().replace(/^v/i, "").split("+")[0]!.split("-")[0]!
  let highest = 0
  for (const tag of existingTags) {
    const match = RC_TAG_PATTERN.exec(tag.trim())
    if (!match) continue
    // Only candidates for this same base release advance the counter.
    if (!match[1]!.startsWith(`${base}-rc.`)) continue
    highest = Math.max(highest, Number.parseInt(match[2]!, 10))
  }
  return `${base}-rc.${highest + 1}`
}

interface GitHubRelease {
  tag_name?: unknown
  draft?: unknown
}

function githubHeaders(env: NodeJS.ProcessEnv = process.env): Record<string, string> {
  const token = env[RC_TOKEN_ENV_VAR]?.trim()
  return {
    Accept: "application/vnd.github+json",
    "User-Agent": "kanna",
    ...(token ? { Authorization: `Bearer ${token}` } : {}),
  }
}

/**
 * Newest published RC. This lists releases rather than reading
 * `/releases/latest`, because that endpoint skips prereleases and every RC is
 * published as one.
 */
export async function fetchLatestRcVersion(fetchImpl: typeof fetch = fetch): Promise<string> {
  const response = await fetchImpl(`${GITHUB_API_ORIGIN}/repos/${RC_RELEASE_REPO}/releases?per_page=100`, {
    headers: githubHeaders(),
  })
  if (!response.ok) {
    throw new Error(`GitHub returned ${response.status} listing ${RC_RELEASE_REPO} releases`)
  }

  const payload = await response.json() as GitHubRelease[]
  if (!Array.isArray(payload)) {
    throw new Error("GitHub did not return a list of releases")
  }

  const tags = payload
    .filter((release) => release.draft !== true)
    .map((release) => (typeof release.tag_name === "string" ? release.tag_name : ""))
  const latest = pickLatestRcVersion(tags)
  if (!latest) {
    throw new Error(`no release candidates have been published to ${RC_RELEASE_REPO} yet`)
  }
  return latest
}

export interface RcInstallDeps {
  run?: (command: string, args: string[]) => { ok: boolean; output: string }
  hasCommandImpl?: (command: string) => boolean
  repairGlobalManifest?: () => boolean
  /** Version recorded in bun's global manifest for the RC package, if any. */
  readInstalledVersion?: () => string | null
  log?: (message: string) => void
}

function runSync(command: string, args: string[]): { ok: boolean; output: string } {
  const result = spawnSync(command, args, { stdio: ["ignore", "pipe", "pipe"], encoding: "utf8" })
  const stdout = result.stdout ?? ""
  const stderr = result.stderr ?? ""
  if (stdout) process.stdout.write(stdout)
  if (stderr) process.stderr.write(stderr)
  return { ok: result.status === 0, output: `${stdout}\n${stderr}` }
}

function bunGlobalDir(): string {
  return process.env.BUN_INSTALL || path.join(homedir(), ".bun")
}

function readInstalledRcVersion(): string | null {
  try {
    const manifestPath = path.join(
      bunGlobalDir(), "install", "global", "node_modules", RC_PACKAGE_NAME, "package.json",
    )
    return (JSON.parse(readFileSync(manifestPath, "utf8")) as { version?: string }).version ?? null
  } catch {
    return null
  }
}

function installFailure(userMessage: string): UpdateInstallAttemptResult {
  return { ok: false, errorCode: "install_failed", userTitle: "Update failed", userMessage }
}

/**
 * Install an RC build from its release asset.
 *
 * Bun cannot move a global entry from one tarball spec to another in place —
 * it aborts with DependencyLoop and leaves the old build installed — so the
 * existing entry is removed first. That makes a failed install worse than
 * usual (the machine would be left with no `kanna-rc` at all), hence the
 * rollback to whatever version was installed before.
 */
export function installRcVersion(version: string, deps: RcInstallDeps = {}): UpdateInstallAttemptResult {
  const run = deps.run ?? runSync
  const log = deps.log ?? (() => {})

  if (!(deps.hasCommandImpl ?? hasCommand)("bun")) {
    return {
      ok: false,
      errorCode: "command_missing",
      userTitle: "Bun not found",
      userMessage: "Kanna could not find Bun to install the update.",
    }
  }

  // Same corrupt-manifest hazard the stable and nightly installers heal.
  ;(deps.repairGlobalManifest ?? repairBunGlobalManifest)()

  const readInstalled = deps.readInstalledVersion ?? readInstalledRcVersion
  const previousVersion = readInstalled()

  // The entry may not exist yet, so a failed remove is expected and ignored.
  run("bun", ["remove", "-g", RC_PACKAGE_NAME])

  const rollback = (message: string): UpdateInstallAttemptResult => {
    if (!previousVersion) return installFailure(message)
    const restored = run("bun", ["install", "-g", rcTarballUrl(previousVersion)])
    return installFailure(restored.ok
      ? `${message} Reinstalled ${previousVersion}.`
      : `${message} Restoring ${previousVersion} also failed — run \`bun install -g ${rcTarballUrl(previousVersion)}\` to recover.`)
  }

  const install = run("bun", ["install", "-g", rcTarballUrl(version)])
  if (!install.ok) {
    const classified = classifyInstallVersionFailure(install.output)
    const rolledBack = rollback(classified.userMessage ?? "Kanna could not install the release candidate.")
    return { ...rolledBack, errorCode: classified.errorCode }
  }

  // `bun install -g` can exit 0 without actually replacing the package, so
  // trust only what the installed manifest reports.
  const installedVersion = readInstalled()
  if (installedVersion !== version) {
    return rollback(`The install finished but the global package reports ${installedVersion ?? "no version"} instead of ${version}.`)
  }

  log(`${LOG_PREFIX} installed ${RC_PACKAGE_NAME}@${version}`)
  return { ok: true, errorCode: null, userTitle: null, userMessage: null }
}

export interface ReleaseChannel {
  fetchLatestVersion: (packageName: string) => Promise<string>
  installVersion: (packageName: string, version: string) => UpdateInstallAttemptResult
}

/**
 * The update channel for the running profile: npm for stable, the fork's
 * GitHub Releases for rc. Both keep the `(packageName, version)` shape the CLI
 * and UpdateManager already pass around, so only the wiring in cli.ts differs.
 */
export function getReleaseChannel(profile: RuntimeProfile = getRuntimeProfile()): ReleaseChannel {
  if (profile !== "rc") {
    return { fetchLatestVersion: fetchLatestPackageVersion, installVersion: installPackageVersion }
  }
  return {
    fetchLatestVersion: () => fetchLatestRcVersion(),
    installVersion: (_packageName, version) => installRcVersion(version, { log: console.log }),
  }
}
