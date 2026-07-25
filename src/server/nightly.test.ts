import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  fetchMainCommitSha,
  installNightlyBuild,
  nightlyVersion,
  type RunCommandResult,
} from "./nightly"

const SHA = "0123456789abcdef0123456789abcdef01234567"

let tempDir: string | null = null

afterEach(() => {
  if (tempDir) rmSync(tempDir, { recursive: true, force: true })
  tempDir = null
})

/** A real .tar.gz of a minimal repo (package.json only), like GitHub's codeload archive. */
function createSourceTarball(workDir: string): Buffer {
  const repoDir = path.join(workDir, "repo-root")
  mkdirSync(repoDir, { recursive: true })
  writeFileSync(path.join(repoDir, "package.json"), JSON.stringify({ name: "kanna-code", version: "0.56.7" }))
  const tarPath = path.join(workDir, "fixture.tar.gz")
  const result = spawnSync("tar", ["-czf", tarPath, "-C", workDir, "repo-root"], { stdio: "ignore" })
  expect(result.status).toBe(0)
  return Buffer.from(readFileSync(tarPath))
}

describe("nightlyVersion", () => {
  test("stamps the base version with the short sha", () => {
    expect(nightlyVersion("0.56.7", SHA)).toBe("0.56.7-nightly.0123456")
  })
})

describe("fetchMainCommitSha", () => {
  test("returns the sha from the GitHub API", async () => {
    const fetchImpl = (async () => new Response(`${SHA}\n`)) as unknown as typeof fetch
    expect(await fetchMainCommitSha(fetchImpl)).toBe(SHA)
  })

  test("rejects non-ok responses and malformed shas", async () => {
    const failing = (async () => new Response("nope", { status: 503 })) as unknown as typeof fetch
    await expect(fetchMainCommitSha(failing)).rejects.toThrow("503")

    const malformed = (async () => new Response("not-a-sha")) as unknown as typeof fetch
    await expect(fetchMainCommitSha(malformed)).rejects.toThrow("commit sha")
  })
})

describe("installNightlyBuild", () => {
  test("downloads main, stamps the version, and runs the build/install steps", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "kanna-nightly-"))
    const tarball = createSourceTarball(tempDir)
    const workDir = path.join(tempDir, "nightly")

    const commands: Array<{ command: string; args: string[]; cwd: string; env?: Record<string, string> }> = []
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("api.github.com")) return new Response(SHA)
      if (url.includes("codeload.github.com")) {
        expect(url).toContain(SHA)
        return new Response(new Uint8Array(tarball))
      }
      throw new Error(`Unexpected fetch: ${url}`)
    }) as unknown as typeof fetch

    const result = await installNightlyBuild({
      workDir,
      fetchImpl,
      runCommand: async (command, args, cwd, env): Promise<RunCommandResult> => {
        commands.push({ command, args, cwd, env })
        if (command === "tar") {
          // Real extraction so the version-stamp step operates on real files.
          const extract = spawnSync(command, args, { cwd, stdio: "ignore" })
          return { ok: extract.status === 0, output: "" }
        }
        if (args.includes("--version")) {
          return { ok: true, output: "0.56.7-nightly.0123456\n" }
        }
        return { ok: true, output: "" }
      },
    })

    expect(result.ok).toBe(true)
    expect(result.version).toBe("0.56.7-nightly.0123456")

    // The extracted checkout carries the stamped version bun install -g picks up.
    const stamped = JSON.parse(readFileSync(path.join(workDir, "src", "package.json"), "utf8")) as { version: string }
    expect(stamped.version).toBe("0.56.7-nightly.0123456")

    expect(commands.map(({ command, args }) => [command, ...args].join(" "))).toEqual([
      expect.stringContaining("tar -xzf"),
      "bun install",
      "bun run build",
      "bun bin/kanna --version",
      "bun install -g .",
    ])
    // Build steps run inside the extracted source checkout.
    expect(commands.slice(1).every(({ cwd }) => cwd === path.join(workDir, "src"))).toBe(true)
    // The startup probe runs the built CLI directly in child mode.
    const probeEnv = commands.find(({ args }) => args.includes("--version"))?.env ?? {}
    expect(Object.keys(probeEnv).length).toBeGreaterThan(0)
    expect(probeEnv.KANNA_DISABLE_SELF_UPDATE).toBe("1")
  })

  test("a build that fails its startup check is never installed", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "kanna-nightly-"))
    const tarball = createSourceTarball(tempDir)
    const workDir = path.join(tempDir, "nightly")

    const commands: string[] = []
    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("api.github.com")) return new Response(SHA)
      return new Response(new Uint8Array(tarball))
    }) as unknown as typeof fetch

    const result = await installNightlyBuild({
      workDir,
      fetchImpl,
      runCommand: async (command, args, cwd): Promise<RunCommandResult> => {
        commands.push([command, ...args].join(" "))
        if (command === "tar") {
          const extract = spawnSync(command, args, { cwd, stdio: "ignore" })
          return { ok: extract.status === 0, output: "" }
        }
        if (args.includes("--version")) {
          return { ok: false, output: "SyntaxError: unexpected token" }
        }
        return { ok: true, output: "" }
      },
    })

    expect(result.ok).toBe(false)
    expect(result.userMessage).toContain("startup check")
    expect(result.userMessage).toContain("SyntaxError")
    // The global install was never touched.
    expect(commands.some((command) => command.includes("install -g"))).toBe(false)
  })

  test("surfaces a failing build step with its output", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "kanna-nightly-"))
    const tarball = createSourceTarball(tempDir)
    const workDir = path.join(tempDir, "nightly")

    const fetchImpl = (async (input: string | URL | Request) => {
      const url = String(input)
      if (url.includes("api.github.com")) return new Response(SHA)
      return new Response(new Uint8Array(tarball))
    }) as unknown as typeof fetch

    const result = await installNightlyBuild({
      workDir,
      fetchImpl,
      runCommand: async (command, args, cwd): Promise<RunCommandResult> => {
        if (command === "tar") {
          const extract = spawnSync(command, args, { cwd, stdio: "ignore" })
          return { ok: extract.status === 0, output: "" }
        }
        if (args[0] === "run") {
          return { ok: false, output: "vite exploded" }
        }
        return { ok: true, output: "" }
      },
    })

    expect(result.ok).toBe(false)
    expect(result.version).toBeNull()
    expect(result.userTitle).toBe("Nightly update failed")
    expect(result.userMessage).toContain("build step failed")
    expect(result.userMessage).toContain("vite exploded")
  })

  test("fails cleanly when GitHub is unreachable", async () => {
    tempDir = mkdtempSync(path.join(tmpdir(), "kanna-nightly-"))
    const fetchImpl = (async () => new Response("nope", { status: 502 })) as unknown as typeof fetch

    const result = await installNightlyBuild({
      workDir: path.join(tempDir, "nightly"),
      fetchImpl,
      runCommand: async () => ({ ok: true, output: "" }),
    })

    expect(result.ok).toBe(false)
    expect(result.userMessage).toContain("502")
  })
})
