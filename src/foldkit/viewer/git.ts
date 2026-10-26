import type { Html, HtmlBuilder } from "foldkit/html"
import { cn } from "../../client/lib/utils"
import type { ChatAttachment, ChatDiffSnapshot } from "../../shared/types"

// The pure helpers of components/chat-ui/git/shared.tsx (a React file), copied
// with their comments, and its DiffFileStat as a view.

export type DiffRenderMode = "unified" | "split"
export type DiffFile = ChatDiffSnapshot["files"][number]

/**
 * A file's line changes — `+6`, `-2`, or both — in the git panel's colours.
 * Renders nothing when both counts are zero or unknown, so a binary file — or
 * anything recorded before counts existed — leaves an empty slot rather than
 * claiming `+0`.
 */
export function diffFileStat<Message>(options: { additions?: number; deletions?: number; className?: string }, h: HtmlBuilder<Message>): Html | null {
  const hasAdditions = (options.additions ?? 0) > 0
  const hasDeletions = (options.deletions ?? 0) > 0
  if (!hasAdditions && !hasDeletions) return null
  return h.span([h.Class(cn("whitespace-nowrap text-xs font-mono", options.className))], [
    hasAdditions ? h.span([h.Class("text-emerald-600 dark:text-emerald-400")], [`+${options.additions}`]) : null,
    hasDeletions ? h.span([h.Class(cn("text-red-600 dark:text-red-400", hasAdditions && "ml-2"))], [`-${options.deletions}`]) : null,
  ])
}

/**
 * The letter git would print, in the column's status colors. An untracked
 * file is a new one as far as a commit is concerned, so it reads "A" too.
 */
export function diffStatus(file: DiffFile): { letter: string; label: string; className: string } {
  if (file.isUntracked || file.changeType === "added") return { letter: "A", label: "Added", className: "text-success" }
  if (file.changeType === "deleted") return { letter: "D", label: "Deleted", className: "text-destructive" }
  if (file.changeType === "renamed") return { letter: "R", label: "Renamed", className: "text-info" }
  return { letter: "M", label: "Modified", className: "text-muted-foreground" }
}

/**
 * Files GitHub (through linguist) treats as generated and doesn't render by
 * default: lockfiles, minified bundles, source maps, Xcode project files,
 * protobuf output.
 */
const GENERATED_FILE_NAMES = new Set([
  "package-lock.json", "npm-shrinkwrap.json", "yarn.lock", "pnpm-lock.yaml", "bun.lock", "bun.lockb", "deno.lock",
  "Cargo.lock", "Gemfile.lock", "composer.lock", "poetry.lock", "Pipfile.lock", "uv.lock", "go.sum", "go.work.sum",
  "Podfile.lock", "Package.resolved", "flake.lock", "pubspec.lock", "mix.lock", "gradle.lockfile", "project.pbxproj",
])
const GENERATED_FILE_PATTERN = /(?:[.-]min\.(?:js|mjs|css)|\.(?:js|mjs|css)\.map|\.pb\.(?:go|swift|cc|h)|_pb2(?:_grpc)?\.pyi?|\.xcworkspacedata)$/iu

export function isGeneratedPath(path: string) {
  const name = path.slice(path.lastIndexOf("/") + 1)
  return GENERATED_FILE_NAMES.has(name) || GENERATED_FILE_PATTERN.test(name)
}

/** Changed lines past which a diff waits for a click: one huge file shouldn't stall the rest. */
export const LARGE_DIFF_LINES = 1_000

/**
 * Why a file's diff isn't drawn straight away, GitHub's precautions: what
 * the file says instead, and whether "Load diff" can still show it. Null
 * when it's drawn as usual. An image or PDF never lands here; it shows as
 * itself.
 */
export function diffHold(file: DiffFile): { message: string; loadable: boolean } | null {
  const lines = file.additions + file.deletions
  if (file.binary) return { message: "Binary file not shown.", loadable: false }
  if (file.changeType === "renamed" && lines === 0) return { message: "File renamed without changes.", loadable: false }
  if (file.changeType !== "deleted" && file.size === 0) return { message: "Empty file.", loadable: false }
  if (file.changeType === "deleted") return { message: "This file was deleted.", loadable: true }
  if (isGeneratedPath(file.path)) return { message: "Generated files are not rendered by default.", loadable: true }
  if (lines > LARGE_DIFF_LINES) return { message: "Large diffs are not rendered by default.", loadable: true }
  return null
}

const PATH_COLLATOR = new Intl.Collator(undefined, { numeric: true, sensitivity: "base" })

/**
 * Tree order, as GitHub's and VS Code's file lists: folder by folder, a
 * folder's subfolders before its files, names in natural order.
 */
export function compareFilePaths(left: string, right: string) {
  const leftParts = left.split("/")
  const rightParts = right.split("/")
  const shared = Math.min(leftParts.length, rightParts.length)
  for (let index = 0; index < shared; index += 1) {
    const leftPart = leftParts[index]!
    const rightPart = rightParts[index]!
    if (leftPart === rightPart) continue
    const leftIsFolder = index < leftParts.length - 1
    const rightIsFolder = index < rightParts.length - 1
    if (leftIsFolder !== rightIsFolder) return leftIsFolder ? -1 : 1
    return PATH_COLLATOR.compare(leftPart, rightPart) || (leftPart < rightPart ? -1 : 1)
  }
  return leftParts.length - rightParts.length
}

export function sortByPath<T extends { path: string }>(files: readonly T[]): T[] {
  return [...files].sort((left, right) => compareFilePaths(left.path, right.path))
}

/** "src/app/Page.tsx" → name "Page.tsx", folder "src/app". */
export function splitDiffPath(path: string) {
  const slash = path.lastIndexOf("/")
  return slash === -1 ? { name: path, folder: "" } : { name: path.slice(slash + 1), folder: path.slice(0, slash) }
}

/** An image or PDF shows as itself rather than as a binary diff. */
export function getDiffPreviewAttachment(projectId: string | null, file: DiffFile): ChatAttachment | null {
  if (!projectId || !file.mimeType || typeof file.size !== "number" || file.changeType === "deleted") {
    return null
  }
  if (!file.mimeType.startsWith("image/") && file.mimeType !== "application/pdf") {
    return null
  }
  return {
    id: `diff:${file.path}`,
    kind: file.mimeType.startsWith("image/") ? "image" : "file",
    displayName: file.path.split("/").pop() ?? file.path,
    absolutePath: file.path,
    relativePath: file.path,
    contentUrl: `/api/projects/${projectId}/files/${encodeURIComponent(file.path)}/content`,
    mimeType: file.mimeType,
    size: file.size,
  }
}
