import type { GitHubRecentReposResult, GitHubRepoSummary } from "../shared/types"
import { resolveCommandPath } from "./process-utils"
import { parseGhAccount } from "./provider-auth"

/**
 * Recent repositories for the signed-in `gh` user, across personal and all
 * org affiliations, for the command palette's Clone page. One API call,
 * already recency-sorted by GitHub; cached briefly so reopening the page
 * is instant.
 */

const REPO_LIST_LIMIT = 50
const CACHE_TTL_MS = 60_000

interface GhRepoResponse {
  full_name?: string
  description?: string | null
  pushed_at?: string | null
  private?: boolean
  owner?: { login?: string }
}

async function runCommand(args: string[]) {
  // Resolve gh through a login shell so servers launched without the user's
  // PATH (launchd/systemd) still find it — same treatment as provider-auth.
  const [command, ...rest] = args
  const argv = command === "gh" ? [resolveCommandPath("gh") ?? command, ...rest] : args
  const process = Bun.spawn(argv, {
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])

  return { stdout, stderr, exitCode }
}

export type CommandRunner = typeof runCommand

export interface GhAuthInfo {
  ghInstalled: boolean
  authenticated: boolean
  activeAccountLogin: string | undefined
}

/**
 * Auth state of the `gh` CLI — the single probe every gh consumer shares
 * (repos section, publish modal, PR checks).
 *
 * Prefers `gh auth status --json hosts` for the structured active-account
 * read, but that flag only exists in gh ≥ 2.81 (e.g. Ubuntu 24.04's apt
 * build is 2.45 and exits 1 with "unknown flag" even when signed in). Any
 * JSON-probe failure therefore falls back to the plain command, whose exit
 * code has always been the authoritative signal, with the account parsed
 * from its human output.
 */
export async function getGhAuthInfo(run: CommandRunner = runCommand): Promise<GhAuthInfo> {
  const versionResult = await run(["gh", "--version"])
  if (versionResult.exitCode !== 0) {
    return { ghInstalled: false, authenticated: false, activeAccountLogin: undefined }
  }

  const jsonResult = await run(["gh", "auth", "status", "--json", "hosts"])
  if (jsonResult.exitCode === 0) {
    try {
      const parsed = JSON.parse(jsonResult.stdout) as {
        hosts?: Record<string, Array<{ active?: boolean; login?: string; state?: string }>>
      }
      const accounts = parsed.hosts?.["github.com"] ?? []
      const activeAccount = accounts.find((account) => account.active) ?? accounts[0]
      return {
        ghInstalled: true,
        authenticated: activeAccount?.state === "success",
        activeAccountLogin: activeAccount?.login,
      }
    } catch {
      // Unparseable JSON — fall through to the plain probe.
    }
  }

  const plainResult = await run(["gh", "auth", "status"])
  if (plainResult.exitCode !== 0) {
    return { ghInstalled: true, authenticated: false, activeAccountLogin: undefined }
  }
  return {
    ghInstalled: true,
    authenticated: true,
    activeAccountLogin:
      parseGhAccount(`${plainResult.stdout}\n${plainResult.stderr}`) ?? undefined,
  }
}

async function getActiveGhLogin(run: CommandRunner): Promise<string | null> {
  const info = await getGhAuthInfo(run)
  if (!info.ghInstalled || !info.authenticated) return null
  return info.activeAccountLogin ?? ""
}

function toRepoSummary(repo: GhRepoResponse): GitHubRepoSummary | null {
  if (!repo.full_name) return null
  return {
    nameWithOwner: repo.full_name,
    description: repo.description ?? null,
    pushedAt: repo.pushed_at ?? null,
    isPrivate: repo.private === true,
    owner: repo.owner?.login ?? repo.full_name.split("/")[0] ?? "",
  }
}

let cache: { result: GitHubRecentReposResult; expiresAt: number } | null = null
let inFlight: Promise<GitHubRecentReposResult> | null = null

/**
 * List the user's most recently pushed repos (personal + collaborator + org),
 * flat and recency-sorted. Never throws: a missing or unauthenticated `gh`
 * yields `{ available: false, repos: [] }`.
 */
export async function listRecentGitHubRepos(
  options?: { run?: CommandRunner; force?: boolean; nowMs?: number }
): Promise<GitHubRecentReposResult> {
  const now = options?.nowMs ?? Date.now()
  if (!options?.force && cache && cache.expiresAt > now) {
    return cache.result
  }
  if (inFlight) return inFlight

  const run = options?.run ?? runCommand
  inFlight = (async (): Promise<GitHubRecentReposResult> => {
    const login = await getActiveGhLogin(run)
    if (login === null) {
      return { available: false, repos: [] }
    }

    const listResult = await run([
      "gh",
      "api",
      `user/repos?sort=pushed&direction=desc&per_page=${REPO_LIST_LIMIT}&affiliation=owner,collaborator,organization_member`,
    ])
    if (listResult.exitCode !== 0) {
      // Authenticated but the API call failed (offline, scope issues) —
      // degrade to "unavailable" rather than surfacing an error.
      return { available: false, login: login || undefined, repos: [] }
    }

    try {
      const parsed = JSON.parse(listResult.stdout) as GhRepoResponse[]
      const repos = (Array.isArray(parsed) ? parsed : [])
        .map(toRepoSummary)
        .filter((repo): repo is GitHubRepoSummary => repo !== null)
        .slice(0, REPO_LIST_LIMIT)
      return { available: true, login: login || undefined, repos }
    } catch {
      return { available: false, login: login || undefined, repos: [] }
    }
  })()

  try {
    const result = await inFlight
    cache = { result, expiresAt: now + CACHE_TTL_MS }
    return result
  } finally {
    inFlight = null
  }
}

/**
 * Drop the module-level cache — called when GitHub auth changes (e.g. the
 * setup wizard just signed `gh` in) so a cached "unauthenticated" result
 * doesn't outlive the sign-in. Also used by tests.
 */
export function clearGitHubRepoCache() {
  cache = null
}
