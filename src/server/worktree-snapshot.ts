import { randomUUID } from "node:crypto"
import path from "node:path"
import { Context, Effect, Fiber, FileSystem, Layer, Option, Schema } from "effect"
import type { WorkingTreeLocation } from "./diff-store"
import type { TouchedFile } from "./events"
import { git, resolveLocation, treeBlobs, type WorktreeGitError } from "./worktree-git"

/**
 * Which files a chat actually changed, by snapshotting the working tree at each
 * turn boundary and diffing the two trees.
 *
 * The point is to answer "did this chat touch anything that's still
 * uncommitted?" without a clock. The old answer compared the chat's last turn
 * end against a per-project "when did the tree get dirty" timestamp, which is a
 * proxy for authorship rather than a measurement of it: one file left
 * uncommitted overnight flagged every chat that had run since, and none of them
 * had necessarily touched it.
 *
 * Snapshots measure the filesystem, so they don't care *how* a file changed —
 * an Edit tool, `sed -i` inside a Bash call, a formatter on save, or a subagent
 * all land in the diff identically. Parsing tool calls would see only the first.
 *
 * The trees are written with `git write-tree` against a throwaway index, so the
 * user's index is never touched and nothing is committed, staged, or moved. No
 * refs are created either: we need the tree only long enough to diff it, and
 * loose objects are not pruned anywhere near that fast. (If per-chat diffs or
 * turn-level revert ever want the trees kept, add refs then — the recorded
 * paths don't change.)
 *
 * Each recorded path carries the blob it held in `HEAD` when the turn *started*
 * — the committed content the turn's edit was made on top of. That's what
 * expires a claim: once anyone commits the path, `HEAD` no longer holds that
 * blob and the chat stops being relevant to it, without any clock being
 * involved. Turn *start* rather than turn end, because agents routinely commit
 * their own work mid-turn — a base read afterwards would be the chat's own
 * commit and would keep the chat alive on work it had already landed.
 */

/** A path one turn changed, and the committed content it was based on. */
export type { TouchedFile } from "./events"

/** What `beginTurn` banks: the pre-turn worktree, and the commit it sat on. */
interface PendingTurn {
  /** Tree object of the whole worktree, dirty content included. */
  tree: Option.Option<string>
  /** `HEAD` at turn start; none on an unborn HEAD (nothing committed yet). */
  head: Option.Option<string>
}

/** The files a turn changed could not be persisted. */
export class TurnFileRecordError extends Schema.TaggedError<TurnFileRecordError>()(
  "@kanna/server/worktree-snapshot/TurnFileRecordError",
  {
    chatId: Schema.String,
    cause: Schema.Defect(),
  },
) {}

export interface TurnFileTrackerOptions {
  /** Absolute project path for a chat, or null when it can't be resolved. Read when a turn starts and ends. */
  readonly resolveChatPath: (chatId: string) => string | null
  /** Persist the files a turn changed. Never called with an empty list. */
  readonly recordFiles: (chatId: string, files: TouchedFile[]) => Effect.Effect<void, TurnFileRecordError>
}

/** Per-chat pre-turn state, plus a location cache so `git rev-parse` runs once per project. */
export class TurnFileTracker extends Context.Service<TurnFileTracker, {
  /**
   * Snapshot before the turn runs. Callers don't wait for it: the capture
   * races the agent's first tool call, which is fine — a file the agent
   * changes before the snapshot lands simply shows up as pre-existing dirt
   * rather than as this turn's work. Blocking the turn on a `git add -A`
   * would be the worse trade.
   *
   * The pending capture is registered before this does anything async, and
   * the capture itself runs in the layer, so a caller that stops waiting
   * doesn't cancel it. Succeeds once the capture has finished, failed or
   * not, so tests can wait for a deterministic baseline.
   */
  readonly beginTurn: (chatId: string) => Effect.Effect<void>
  /**
   * Snapshot after the turn and record the delta. A missing pre-tree (server
   * restarted mid-turn, project isn't a repo, capture failed) records nothing
   * rather than guessing — a chat with no recorded paths is simply never
   * flagged, which is the safe direction. Never fails: file tracking must not
   * break a turn's completion path, so a failure is logged.
   */
  readonly endTurn: (chatId: string) => Effect.Effect<void>
  /** Drops a chat's pending state without recording anything. */
  readonly forget: (chatId: string) => Effect.Effect<void>
}>()("@kanna/server/TurnFileTracker") {
  static readonly layer = (options: TurnFileTrackerOptions) => Layer.effect(this, makeTurnFileTracker(options))
}

const makeTurnFileTracker = Effect.fn("TurnFileTracker.make")(function* (options: TurnFileTrackerOptions) {
  const fs = yield* FileSystem.FileSystem
  const pendingTurns = new Map<string, Fiber.Fiber<PendingTurn, WorktreeGitError>>()
  const locations = new Map<string, Effect.Effect<Option.Option<WorkingTreeLocation>, WorktreeGitError>>()
  const layerScope = yield* Effect.scope

  /** Resolved once per project path; concurrent first callers share the one resolution. */
  const locationFor = (localPath: string) => Effect.suspend(() => {
    const cached = locations.get(localPath)
    if (cached) return cached
    return Effect.cached(resolveLocation(localPath)).pipe(
      Effect.flatMap((once) => {
        locations.set(localPath, once)
        return once
      }),
    )
  })

  /**
   * The whole worktree as a tree object, untracked files included and
   * `.gitignore` respected — `git add -A` decides both for us, so the snapshot
   * matches what `git status` reports as dirty.
   */
  const captureTree = Effect.fnUntraced(function* (localPath: string) {
    const location = yield* locationFor(localPath)
    if (Option.isNone(location)) return Option.none<string>()
    const { repoRoot, gitDir } = location.value

    const indexPath = path.join(gitDir, `kanna-snapshot-index-${randomUUID()}`)
    const env = { ...process.env, GIT_INDEX_FILE: indexPath }
    return yield* Effect.gen(function* () {
      // Seed from HEAD so `add -A` only has to hash what actually differs.
      // Without this every snapshot re-hashes the entire worktree. Failure is
      // fine and expected on an unborn HEAD (a repo with no commits yet).
      yield* git(["read-tree", "HEAD"], repoRoot, { env })
      const added = yield* git(["add", "-A", "--", "."], repoRoot, { env })
      if (added.exitCode !== 0) return Option.none<string>()
      const written = yield* git(["write-tree"], repoRoot, { env })
      if (written.exitCode !== 0) return Option.none<string>()
      return Option.fromNullOr(written.stdout.trim() || null)
    }).pipe(Effect.ensuring(fs.remove(indexPath, { force: true }).pipe(Effect.ignore)))
  })

  /** None on an unborn HEAD or a project that isn't a repo. */
  const readHead = Effect.fnUntraced(function* (localPath: string) {
    const location = yield* locationFor(localPath)
    if (Option.isNone(location)) return Option.none<string>()
    const head = yield* git(["rev-parse", "--verify", "HEAD"], location.value.repoRoot)
    return head.exitCode === 0 ? Option.fromNullOr(head.stdout.trim() || null) : Option.none<string>()
  })

  /** The pre-turn worktree and the commit it sits on, captured together. */
  const captureTurn = Effect.fn("TurnFileTracker.captureTurn")(function* (localPath: string) {
    const [tree, head] = yield* Effect.all([captureTree(localPath), readHead(localPath)], { concurrency: 2 })
    const pending: PendingTurn = { tree, head }
    return pending
  })

  /**
   * What the turn changed, and by how much.
   *
   * `--no-renames` on purpose: a rename should yield *both* names, since either
   * one can be the path that later shows up dirty. It also keeps `-z` records
   * to a single path each — a rename under `-z` splits its paths across extra
   * NUL fields.
   *
   * `-z` because the default output C-quotes any path with a space or a quote
   * in it, which would then match neither `git status` nor the file on disk.
   */
  const diffTrees = Effect.fnUntraced(function* (localPath: string, fromTree: string, toTree: string) {
    const location = yield* locationFor(localPath)
    if (Option.isNone(location)) return []
    const diff = yield* git(["diff", "--numstat", "-z", "--no-renames", fromTree, toTree], location.value.repoRoot)
    if (diff.exitCode !== 0) return []
    return parseNumstat(diff.stdout)
  })

  /**
   * Pairs each changed path with the blob it held at the turn's starting commit.
   *
   * An unborn HEAD gives every path a `null` base — accurate, since nothing is
   * committed there — while a failed lookup leaves the base *absent*, which
   * reads downstream as "unknown" and keeps the pre-base-blob behaviour rather
   * than inventing a base that would expire the claim early.
   */
  const toTouchedFiles = Effect.fnUntraced(function* (localPath: string, head: Option.Option<string>, changes: TurnFileChange[]) {
    if (Option.isNone(head)) return changes.map((change): TouchedFile => ({ ...change, baseBlob: null }))
    const location = yield* locationFor(localPath)
    const blobs = Option.isSome(location)
      ? yield* treeBlobs(location.value.repoRoot, head.value, changes.map((change) => change.path))
      : Option.none<Map<string, string | null>>()
    if (Option.isNone(blobs)) return changes.map((change): TouchedFile => ({ ...change }))
    return changes.map((change): TouchedFile => ({ ...change, baseBlob: blobs.value.get(change.path) ?? null }))
  })

  const recordTurn = Effect.fnUntraced(function* (chatId: string, localPath: string, pending: Fiber.Fiber<PendingTurn, WorktreeGitError>) {
    const [pre, postTree] = yield* Effect.all([Fiber.join(pending), captureTree(localPath)], { concurrency: 2 })
    if (Option.isNone(pre.tree) || Option.isNone(postTree) || pre.tree.value === postTree.value) return
    const changes = yield* diffTrees(localPath, pre.tree.value, postTree.value)
    if (changes.length === 0) return
    yield* options.recordFiles(chatId, yield* toTouchedFiles(localPath, pre.head, changes))
  })

  const beginTurn = Effect.fn("TurnFileTracker.beginTurn")(function* (chatId: string) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    const localPath = options.resolveChatPath(chatId)
    if (!localPath) return
    const capture = yield* captureTurn(localPath).pipe(Effect.forkIn(layerScope))
    pendingTurns.set(chatId, capture)
    yield* Fiber.await(capture)
  })

  const endTurn = Effect.fn("TurnFileTracker.endTurn")(function* (chatId: string) {
    yield* Effect.annotateCurrentSpan("chatId", chatId)
    const pending = pendingTurns.get(chatId)
    pendingTurns.delete(chatId)
    if (!pending) return
    const localPath = options.resolveChatPath(chatId)
    if (!localPath) return
    yield* recordTurn(chatId, localPath, pending).pipe(
      // Never let file tracking break a turn's completion path.
      Effect.tapError((error) => Effect.logWarning(`turn file tracking failed for chat ${chatId}:`, error)),
      Effect.ignore,
    )
  })

  return {
    beginTurn,
    endTurn,
    forget: (chatId: string) => Effect.sync(() => {
      pendingTurns.delete(chatId)
    }),
  } satisfies TurnFileTracker["Service"]
})

/** One path a turn changed, with the lines it added and removed there. */
export interface TurnFileChange {
  path: string
  /** Absent for binary files, which numstat reports as `-` rather than a count. */
  additions?: number
  deletions?: number
}

/**
 * `--numstat -z` records: `<additions> TAB <deletions> TAB <path> NUL`.
 *
 * Binary files come back as `-` on both counts. Those keep the path (the chat
 * did change the file) but carry no numbers, so nothing downstream has to
 * decide what "+0" means for a PNG.
 */
export function parseNumstat(stdout: string): TurnFileChange[] {
  const changes: TurnFileChange[] = []
  for (const record of stdout.split("\0")) {
    if (!record) continue
    const firstTab = record.indexOf("\t")
    const secondTab = record.indexOf("\t", firstTab + 1)
    if (firstTab === -1 || secondTab === -1) continue
    const filePath = record.slice(secondTab + 1)
    if (!filePath) continue
    const additions = Number.parseInt(record.slice(0, firstTab), 10)
    const deletions = Number.parseInt(record.slice(firstTab + 1, secondTab), 10)
    changes.push({
      path: filePath,
      ...(Number.isNaN(additions) ? {} : { additions }),
      ...(Number.isNaN(deletions) ? {} : { deletions }),
    })
  }
  return changes
}
