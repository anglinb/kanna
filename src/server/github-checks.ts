import type { ChatCommitChecks, ChatCommitChecksState } from "../shared/types"
import { resolveCommandPath } from "./process-utils"

/** Runs one `gh api graphql` query. Injected in tests so they never spawn `gh`. */
export type GraphqlRunner = (query: string) => Promise<{ stdout: string; exitCode: number }>

interface CheckRunNode {
  __typename?: string
  conclusion?: string | null
  status?: string | null
  detailsUrl?: string | null
  checkSuite?: { workflowRun?: { url?: string | null } | null } | null
  state?: string | null
  targetUrl?: string | null
}

interface CommitNode {
  oid?: string
  statusCheckRollup?: {
    state?: string | null
    contexts?: {
      totalCount?: number
      nodes?: CheckRunNode[]
    } | null
  } | null
}

interface CacheEntry {
  fetchedAt: number
  checks: ChatCommitChecks | null
}

/** A running workflow changes state fast, so it is re-read often. */
const PENDING_TTL_MS = 15_000
/** A finished rollup only changes when someone re-runs a job. */
const SETTLED_TTL_MS = 5 * 60_000
/** A commit with no checks may still be waiting for a workflow to start. */
const NO_CHECKS_TTL_MS = 2 * 60_000
/** How long to stay quiet after `gh` fails, so a logged-out user is not polled. */
const UNAVAILABLE_TTL_MS = 5 * 60_000
/** The History tab shows 20 commits; one query covers all of them. */
const MAX_COMMITS_PER_QUERY = 20
const MAX_CACHE_ENTRIES = 500

const REPO_SLUG_PATTERN = /^[A-Za-z0-9._-]+\/[A-Za-z0-9._-]+$/u
const SHA_PATTERN = /^[0-9a-f]{7,40}$/u

/**
 * Only a real success counts, which is what GitHub itself shows: a commit with
 * three passing jobs and one skipped job reads "3 / 4" there too.
 */
const PASSING_CONCLUSIONS = new Set(["SUCCESS"])

async function runGhGraphql(query: string) {
  // Resolve gh through a login shell so servers started without the user's
  // PATH still find it — the same treatment every other gh caller uses.
  const process = Bun.spawn([resolveCommandPath("gh") ?? "gh", "api", "graphql", "-f", `query=${query}`], {
    stdout: "pipe",
    stderr: "ignore",
  })
  const [stdout, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    process.exited,
  ])
  return { stdout, exitCode }
}

function buildQuery(owner: string, name: string, shas: string[]) {
  const objects = shas
    .map((sha, index) => `c${index}: object(oid: "${sha}") { ...checks }`)
    .join("\n")

  return `query {
  repository(owner: "${owner}", name: "${name}") {
${objects}
  }
}
fragment checks on Commit {
  oid
  statusCheckRollup {
    state
    contexts(first: 100) {
      totalCount
      nodes {
        __typename
        ... on CheckRun {
          conclusion
          status
          detailsUrl
          checkSuite { workflowRun { url } }
        }
        ... on StatusContext {
          state
          targetUrl
        }
      }
    }
  }
}`
}

function readRollupState(state: string | null | undefined): ChatCommitChecksState {
  if (state === "SUCCESS") return "success"
  if (state === "FAILURE" || state === "ERROR") return "failure"
  return "pending"
}

function nodePassed(node: CheckRunNode) {
  if (node.conclusion) return PASSING_CONCLUSIONS.has(node.conclusion)
  return node.state === "SUCCESS"
}

function nodeFailed(node: CheckRunNode) {
  if (node.conclusion) return node.conclusion === "FAILURE" || node.conclusion === "TIMED_OUT" || node.conclusion === "CANCELLED"
  return node.state === "FAILURE" || node.state === "ERROR"
}

/**
 * Prefers the Actions run page over a single job page, because that is the
 * view a reader wants: every job of the run, with the failing one expanded.
 */
function nodeUrl(node: CheckRunNode) {
  return node.checkSuite?.workflowRun?.url || node.detailsUrl || node.targetUrl || undefined
}

function summarizeCommit(commit: CommitNode | null | undefined): ChatCommitChecks | null {
  const rollup = commit?.statusCheckRollup
  if (!rollup) return null

  const nodes = rollup.contexts?.nodes?.filter(Boolean) ?? []
  const total = rollup.contexts?.totalCount ?? nodes.length
  if (total === 0) return null

  const state = readRollupState(rollup.state)
  const passed = nodes.filter(nodePassed).length
  // On failure the first broken job is the one worth opening; otherwise any
  // run of the commit leads to the same Actions page.
  const preferred = state === "failure" ? nodes.find((node) => nodeFailed(node) && nodeUrl(node)) : undefined
  const url = nodeUrl(preferred ?? nodes.find((node) => nodeUrl(node)) ?? {})

  return { state, passed, total, url }
}

function ttlFor(checks: ChatCommitChecks | null) {
  if (!checks) return NO_CHECKS_TTL_MS
  return checks.state === "pending" ? PENDING_TTL_MS : SETTLED_TTL_MS
}

/**
 * Caches GitHub check rollups per commit.
 *
 * Reads never wait on the network. The git snapshot refresh asks for what the
 * cache holds and the store fetches stale commits in the background, so check
 * counts land on the next snapshot poll instead of slowing every refresh.
 */
export class CommitChecksStore {
  private readonly entries = new Map<string, CacheEntry>()
  private readonly inFlight = new Set<string>()
  private unavailableUntil = 0
  private readonly runGraphql: GraphqlRunner
  private readonly now: () => number

  constructor(deps: { runGraphql?: GraphqlRunner; now?: () => number } = {}) {
    this.runGraphql = deps.runGraphql ?? runGhGraphql
    this.now = deps.now ?? (() => Date.now())
  }

  read(repoSlug: string, shas: string[]): Map<string, ChatCommitChecks> {
    const known = new Map<string, ChatCommitChecks>()
    if (!REPO_SLUG_PATTERN.test(repoSlug)) return known

    const now = this.now()
    const stale: string[] = []

    for (const sha of shas.slice(0, MAX_COMMITS_PER_QUERY)) {
      if (!SHA_PATTERN.test(sha)) continue
      const entry = this.entries.get(this.cacheKey(repoSlug, sha))
      if (entry?.checks) {
        known.set(sha, entry.checks)
      }
      if (!entry || now - entry.fetchedAt >= ttlFor(entry.checks)) {
        stale.push(sha)
      }
    }

    if (stale.length > 0 && now >= this.unavailableUntil && !this.inFlight.has(repoSlug)) {
      this.inFlight.add(repoSlug)
      void this.refresh(repoSlug, stale).finally(() => this.inFlight.delete(repoSlug))
    }

    return known
  }

  /** Fetches one batch and stores it. Public so tests can await a fetch. */
  async refresh(repoSlug: string, shas: string[]): Promise<void> {
    const [owner, name] = repoSlug.split("/")
    const wanted = shas.filter((sha) => SHA_PATTERN.test(sha)).slice(0, MAX_COMMITS_PER_QUERY)
    if (!owner || !name || wanted.length === 0) return

    let result: Awaited<ReturnType<GraphqlRunner>>
    try {
      result = await this.runGraphql(buildQuery(owner, name, wanted))
    } catch {
      this.unavailableUntil = this.now() + UNAVAILABLE_TTL_MS
      return
    }

    if (result.exitCode !== 0) {
      // A private repo, a rate limit, or no `gh` login all land here. Backing
      // off keeps the History tab from spawning gh every five seconds.
      this.unavailableUntil = this.now() + UNAVAILABLE_TTL_MS
      return
    }

    let repository: Record<string, CommitNode | null> | undefined
    try {
      repository = JSON.parse(result.stdout)?.data?.repository
    } catch {
      this.unavailableUntil = this.now() + UNAVAILABLE_TTL_MS
      return
    }
    if (!repository) return

    const fetchedAt = this.now()
    wanted.forEach((sha, index) => {
      this.store(this.cacheKey(repoSlug, sha), {
        fetchedAt,
        checks: summarizeCommit(repository[`c${index}`]),
      })
    })
  }

  private cacheKey(repoSlug: string, sha: string) {
    return `${repoSlug}\n${sha}`
  }

  private store(key: string, entry: CacheEntry) {
    this.entries.delete(key)
    this.entries.set(key, entry)
    while (this.entries.size > MAX_CACHE_ENTRIES) {
      const oldest = this.entries.keys().next()
      if (oldest.done) break
      this.entries.delete(oldest.value)
    }
  }
}
