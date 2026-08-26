import { cp, mkdir, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { TranscriptEntry } from "../shared/types"

/**
 * Images in tool results live on disk, not in the transcript.
 *
 * A screenshot read returns 400 to 700 KB of base64. Kept inline it makes
 * every reader of the transcript, including the boot tail scan and the
 * cold-load parse, pay for pixels nothing but an expanded row ever draws. So
 * the bytes go to `<dataDir>/media/<chatId>/<entryId>-<n>.<ext>` and the
 * block keeps a URL the browser loads on its own, only when the row is open.
 *
 * The URL carries the chat id so the client needs no context to render it,
 * and so an export can find the file again from the transcript alone.
 */

const MEDIA_URL_PATTERN = /^\/api\/chats\/([^/]+)\/media\/([^/]+)$/

const EXTENSION_BY_MIME: Record<string, string> = {
  "image/png": "png",
  "image/jpeg": "jpg",
  "image/gif": "gif",
  "image/webp": "webp",
  "image/svg+xml": "svg",
}

export interface TranscriptImageUrlBlock {
  type: "image"
  url: string
  mimeType: string
}

export function getTranscriptMediaDir(dataDir: string, chatId: string) {
  return path.join(dataDir, "media", chatId)
}

export function buildTranscriptMediaUrl(chatId: string, name: string) {
  return `/api/chats/${encodeURIComponent(chatId)}/media/${encodeURIComponent(name)}`
}

/** The chat id and file name a media URL points at, or null for any other URL. */
export function parseTranscriptMediaUrl(url: string): { chatId: string; name: string } | null {
  const match = MEDIA_URL_PATTERN.exec(url)
  if (!match) return null
  const chatId = decodeURIComponent(match[1]!)
  const name = decodeURIComponent(match[2]!)
  if (!isSafeMediaName(name) || chatId.includes("/") || chatId.includes("\\")) return null
  return { chatId, name }
}

export function isSafeMediaName(name: string) {
  return name.length > 0 && !name.includes("/") && !name.includes("\\") && name !== "." && name !== ".."
}

/** Inline base64 image in either shape the adapters produce. */
function readInlineImage(block: unknown): { data: string; mimeType: string } | null {
  if (!block || typeof block !== "object" || (block as { type?: unknown }).type !== "image") return null
  const record = block as Record<string, unknown>
  // Pi and Cursor: { type: "image", data, mimeType }
  if (typeof record.data === "string") {
    return { data: record.data, mimeType: typeof record.mimeType === "string" ? record.mimeType : "image/png" }
  }
  // Claude: { type: "image", source: { type: "base64", data, media_type } }
  const source = record.source as Record<string, unknown> | undefined
  if (source && source.type === "base64" && typeof source.data === "string") {
    return { data: source.data, mimeType: typeof source.media_type === "string" ? source.media_type : "image/png" }
  }
  return null
}

/**
 * Write every inline image in a tool result to disk and return the entry
 * with URL blocks in their place. Returns the same object when there was
 * nothing inline, so callers can test identity to know whether to rewrite.
 *
 * File names are derived from the entry id, so running this twice on the
 * same entry overwrites the same files rather than leaking copies.
 */
export async function externalizeEntryImages(
  entry: TranscriptEntry,
  args: { dataDir: string; chatId: string }
): Promise<TranscriptEntry> {
  if (entry.kind !== "tool_result" || !Array.isArray(entry.content)) return entry
  let dirReady = false
  let changed = false
  const content: unknown[] = []
  for (let index = 0; index < entry.content.length; index += 1) {
    const block = entry.content[index]
    const inline = readInlineImage(block)
    if (!inline) {
      content.push(block)
      continue
    }
    if (!dirReady) {
      await mkdir(getTranscriptMediaDir(args.dataDir, args.chatId), { recursive: true })
      dirReady = true
    }
    const name = `${entry._id}-${index}.${EXTENSION_BY_MIME[inline.mimeType] ?? "bin"}`
    await writeFile(path.join(getTranscriptMediaDir(args.dataDir, args.chatId), name), Buffer.from(inline.data, "base64"))
    content.push({ type: "image", url: buildTranscriptMediaUrl(args.chatId, name), mimeType: inline.mimeType } satisfies TranscriptImageUrlBlock)
    changed = true
  }
  return changed ? { ...entry, content } : entry
}

/**
 * Point a copied entry's media URLs at the fork's own chat id. Used with
 * `copyTranscriptMedia`, so a fork survives its source being deleted.
 */
export function retargetEntryMediaUrls(entry: TranscriptEntry, sourceChatId: string, chatId: string): TranscriptEntry {
  if (entry.kind !== "tool_result" || !Array.isArray(entry.content)) return entry
  let changed = false
  const content = entry.content.map((block) => {
    if (!block || typeof block !== "object") return block
    const url = (block as { url?: unknown }).url
    if (typeof url !== "string") return block
    const parsed = parseTranscriptMediaUrl(url)
    if (!parsed || parsed.chatId !== sourceChatId) return block
    changed = true
    return { ...(block as object), url: buildTranscriptMediaUrl(chatId, parsed.name) }
  })
  return changed ? { ...entry, content } : entry
}

export async function copyTranscriptMedia(dataDir: string, sourceChatId: string, chatId: string) {
  const sourceDir = getTranscriptMediaDir(dataDir, sourceChatId)
  try {
    await cp(sourceDir, getTranscriptMediaDir(dataDir, chatId), { recursive: true })
  } catch (error) {
    // No media dir is the common case: the source chat never read an image.
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error
  }
}

export async function removeTranscriptMedia(dataDir: string, chatId: string) {
  await rm(getTranscriptMediaDir(dataDir, chatId), { recursive: true, force: true })
}
