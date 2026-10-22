import { Effect, Option, Schema } from "effect"
import {
  probeWorkingTree,
  readTreeBlobs,
  resolveWorkingTreeLocation,
  runGit,
  type WorkingTreeScan,
} from "./diff-store"

/**
 * The git helpers the worktree probe, the turn snapshots and the touched-file
 * backfill share, as Effects. `diff-store.ts` still exposes them as Promises;
 * this is the one place they are wrapped, so when that module moves to
 * Effect only this file changes.
 *
 * The helpers report git's own failures in their results (an exit code, a
 * `null`). What lands here as a `WorktreeGitError` is the rest: git could
 * not be spawned at all.
 */
export class WorktreeGitError extends Schema.TaggedError<WorktreeGitError>()(
  "@kanna/server/worktree-git/WorktreeGitError",
  {
    operation: Schema.Literals(["resolve location", "read tree blobs", "probe working tree", "run git"]),
    cwd: Schema.String,
    args: Schema.optionalKey(Schema.Array(Schema.String)),
    cause: Schema.Defect(),
  },
) {}

/** Repo root and git dir for a project path; none when it is not in a repo. */
export const resolveLocation = Effect.fn("WorktreeGit.resolveLocation")(function* (projectPath: string) {
  const location = yield* Effect.tryPromise({
    try: () => resolveWorkingTreeLocation(projectPath),
    catch: (cause) => new WorktreeGitError({ operation: "resolve location", cwd: projectPath, cause }),
  })
  return Option.fromNullOr(location)
})

/** What `treeish` holds for each path; none when the lookup could not run. See `readTreeBlobs`. */
export const treeBlobs = Effect.fn("WorktreeGit.treeBlobs")(function* (repoRoot: string, treeish: string, paths: readonly string[]) {
  const blobs = yield* Effect.tryPromise({
    try: () => readTreeBlobs(repoRoot, treeish, paths),
    catch: (cause) => new WorktreeGitError({ operation: "read tree blobs", cwd: repoRoot, args: [treeish], cause }),
  })
  return Option.fromNullOr(blobs)
})

/** One `git status` of the tree. A failed status reads as clean (see `probeWorkingTree`). */
export const scanWorkingTree = (repoRoot: string): Effect.Effect<WorkingTreeScan, WorktreeGitError> =>
  Effect.tryPromise({
    try: () => probeWorkingTree(repoRoot),
    catch: (cause) => new WorktreeGitError({ operation: "probe working tree", cwd: repoRoot, cause }),
  }).pipe(Effect.withSpan("WorktreeGit.scanWorkingTree"))

export const git = (args: string[], cwd: string, options?: { env?: Record<string, string | undefined> }) =>
  Effect.tryPromise({
    try: () => runGit(args, cwd, options),
    catch: (cause) => new WorktreeGitError({ operation: "run git", cwd, args, cause }),
  }).pipe(Effect.withSpan("WorktreeGit.git", { attributes: { command: args[0] } }))
