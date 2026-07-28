/**
 * Utilities for detecting and parsing GitHub/GitLab clone URLs.
 */

const GIT_URL_PATTERNS = [
  // HTTPS: https://github.com/owner/repo or https://github.com/owner/repo.git
  /^https?:\/\/(github\.com|gitlab\.com)\/([^/]+)\/([^/.]+?)(?:\.git)?\/?$/,
  // SSH: git@github.com:owner/repo.git
  /^git@(github\.com|gitlab\.com):([^/]+)\/([^/.]+?)(?:\.git)?\/?$/,
]

export interface ParsedGitUrl {
  host: string
  owner: string
  repo: string
  url: string
}

/**
 * Parse a GitHub/GitLab URL into its components.
 * Returns null if the input isn't a valid git repo URL.
 */
export function parseGitRepoUrl(input: string): ParsedGitUrl | null {
  const trimmed = input.trim()
  for (const pattern of GIT_URL_PATTERNS) {
    const match = trimmed.match(pattern)
    if (match) {
      return {
        host: match[1]!,
        owner: match[2]!,
        repo: match[3]!,
        url: trimmed,
      }
    }
  }
  return null
}

/** A remote resolved to somewhere a browser can go. */
export interface RepoBrowseTarget {
  /** `https://host/owner/repo` — no `.git`, no credentials, no port. */
  url: string
  /** Bare hostname, so a caller can name the forge it's about to open. */
  host: string
}

/**
 * Turn an `origin` remote into the page a human would open for that repo.
 *
 * Host-agnostic on purpose, unlike the GitHub-only slug extractor the git panel
 * uses: the same shape addresses GitHub, GitLab, Gitea and self-hosted, and a
 * link that works everywhere beats one that silently does nothing on a repo
 * that isn't on github.com. What it will *not* do is guess — a remote with no
 * host (`/srv/git/widgets.git`) or no `owner/repo` shape has no browse page,
 * and returning null lets the caller drop the action rather than offer a
 * 404.
 *
 * Always emits `https` regardless of how the remote is cloned; `git@` and
 * `ssh://` are transports, not addresses you can hand to a browser.
 */
export function buildRepoBrowseUrl(remoteUrl: string | undefined | null): RepoBrowseTarget | null {
  if (!remoteUrl) return null
  const trimmed = remoteUrl.trim()
  if (!trimmed) return null

  // `git@host:owner/repo.git` — scp syntax, which is not a parseable URL.
  const scp = /^[^/@]+@(?<host>[^/:]+):(?<path>.+)$/u.exec(trimmed)
  let host = scp?.groups?.host
  let rawPath = scp?.groups?.path
  if (rawPath === undefined) {
    try {
      const parsed = new URL(trimmed)
      // `hostname`, not `host`: an ssh port has no meaning over https.
      host = parsed.hostname
      rawPath = parsed.pathname
    } catch {
      return null
    }
  }
  if (!host) return null

  const segments = rawPath.replace(/\.git$/u, "").split("/").filter((segment) => segment.length > 0)
  if (segments.length < 2) return null
  return { url: `https://${host}/${segments.join("/")}`, host }
}

/**
 * What to call the place a repo lives, for a menu item that opens it.
 *
 * Named forges get their brand — "Open on GitHub" is the phrase people reach
 * for. Anything else gets its hostname rather than a generic "remote": on a
 * self-hosted forge the host *is* the recognisable name.
 */
export function getRepoHostLabel(host: string): string {
  const normalized = host.toLowerCase().replace(/^www\./u, "")
  if (normalized === "github.com") return "GitHub"
  if (normalized === "gitlab.com") return "GitLab"
  if (normalized === "bitbucket.org") return "Bitbucket"
  return normalized
}

/**
 * The same label straight from a browse URL, for menu items that hold the URL
 * rather than the host. Falls back to a neutral name so a menu never claims
 * "GitHub" about something it couldn't read.
 */
export function getRepoUrlLabel(repoUrl: string | undefined | null): string {
  if (!repoUrl) return "Remote Repo"
  try {
    return getRepoHostLabel(new URL(repoUrl).hostname)
  } catch {
    return "Remote Repo"
  }
}

/**
 * Normalize a git repo URL to HTTPS format for cloning.
 */
export function toCloneUrl(input: string): string {
  const parsed = parseGitRepoUrl(input)
  if (!parsed) return input.trim()
  return `https://${parsed.host}/${parsed.owner}/${parsed.repo}.git`
}
