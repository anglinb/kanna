import { useEffect, useMemo, useState, type ReactNode } from "react"
import { Building2, GitBranch, Loader2, Lock, Search, User } from "lucide-react"
import type { GitHubRecentReposResult, GitHubRepoSummary } from "../../shared/types"
import type { KannaSocket } from "../app/socket"
import type { ProjectRequest } from "../app/kannaStateHelpers"
import { formatRelativeTime } from "../lib/formatters"
import { parseRepoRef, resolveCloneDestination } from "../lib/project-fs"
import { formatPathWithTilde } from "../lib/pathUtils"
import { groupByRecency } from "../lib/project-groups"
import { cn } from "../lib/utils"
import { useAuthService } from "../stores/providerAuthStore"
import { openCommandPalette } from "./command-palette/CommandPalette"
import { GitHubIcon } from "./provider-icons"
import { Button } from "./ui/button"
import { Tooltip, TooltipContent, TooltipTrigger } from "./ui/tooltip"

/**
 * Recent GitHub repos on the "/" home page, shown under Local Projects when
 * the `gh` CLI is signed in. Mirrors the local-projects recency buckets,
 * filters by account (personal/org) via pills, and clones a repo into the
 * new-projects directory on click — the same flow as the palette's Clone
 * page. Shows a shimmer while the list loads for a signed-in `gh`; renders
 * nothing when GitHub isn't connected.
 */

const ALL_ACCOUNTS = "all"

function compareReposAlphabetically(a: GitHubRepoSummary, b: GitHubRepoSummary) {
  return a.nameWithOwner.localeCompare(b.nameWithOwner, undefined, { sensitivity: "base" })
}

function repoPushedAtMs(repo: GitHubRepoSummary): number | undefined {
  if (!repo.pushedAt) return undefined
  const parsed = Date.parse(repo.pushedAt)
  return Number.isFinite(parsed) ? parsed : undefined
}

function AccountPill({
  label,
  icon,
  selected,
  onClick,
}: {
  label: string
  /** Personal/org marker rendered before the label (none for "All"). */
  icon?: ReactNode
  selected: boolean
  onClick: () => void
}) {
  return (
    <button
      type="button"
      aria-pressed={selected}
      onClick={onClick}
      className={cn(
        // Same footprint as the sm Button (h-9 px-3) so the pill row lines up
        // with the Search button beside it.
        "inline-flex h-9 items-center gap-1.5 rounded-full border px-3 text-xs transition-colors",
        selected
          ? "border-primary/40 bg-primary/10 text-foreground"
          : "border-border text-muted-foreground hover:bg-muted/50 hover:text-foreground"
      )}
    >
      {icon}
      {label}
    </button>
  )
}

/** Pulsing placeholder mirroring the section layout while repos load. */
function ReposShimmer() {
  return (
    <section aria-hidden className="mt-10">
      <h2 className="mb-4 flex items-center gap-2.5 text-xl font-semibold text-foreground">
        <GitHubIcon className="h-5 w-5 text-muted-foreground" />
        GitHub
      </h2>
      <div className="animate-pulse">
        <div className="mb-3 flex items-center">
          <div className="ml-auto h-9 w-24 rounded-md bg-muted" />
        </div>
        <div className="mb-3 h-4 w-24 rounded bg-muted" />
        <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-4 3xl:grid-cols-5">
          {[0, 1, 2, 3].map((card) => (
            <div
              key={card}
              className="flex items-center gap-3 rounded-lg border border-border bg-card px-4 py-3"
            >
              <div className="h-4 w-4 rounded-full bg-muted" />
              <div className={cn("h-4 rounded bg-muted", card % 2 === 0 ? "w-32" : "w-40")} />
            </div>
          ))}
        </div>
      </div>
    </section>
  )
}

function RepoCard({
  repo,
  destinationLabel,
  showOwner,
  loading,
  disabled,
  onClick,
}: {
  repo: GitHubRepoSummary
  destinationLabel: string
  showOwner: boolean
  loading: boolean
  disabled: boolean
  onClick: () => void
}) {
  const [owner, name] = repo.nameWithOwner.split("/") as [string, string | undefined]
  const ageLabel = repo.pushedAt ? formatRelativeTime(repo.pushedAt) : null

  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          className={cn(
            "border border-border hover:border-primary/30 group rounded-lg bg-card px-4 py-3 flex items-center gap-3 w-full text-left hover:bg-muted/50 transition-colors",
            (loading || disabled) && "opacity-50 cursor-not-allowed"
          )}
          disabled={loading || disabled}
          onClick={onClick}
        >
          {repo.isPrivate ? (
            <Lock className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          ) : (
            <GitBranch className="h-4 w-4 text-muted-foreground flex-shrink-0" />
          )}
          <span className="min-w-0 flex-1 truncate">
            {showOwner ? <span className="text-muted-foreground">{owner}/</span> : null}
            <span className="font-medium text-foreground">{name ?? repo.nameWithOwner}</span>
          </span>
          {loading ? (
            <Loader2 className="h-4 w-4 text-muted-foreground animate-spin flex-shrink-0" />
          ) : ageLabel ? (
            <span className="text-xs text-muted-foreground flex-shrink-0">{ageLabel}</span>
          ) : null}
        </button>
      </TooltipTrigger>
      <TooltipContent>
        <p>{repo.nameWithOwner}</p>
        {repo.description ? <p className="max-w-72 text-muted-foreground">{repo.description}</p> : null}
        <p className="text-muted-foreground">Clone to {destinationLabel}</p>
      </TooltipContent>
    </Tooltip>
  )
}

export function GitHubReposSection({
  socket,
  newProjectsDirectory,
  onCloneRepo,
}: {
  socket: KannaSocket
  newProjectsDirectory: string
  /** Runs the clone (kanna's create-project flow); navigates to the new chat on success. */
  onCloneRepo: (project: ProjectRequest) => Promise<void>
}) {
  const [result, setResult] = useState<GitHubRecentReposResult | null>(null)
  const [selectedAccount, setSelectedAccount] = useState<string>(ALL_ACCOUNTS)
  const [cloningRepo, setCloningRepo] = useState<string | null>(null)
  const [cloneError, setCloneError] = useState<string | null>(null)
  // Refetch whenever GitHub auth flips (e.g. the setup wizard just signed
  // `gh` in) so the section appears without a page reload.
  const ghAuthStatus = useAuthService("gh")?.authStatus

  useEffect(() => {
    let cancelled = false
    socket.command<GitHubRecentReposResult>({ type: "github.listRecentRepos" })
      .then((repos) => {
        if (!cancelled) setResult(repos)
      })
      .catch(() => {
        if (!cancelled) setResult({ available: false, repos: [] })
      })
    return () => {
      cancelled = true
    }
  }, [socket, ghAuthStatus])

  const repos = result?.available ? result.repos : []

  // Personal account first, then org/collaborator owners alphabetically.
  const accounts = useMemo(() => {
    const owners = new Set(repos.map((repo) => repo.owner).filter(Boolean))
    const login = result?.login
    const rest = [...owners]
      .filter((owner) => owner !== login)
      .sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }))
    return login && owners.has(login) ? [login, ...rest] : rest
  }, [repos, result?.login])

  const visibleRepos = useMemo(() => (
    selectedAccount === ALL_ACCOUNTS
      ? repos
      : repos.filter((repo) => repo.owner === selectedAccount)
  ), [repos, selectedAccount])

  const repoGroups = useMemo(
    () => groupByRecency(visibleRepos, repoPushedAtMs, compareReposAlphabetically),
    [visibleRepos]
  )

  // gh is signed in but the list hasn't arrived yet — hold the space with a
  // shimmer instead of popping the section in later. Signed-out (or unknown)
  // states keep rendering nothing.
  if (result === null) {
    return ghAuthStatus === "signed_in" ? <ReposShimmer /> : null
  }

  if (repos.length === 0) return null

  const cloneDestination = (repo: GitHubRepoSummary) => {
    const ref = parseRepoRef(repo.nameWithOwner)
    return ref ? resolveCloneDestination(newProjectsDirectory, ref) : null
  }

  const handleClone = async (repo: GitHubRepoSummary) => {
    if (cloningRepo !== null) return
    const ref = parseRepoRef(repo.nameWithOwner)
    if (!ref) return
    const destination = resolveCloneDestination(newProjectsDirectory, ref)
    setCloningRepo(repo.nameWithOwner)
    setCloneError(null)
    try {
      await onCloneRepo({
        mode: "clone",
        localPath: destination.localPath,
        fallbackPath: destination.fallbackPath,
        title: destination.title,
        cloneUrl: ref.cloneUrl,
      })
      // Success navigates away to the new project's chat.
    } catch (error) {
      setCloneError(error instanceof Error ? error.message : String(error))
    } finally {
      setCloningRepo(null)
    }
  }

  return (
    <section aria-labelledby="github-repos-heading" className="mt-10">
      <h2
        id="github-repos-heading"
        className="mb-4 flex items-center gap-2.5 text-xl font-semibold text-foreground"
      >
        <GitHubIcon className="h-5 w-5 text-muted-foreground" />
        GitHub
      </h2>
      <div className="mb-3 flex flex-wrap items-center gap-2">
        {accounts.length > 1 ? (
          <div className="flex flex-wrap items-center gap-1.5">
            <AccountPill
              label="All"
              selected={selectedAccount === ALL_ACCOUNTS}
              onClick={() => setSelectedAccount(ALL_ACCOUNTS)}
            />
            {accounts.map((account) => (
              <AccountPill
                key={account}
                label={account}
                icon={account === result?.login
                  ? <User className="h-3 w-3" aria-label="Personal account" />
                  : <Building2 className="h-3 w-3" aria-label="Organization" />}
                selected={selectedAccount === account}
                onClick={() => setSelectedAccount(account)}
              />
            ))}
          </div>
        ) : null}
        <Button
          variant="default"
          size="sm"
          aria-label="Search GitHub repositories"
          className="ml-auto gap-2"
          onClick={() => openCommandPalette("clone-github")}
        >
          <Search className="size-3.5" data-icon="inline-start" />
          {/* Icon-only on mobile — the label costs too much pill-row width. */}
          <span className="hidden sm:inline">Search</span>
        </Button>
      </div>

      <div className="flex flex-col gap-8">
        {repoGroups.map((group) => (
          <section key={group.key} aria-labelledby={`github-repo-group-${group.key}`}>
            <h3
              id={`github-repo-group-${group.key}`}
              className="mb-3 text-[13px] font-medium uppercase tracking-wider text-muted-foreground/70"
            >
              {group.title}
            </h3>
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-2 lg:grid-cols-3 xl:grid-cols-4 2xl:grid-cols-4 3xl:grid-cols-5">
              {group.items.map((repo) => {
                const destination = cloneDestination(repo)
                return (
                  <RepoCard
                    key={repo.nameWithOwner}
                    repo={repo}
                    destinationLabel={destination ? formatPathWithTilde(destination.localPath) : ""}
                    showOwner={selectedAccount === ALL_ACCOUNTS}
                    loading={cloningRepo === repo.nameWithOwner}
                    disabled={cloningRepo !== null && cloningRepo !== repo.nameWithOwner}
                    onClick={() => {
                      void handleClone(repo)
                    }}
                  />
                )
              })}
            </div>
          </section>
        ))}
      </div>

      {cloneError ? (
        <div className="mt-4 rounded-xl border border-destructive/20 bg-destructive/5 px-4 py-3 text-sm text-destructive">
          {cloneError}
        </div>
      ) : null}
    </section>
  )
}
