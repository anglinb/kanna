import { afterEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises"
import { readdir } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { TurnFileTracker } from "./worktree-snapshot"

const tempDirs: string[] = []

afterEach(async () => {
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })))
})

async function run(command: string[], cwd: string) {
  const process = Bun.spawn(command, { cwd, stdout: "pipe", stderr: "pipe" })
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(process.stdout).text(),
    new Response(process.stderr).text(),
    process.exited,
  ])
  if (exitCode !== 0) throw new Error(stderr || stdout || `Command failed: ${command.join(" ")}`)
  return stdout
}

async function createRepo() {
  const root = await mkdtemp(path.join(tmpdir(), "kanna-turn-files-"))
  tempDirs.push(root)
  await run(["git", "init", "-b", "main"], root)
  await run(["git", "config", "user.email", "kanna@example.com"], root)
  await run(["git", "config", "user.name", "Kanna"], root)
  await writeFile(path.join(root, "app.txt"), "base\n", "utf8")
  await writeFile(path.join(root, ".gitignore"), "ignored/\n", "utf8")
  await run(["git", "add", "."], root)
  await run(["git", "commit", "-m", "init"], root)
  return root
}

/** A tracker over one repo, collecting what it records per chat. */
function trackerFor(repoRoot: string | null) {
  const recorded = new Map<string, string[]>()
  const tracker = new TurnFileTracker({
    resolveChatPath: () => repoRoot,
    recordPaths: async (chatId, paths) => {
      recorded.set(chatId, [...(recorded.get(chatId) ?? []), ...paths])
    },
  })
  /** One whole turn: snapshot, let `mutate` play the agent, snapshot and diff. */
  const runTurn = async (chatId: string, mutate: () => Promise<void>) => {
    await tracker.beginTurn(chatId)
    await mutate()
    await tracker.endTurn(chatId)
    return recorded.get(chatId) ?? []
  }
  return { tracker, recorded, runTurn }
}

describe("TurnFileTracker", () => {
  test("records a file the turn modified", async () => {
    const repoRoot = await createRepo()
    const { runTurn } = trackerFor(repoRoot)

    const paths = await runTurn("chat-1", async () => {
      await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    })

    expect(paths).toEqual(["app.txt"])
  })

  test("records files created by any means, not just edit tools", async () => {
    // The reason this is a filesystem snapshot rather than tool-call parsing:
    // a shell redirect inside a Bash call is invisible to the transcript.
    const repoRoot = await createRepo()
    const { runTurn } = trackerFor(repoRoot)

    const paths = await runTurn("chat-1", async () => {
      await run(["sh", "-c", "echo generated > from-bash.txt"], repoRoot)
    })

    expect(paths).toEqual(["from-bash.txt"])
  })

  test("records deletions — a removed file is still a file the chat changed", async () => {
    const repoRoot = await createRepo()
    const { runTurn } = trackerFor(repoRoot)

    const paths = await runTurn("chat-1", async () => {
      await rm(path.join(repoRoot, "app.txt"))
    })

    expect(paths).toEqual(["app.txt"])
  })

  test("records both sides of a rename", async () => {
    const repoRoot = await createRepo()
    const { runTurn } = trackerFor(repoRoot)

    const paths = await runTurn("chat-1", async () => {
      await run(["git", "mv", "app.txt", "renamed.txt"], repoRoot)
    })

    expect(paths.sort()).toEqual(["app.txt", "renamed.txt"])
  })

  test("records nothing for a turn that changed nothing", async () => {
    const repoRoot = await createRepo()
    const { runTurn, recorded } = trackerFor(repoRoot)

    await runTurn("chat-1", async () => {})

    expect(recorded.has("chat-1")).toBe(false)
  })

  test("ignores gitignored paths, exactly as git status does", async () => {
    // The dirty set comes from `git status`, so anything it hides must be
    // hidden here too or a chat could hold paths that can never intersect.
    const repoRoot = await createRepo()
    const { runTurn, recorded } = trackerFor(repoRoot)

    await runTurn("chat-1", async () => {
      await mkdir(path.join(repoRoot, "ignored"), { recursive: true })
      await writeFile(path.join(repoRoot, "ignored", "junk.txt"), "noise\n", "utf8")
    })

    expect(recorded.has("chat-1")).toBe(false)
  })

  test("attributes only what changed during the turn", async () => {
    const repoRoot = await createRepo()
    const { runTurn } = trackerFor(repoRoot)

    // Dirt that predates the turn belongs to whoever made it, not to this chat.
    await writeFile(path.join(repoRoot, "pre-existing.txt"), "not mine\n", "utf8")

    const paths = await runTurn("chat-1", async () => {
      await writeFile(path.join(repoRoot, "mine.txt"), "mine\n", "utf8")
    })

    expect(paths).toEqual(["mine.txt"])
  })

  test("a committed change still counts as touched", async () => {
    // Committing inside the turn leaves the tree clean, but the chat did change
    // the file — the intersection with the dirty set decides relevance later.
    const repoRoot = await createRepo()
    const { runTurn } = trackerFor(repoRoot)

    const paths = await runTurn("chat-1", async () => {
      await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
      await run(["git", "commit", "-am", "agent commit"], repoRoot)
    })

    expect(paths).toEqual(["app.txt"])
  })

  test("leaves no temp index files behind", async () => {
    const repoRoot = await createRepo()
    const { runTurn } = trackerFor(repoRoot)

    await runTurn("chat-1", async () => {
      await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    })

    const gitDirEntries = await readdir(path.join(repoRoot, ".git"))
    expect(gitDirEntries.filter((entry) => entry.startsWith("kanna-snapshot-index"))).toEqual([])
  })

  test("never touches the user's index or refs", async () => {
    const repoRoot = await createRepo()
    const { runTurn } = trackerFor(repoRoot)

    await runTurn("chat-1", async () => {
      await writeFile(path.join(repoRoot, "staged-by-nobody.txt"), "new\n", "utf8")
    })

    // Still untracked rather than staged: `git add -A` ran against a throwaway
    // index, so the real one never saw it.
    expect(await run(["git", "status", "--short"], repoRoot)).toContain("?? staged-by-nobody.txt")
    // And nothing was committed or ref'd — unlike t3's checkpoints, we keep no
    // trees, because the path list is all we need.
    const refs = await run(["git", "for-each-ref", "--format=%(refname)"], repoRoot)
    expect(refs.split("\n").filter((ref) => ref && !ref.startsWith("refs/heads/"))).toEqual([])
  })

  test("records nothing when the project is not a repo", async () => {
    const plain = await mkdtemp(path.join(tmpdir(), "kanna-turn-files-plain-"))
    tempDirs.push(plain)
    const { runTurn, recorded } = trackerFor(plain)

    await runTurn("chat-1", async () => {
      await writeFile(path.join(plain, "app.txt"), "changed\n", "utf8")
    })

    expect(recorded.has("chat-1")).toBe(false)
  })

  test("records nothing when the turn's start was never captured", async () => {
    // Server restarted mid-turn: no baseline, so we say nothing rather than
    // attributing every change since some arbitrary point to this chat.
    const repoRoot = await createRepo()
    const { tracker, recorded } = trackerFor(repoRoot)

    await writeFile(path.join(repoRoot, "app.txt"), "changed\n", "utf8")
    await tracker.endTurn("chat-1")

    expect(recorded.has("chat-1")).toBe(false)
  })

  test("tracks concurrent turns independently", async () => {
    // Two chats in one worktree. Each still gets its own baseline; what they
    // can't do is tell each other's edits apart inside an overlapping window.
    const repoRoot = await createRepo()
    const { tracker, recorded } = trackerFor(repoRoot)

    await tracker.beginTurn("chat-a")
    await writeFile(path.join(repoRoot, "a.txt"), "a\n", "utf8")
    await tracker.endTurn("chat-a")

    await tracker.beginTurn("chat-b")
    await writeFile(path.join(repoRoot, "b.txt"), "b\n", "utf8")
    await tracker.endTurn("chat-b")

    expect(recorded.get("chat-a")).toEqual(["a.txt"])
    expect(recorded.get("chat-b")).toEqual(["b.txt"])
  })
})
