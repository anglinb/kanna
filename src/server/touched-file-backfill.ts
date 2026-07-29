import { LOG_PREFIX } from "../shared/branding"
import { readTreeBlobs, resolveWorkingTreeLocation, runGit } from "./diff-store"
import type { EventStore } from "./event-store"
import type { ChatRecord, TouchedFile } from "./events"

/**
 * One-time repair of claims recorded before base blobs existed.
 *
 * A chat that touched a file before this tracking has a path and nothing else,
 * which the sidebar reads as "no commit can settle this" — the old rule, kept
 * for those records so upgrading couldn't silently hide uncommitted work. Left
 * alone they never expire: the chat keeps returning to Relevant every time
 * anyone else dirties a file it once edited, which is the exact behaviour base
 * blobs exist to end.
 *
 * The missing base is recoverable. A chat's claim was made on top of whatever
 * `HEAD` held for that path when the chat last ran, so one `rev-list --before`
 * finds the commit the repo was at then, and one `ls-tree` reads every path off
 * it. Two git calls per chat, once, at boot.
 *
 * Approximate by construction — it reads the chat's *last* activity rather than
 * the turn that touched each path, and it can't know the chat was on another
 * branch. Both approximations fail toward a base that no longer matches, i.e.
 * toward retiring a claim; anything it can't resolve at all is left unknown,
 * which keeps today's behaviour rather than guessing.
 */

/** Where a chat was in time, for reconstructing what it edited from. */
function chatActivityAt(chat: ChatRecord): number | null {
  return chat.lastTurnEndedAt ?? chat.lastMessageAt ?? chat.updatedAt ?? null
}

function legacyPaths(chat: ChatRecord): string[] {
  return (chat.touchedFiles ?? [])
    .filter((file) => file.baseBlob === undefined)
    .map((file) => file.path)
}

/**
 * The commit the repo was at when the chat last ran, or `null` when nothing was
 * committed by then (every path's base is genuinely "not committed").
 * `undefined` means the question couldn't be answered and the claim should stay
 * unknown.
 */
async function commitAsOf(repoRoot: string, atMs: number): Promise<string | null | undefined> {
  const listed = await runGit(
    ["rev-list", "-1", `--before=${new Date(atMs).toISOString()}`, "HEAD"],
    repoRoot
  )
  if (listed.exitCode !== 0) return undefined
  return listed.stdout.trim() || null
}

export interface TouchedFileBackfillResult {
  /** Chats whose claims were stamped with a base. */
  chats: number
  /** Individual paths given a base. */
  files: number
}

/**
 * Stamps every legacy claim it can resolve, in place, through the store's
 * normal `chat_files_touched` path — so the repair is an event like any other
 * and survives restart without a second pass.
 */
export async function backfillTouchedFileBases(
  store: EventStore,
  options?: { onProgress?: (message: string) => void }
): Promise<TouchedFileBackfillResult> {
  const pending = new Map<string, ChatRecord[]>()
  for (const chat of store.state.chatsById.values()) {
    if (chat.deletedAt || legacyPaths(chat).length === 0) continue
    const project = store.state.projectsById.get(chat.projectId)
    if (!project || project.deletedAt) continue
    const forProject = pending.get(chat.projectId)
    if (forProject) forProject.push(chat)
    else pending.set(chat.projectId, [chat])
  }
  if (pending.size === 0) return { chats: 0, files: 0 }

  const result: TouchedFileBackfillResult = { chats: 0, files: 0 }
  for (const [projectId, chats] of pending) {
    const project = store.state.projectsById.get(projectId)
    if (!project) continue
    const location = await resolveWorkingTreeLocation(project.localPath)
    // Not a repo (any more): nothing to read a base from, and nothing can be
    // dirty either, so the stale claims are harmless where they are.
    if (!location) continue

    for (const chat of chats) {
      const paths = legacyPaths(chat)
      const activityAt = chatActivityAt(chat)
      if (paths.length === 0 || activityAt == null) continue

      const commit = await commitAsOf(location.repoRoot, activityAt)
      if (commit === undefined) continue
      // Nothing was committed when this chat ran, so "not in HEAD" is the
      // honest base — and whatever commit first added the path retires it.
      const blobs = commit === null
        ? new Map(paths.map((filePath) => [filePath, null] as const))
        : await readTreeBlobs(location.repoRoot, commit, paths)
      if (!blobs) continue

      const files: TouchedFile[] = paths.map((filePath) => ({
        path: filePath,
        baseBlob: blobs.get(filePath) ?? null,
      }))
      await store.recordFilesTouched(chat.id, files)
      result.chats += 1
      result.files += files.length
    }
  }

  if (result.chats > 0) {
    options?.onProgress?.(
      `${LOG_PREFIX} dated ${result.files} touched file(s) across ${result.chats} chat(s) recorded before commit tracking`
    )
  }
  return result
}
