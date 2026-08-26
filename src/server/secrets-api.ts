/**
 * Loopback HTTP surface for `kanna ask-secret`.
 *
 * Mounted under `/__local/secrets` and reachable only when the request class
 * is `local` (see server.ts) — never through the kanna.sh proxy and never
 * over the raw tunnel. On top of that it requires the per-start token from
 * `~/.kanna/instance.json`, so another user's process on the same box cannot
 * queue a prompt in your UI.
 *
 * Deliberately not under `/api/`: that prefix is gated by the browser session
 * cookie, which a CLI invocation does not have.
 */

import { timingSafeEqual } from "node:crypto"
import path from "node:path"
import {
  buildSecretLoadCommand,
  isValidSecretName,
  SECRET_REASON_MAX_LENGTH,
  SECRETS_API_PATH_PREFIX,
  SECRETS_API_TOKEN_HEADER,
  type SecretScope,
} from "../shared/secrets"
import { findExistingSecret, listSecrets } from "./secrets"
import type { SecretRequestStore } from "./secret-requests"

export interface ResolvedProject {
  path: string
  title: string
}

export interface SecretsApiDeps {
  requests: SecretRequestStore
  token: string
  /** Map the CLI's cwd onto a known Kanna project, if it sits inside one. */
  resolveProject: (cwd: string) => ResolvedProject | null
}

function tokenMatches(provided: string | null, expected: string): boolean {
  if (!provided) return false
  const a = Buffer.from(provided)
  const b = Buffer.from(expected)
  if (a.length !== b.length) return false
  return timingSafeEqual(a, b)
}

function badRequest(message: string) {
  return Response.json({ error: message }, { status: 400 })
}

/**
 * Walk up from `cwd` so an agent working in a subdirectory still resolves to
 * its project. Deepest match wins when projects are nested.
 */
export function resolveProjectFromCwd(
  cwd: string,
  projects: ResolvedProject[],
): ResolvedProject | null {
  const resolved = path.resolve(cwd)
  let best: ResolvedProject | null = null

  for (const project of projects) {
    const root = path.resolve(project.path)
    const inside = resolved === root || resolved.startsWith(`${root}${path.sep}`)
    if (!inside) continue
    if (!best || root.length > path.resolve(best.path).length) {
      best = project
    }
  }

  return best
}

/**
 * Returns null when the path is not ours, so the caller can fall through to
 * the rest of its routing table.
 */
export function createSecretsApi(deps: SecretsApiDeps) {
  return async function handleSecretsRequest(req: Request, url: URL): Promise<Response | null> {
    if (
      url.pathname !== SECRETS_API_PATH_PREFIX
      && !url.pathname.startsWith(`${SECRETS_API_PATH_PREFIX}/`)
    ) {
      return null
    }

    if (!tokenMatches(req.headers.get(SECRETS_API_TOKEN_HEADER), deps.token)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 })
    }

    const subPath = url.pathname.slice(SECRETS_API_PATH_PREFIX.length)

    if (subPath === "/requests" && req.method === "POST") {
      return handleCreate(req, deps)
    }

    const requestMatch = subPath.match(/^\/requests\/([^/]+)$/)
    if (requestMatch) {
      const id = decodeURIComponent(requestMatch[1])
      if (req.method === "GET") {
        return Response.json(deps.requests.resolutionFor(id))
      }
      if (req.method === "DELETE") {
        deps.requests.cancel(id)
        return Response.json({ ok: true })
      }
      return new Response(null, { status: 405, headers: { Allow: "GET, DELETE" } })
    }

    if (subPath === "/list" && req.method === "GET") {
      const cwd = url.searchParams.get("cwd") ?? process.cwd()
      const project = deps.resolveProject(cwd)
      const secrets = await listSecrets(project?.path ?? null)
      return Response.json({
        secrets: secrets.map(({ scope, name }) => ({ scope, name })),
      })
    }

    return Response.json({ error: "Not found" }, { status: 404 })
  }
}

async function handleCreate(req: Request, deps: SecretsApiDeps): Promise<Response> {
  let body: Record<string, unknown>
  try {
    body = (await req.json()) as Record<string, unknown>
  } catch {
    return badRequest("Body must be JSON")
  }

  const name = typeof body.name === "string" ? body.name.trim() : ""
  if (!isValidSecretName(name)) {
    return badRequest(
      "Invalid secret name — use letters, digits and underscores, starting with a letter or underscore (e.g. OPENAI_API_KEY)",
    )
  }

  const reason = typeof body.reason === "string" ? body.reason.trim().slice(0, SECRET_REASON_MAX_LENGTH) : ""
  const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : process.cwd()
  const force = body.force === true
  const suggestedScope: SecretScope | null =
    body.scope === "project" || body.scope === "global" ? body.scope : null

  const project = deps.resolveProject(cwd)

  // Already stored? Hand back the load command without interrupting anyone —
  // an agent re-running the same ask on a later turn is the common case.
  if (!force) {
    const existing = await findExistingSecret(name, project?.path ?? null)
    if (existing) {
      return Response.json({
        status: "saved",
        existing: true,
        scope: existing.scope,
        path: existing.path,
        loadCommand: buildSecretLoadCommand(existing.path),
      })
    }
  }

  const request = deps.requests.create({
    name,
    reason,
    cwd,
    projectPath: project?.path ?? null,
    projectTitle: project?.title ?? null,
    suggestedScope,
  })

  return Response.json({ status: "pending", requestId: request.id })
}
