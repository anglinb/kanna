import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import {
  deleteSecret,
  ensureSecretsIgnored,
  findExistingSecret,
  getProjectSecretsDir,
  listSecrets,
  resolveSecretFilePath,
  writeSecret,
} from "./secrets"

let project: string

beforeEach(async () => {
  project = await mkdtemp(path.join(tmpdir(), "kanna-secrets-"))
})

afterEach(async () => {
  await rm(project, { recursive: true, force: true })
})

describe("writeSecret", () => {
  test("writes a project secret under .kanna/secrets with 0600", async () => {
    const result = await writeSecret({
      scope: "project",
      name: "OPENAI_API_KEY",
      value: "sk-test",
      projectPath: project,
    })

    expect(result.path).toBe(path.join(project, ".kanna", "secrets", "OPENAI_API_KEY.env"))
    expect(await readFile(result.path, "utf8")).toContain("OPENAI_API_KEY='sk-test'")
    expect((await stat(result.path)).mode & 0o777).toBe(0o600)
    expect((await stat(getProjectSecretsDir(project))).mode & 0o777).toBe(0o700)
  })

  test("returns a load command pointing at the file it wrote", async () => {
    const result = await writeSecret({
      scope: "project",
      name: "TOKEN",
      value: "abc",
      projectPath: project,
    })
    expect(result.loadCommand).toBe(`set -a; . '${result.path}'; set +a`)
  })

  test("overwrites an existing secret rather than appending", async () => {
    await writeSecret({ scope: "project", name: "TOKEN", value: "old", projectPath: project })
    const result = await writeSecret({ scope: "project", name: "TOKEN", value: "new", projectPath: project })

    const contents = await readFile(result.path, "utf8")
    expect(contents).toContain("TOKEN='new'")
    expect(contents).not.toContain("TOKEN='old'")
  })

  test("rejects names that are not shell-legal", async () => {
    await expect(
      writeSecret({ scope: "project", name: "../escape", value: "x", projectPath: project }),
    ).rejects.toThrow(/Invalid secret name/)
  })

  test("rejects an empty value", async () => {
    await expect(
      writeSecret({ scope: "project", name: "TOKEN", value: "", projectPath: project }),
    ).rejects.toThrow(/empty/)
  })

  test("requires a project path for project scope", async () => {
    await expect(
      writeSecret({ scope: "project", name: "TOKEN", value: "x", projectPath: null }),
    ).rejects.toThrow(/project path is required/i)
  })
})

describe("ensureSecretsIgnored", () => {
  test("does nothing when the project is not a git repo", async () => {
    expect(await ensureSecretsIgnored(project)).toBe(false)
    await expect(stat(path.join(project, ".gitignore"))).rejects.toThrow()
  })

  test("creates .gitignore with the entry in a fresh repo", async () => {
    await mkdir(path.join(project, ".git"))
    expect(await ensureSecretsIgnored(project)).toBe(true)
    expect(await readFile(path.join(project, ".gitignore"), "utf8")).toContain(".kanna/secrets/")
  })

  test("appends without clobbering existing rules, and only once", async () => {
    await mkdir(path.join(project, ".git"))
    await writeFile(path.join(project, ".gitignore"), "node_modules\n")

    expect(await ensureSecretsIgnored(project)).toBe(true)
    expect(await ensureSecretsIgnored(project)).toBe(false)

    const contents = await readFile(path.join(project, ".gitignore"), "utf8")
    expect(contents).toContain("node_modules")
    expect(contents.match(/\.kanna\/secrets\//g)).toHaveLength(1)
  })

  test("adds a newline first when the file does not end in one", async () => {
    await mkdir(path.join(project, ".git"))
    await writeFile(path.join(project, ".gitignore"), "dist")

    await ensureSecretsIgnored(project)
    const lines = (await readFile(path.join(project, ".gitignore"), "utf8")).split("\n")
    expect(lines[0]).toBe("dist")
    expect(lines).toContain(".kanna/secrets/")
  })

  test("leaves repos that already ignore all of .kanna alone", async () => {
    await mkdir(path.join(project, ".git"))
    await writeFile(path.join(project, ".gitignore"), ".kanna/\n")
    expect(await ensureSecretsIgnored(project)).toBe(false)
  })

  test("a .git file (worktree pointer) counts as a repo", async () => {
    await writeFile(path.join(project, ".git"), "gitdir: /elsewhere\n")
    expect(await ensureSecretsIgnored(project)).toBe(true)
  })
})

describe("writeSecret gitignore integration", () => {
  test("reports the gitignore edit it made", async () => {
    await mkdir(path.join(project, ".git"))
    const result = await writeSecret({
      scope: "project",
      name: "TOKEN",
      value: "abc",
      projectPath: project,
    })
    expect(result.gitignoreUpdated).toBe(true)
    expect(await readFile(path.join(project, ".gitignore"), "utf8")).toContain(".kanna/secrets/")
  })

  test("never touches .gitignore for a non-repo", async () => {
    const result = await writeSecret({
      scope: "project",
      name: "TOKEN",
      value: "abc",
      projectPath: project,
    })
    expect(result.gitignoreUpdated).toBe(false)
  })
})

describe("findExistingSecret", () => {
  test("returns null when nothing is stored", async () => {
    expect(await findExistingSecret("NOPE", project)).toBeNull()
  })

  test("finds a project secret", async () => {
    await writeSecret({ scope: "project", name: "TOKEN", value: "abc", projectPath: project })
    const found = await findExistingSecret("TOKEN", project)
    expect(found?.scope).toBe("project")
    expect(found?.path).toBe(resolveSecretFilePath("project", "TOKEN", project))
  })

  test("rejects an invalid name instead of probing the filesystem", async () => {
    expect(await findExistingSecret("../etc/passwd", project)).toBeNull()
  })
})

describe("listSecrets", () => {
  test("lists names without reading values", async () => {
    await writeSecret({ scope: "project", name: "BETA", value: "b", projectPath: project })
    await writeSecret({ scope: "project", name: "ALPHA", value: "a", projectPath: project })

    const listed = (await listSecrets(project)).filter((entry) => entry.scope === "project")
    expect(listed.map((entry) => entry.name)).toEqual(["ALPHA", "BETA"])
    expect(JSON.stringify(listed)).not.toContain("\"a\"")
  })

  test("tolerates a missing secrets directory", async () => {
    const listed = await listSecrets(project)
    expect(listed.every((entry) => entry.scope === "global")).toBe(true)
  })

  test("skips files that are not <NAME>.env", async () => {
    await mkdir(getProjectSecretsDir(project), { recursive: true })
    await writeFile(path.join(getProjectSecretsDir(project), "README.md"), "hi")
    await writeFile(path.join(getProjectSecretsDir(project), "bad-name.env"), "x")

    const listed = (await listSecrets(project)).filter((entry) => entry.scope === "project")
    expect(listed).toHaveLength(0)
  })
})

describe("deleteSecret", () => {
  test("removes a stored secret and reports whether it existed", async () => {
    await writeSecret({ scope: "project", name: "TOKEN", value: "abc", projectPath: project })
    expect(await deleteSecret("project", "TOKEN", project)).toBe(true)
    expect(await deleteSecret("project", "TOKEN", project)).toBe(false)
    expect(await findExistingSecret("TOKEN", project)).toBeNull()
  })
})
