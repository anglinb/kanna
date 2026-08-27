/**
 * Loopback HTTP surface for `kanna remind`.
 *
 * Mounted under `/__local/reminders` with the same guarantees as the secrets
 * and pull-requests APIs: reachable only when the request class is `local`, and
 * gated on the per-start instance token from `~/.kanna/instance.json`.
 * Deliberately not under `/api/`, which is gated by the browser session cookie
 * a CLI invocation does not have.
 *
 * Relative delays are resolved here rather than in the CLI. Both sides are the
 * same machine over loopback, so it costs nothing and keeps one clock in play.
 */

import { timingSafeEqual } from "node:crypto"
import {
  normalizeReminderPrompt,
  REMINDERS_API_PATH_PREFIX,
  REMINDERS_API_TOKEN_HEADER,
  resolveReminderDueAt,
} from "../shared/reminders"

export interface RemindersApiDeps {
  token: string
  /** Which chat is asking — `resolveAskingChat`, shared with the secrets API. */
  resolveChat: (args: { cwd: string; claimedChatId: string | null }) => string | null
  setReminder: (chatId: string, args: { dueAt: number; prompt?: string }) => Promise<void>
  clearReminder: (chatId: string) => Promise<void>
  /** A reminder was scheduled or cancelled — re-push the sidebar. */
  onChanged: () => void
  now?: () => number
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

export function createRemindersApi(deps: RemindersApiDeps) {
  return async function handleRemindersRequest(req: Request, url: URL): Promise<Response | null> {
    if (
      url.pathname !== REMINDERS_API_PATH_PREFIX
      && !url.pathname.startsWith(`${REMINDERS_API_PATH_PREFIX}/`)
    ) {
      return null
    }

    if (!tokenMatches(req.headers.get(REMINDERS_API_TOKEN_HEADER), deps.token)) {
      return Response.json({ error: "Unauthorized" }, { status: 401 })
    }

    const subPath = url.pathname.slice(REMINDERS_API_PATH_PREFIX.length)
    if (subPath !== "/set" && subPath !== "/clear") {
      return Response.json({ error: "Not found" }, { status: 404 })
    }
    if (req.method !== "POST") {
      return new Response(null, { status: 405, headers: { Allow: "POST" } })
    }

    let body: Record<string, unknown>
    try {
      body = (await req.json()) as Record<string, unknown>
    } catch {
      return badRequest("Body must be JSON")
    }

    const cwd = typeof body.cwd === "string" && body.cwd.trim() ? body.cwd : process.cwd()
    const claimedChatId = typeof body.chatId === "string" && body.chatId.trim()
      ? body.chatId.trim()
      : null
    const chatId = deps.resolveChat({ cwd, claimedChatId })
    if (!chatId) {
      return badRequest(
        "Could not tell which chat this belongs to. Pass --chat <id>, or run the command from "
        + "inside the project directory of a running chat.",
      )
    }

    if (subPath === "/clear") {
      await deps.clearReminder(chatId)
      deps.onChanged()
      return Response.json({ ok: true, cleared: true })
    }

    const now = deps.now?.() ?? Date.now()
    const resolved = resolveReminderDueAt({
      now,
      in: typeof body.in === "string" ? body.in : null,
      at: typeof body.at === "string" || typeof body.at === "number" ? body.at : null,
      dueAt: typeof body.dueAt === "number" ? body.dueAt : null,
    })
    if (!resolved.ok) return badRequest(resolved.error)

    const prompt = normalizeReminderPrompt(
      typeof body.prompt === "string" ? body.prompt : null,
    )

    await deps.setReminder(chatId, {
      dueAt: resolved.dueAt,
      ...(prompt ? { prompt } : {}),
    })
    deps.onChanged()

    return Response.json({
      ok: true,
      dueAt: resolved.dueAt,
      delayMs: resolved.dueAt - now,
      ...(prompt ? { prompt } : {}),
    })
  }
}
