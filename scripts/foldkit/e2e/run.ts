#!/usr/bin/env bun
// End-to-end runs against a real Kanna server: a fresh data dir, throwaway
// git projects, the real WebSocket server and real agent turns. Each
// scenario drives the client the way a person would and checks what they
// would see. (Every scenario passed against the React client before it was
// deleted; they are the Foldkit client's regression suite now.)
//
//   bun run ./scripts/foldkit/e2e/run.ts                       every scenario
//   bun run ./scripts/foldkit/e2e/run.ts --no-build            reuse the last build
//   bun run ./scripts/foldkit/e2e/run.ts --no-agent            skip scenarios that run a real turn
//   bun run ./scripts/foldkit/e2e/run.ts --repeat 3            the whole suite, three times over
//   bun run ./scripts/foldkit/e2e/run.ts send-prompt rename    only these (and what they need)

import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs"
import { homedir } from "node:os"
import path from "node:path"
import { spawn, spawnSync, type ChildProcess } from "node:child_process"
import { chromium, type Browser } from "playwright"
import { scenarios, type E2EContext } from "./scenarios"

const REPO = path.resolve(import.meta.dirname, "../../..")
const args = process.argv.slice(2)
const flag = (name: string) => args.includes(name)
const option = (name: string) => {
  const index = args.indexOf(name)
  return index >= 0 ? args[index + 1] : undefined
}
const apps = ["foldkit"]
const repeat = Number(option("--repeat") ?? "1")
const optionValues = new Set([option("--repeat")].filter(Boolean))
const only = args.filter((arg) => !arg.startsWith("--") && !optionValues.has(arg))
const withAgent = !flag("--no-agent")

const BUILDS = {
  foldkit: { dir: path.join(REPO, "dist/client"), command: ["x", "vite", "build"] },
} as const

function build(app: keyof typeof BUILDS) {
  console.log(`building ${app}…`)
  const result = spawnSync(process.execPath, BUILDS[app].command, { cwd: REPO, stdio: ["ignore", "ignore", "inherit"] })
  if (result.status !== 0) throw new Error(`${app} build failed`)
}

function git(cwd: string, ...gitArgs: string[]) {
  const result = spawnSync("git", gitArgs, {
    cwd,
    env: { ...process.env, GIT_CONFIG_GLOBAL: "/dev/null", GIT_AUTHOR_NAME: "E2E", GIT_AUTHOR_EMAIL: "e2e@kanna.test", GIT_COMMITTER_NAME: "E2E", GIT_COMMITTER_EMAIL: "e2e@kanna.test" },
  })
  if (result.status !== 0) throw new Error(`git ${gitArgs.join(" ")}: ${result.stderr}`)
}

/** Two small projects, each its own repo with a commit. */
function makeProjects(root: string) {
  const projects: Record<string, string> = {}
  for (const name of ["alpha", "beta"]) {
    const dir = path.join(root, "projects", name)
    mkdirSync(path.join(dir, "src"), { recursive: true })
    writeFileSync(path.join(dir, "README.md"), `# ${name}\n\nA project for the end-to-end runs.\n`)
    writeFileSync(path.join(dir, "src", "index.ts"), `export const name = "${name}"\n`)
    git(dir, "init", "-q", "-b", "main")
    git(dir, "add", ".")
    git(dir, "commit", "-q", "-m", "Initial commit")
    projects[name] = dir
  }
  return projects
}

async function startServer(root: string, clientDir: string, port: number): Promise<ChildProcess> {
  const child = spawn(process.execPath, ["run", path.join(REPO, "scripts/foldkit/e2e/server.ts")], {
    cwd: REPO,
    env: { ...process.env, E2E_ROOT: root, E2E_CLIENT_DIR: clientDir, E2E_PORT: String(port) },
    stdio: ["ignore", "pipe", "pipe"],
  })
  const log: string[] = []
  child.stdout!.on("data", (chunk) => log.push(String(chunk)))
  child.stderr!.on("data", (chunk) => log.push(String(chunk)))
  for (let attempt = 0; attempt < 60; attempt += 1) {
    if (child.exitCode !== null) throw new Error(`server exited:\n${log.join("")}`)
    try {
      const response = await fetch(`http://127.0.0.1:${port}/health`)
      if (response.ok) return child
    } catch {}
    await Bun.sleep(500)
  }
  child.kill()
  throw new Error(`server did not come up:\n${log.join("")}`)
}

/** Commands over the server's own socket, for setup a scenario doesn't test. */
async function serverCommand(port: number, command: Record<string, unknown>): Promise<unknown> {
  const socket = new WebSocket(`ws://127.0.0.1:${port}/ws`)
  await new Promise<void>((resolve, reject) => {
    socket.onopen = () => resolve()
    socket.onerror = () => reject(new Error("socket error"))
  })
  const id = crypto.randomUUID()
  const reply = new Promise<unknown>((resolve, reject) => {
    socket.onmessage = (event) => {
      const envelope = JSON.parse(String(event.data))
      if (envelope.id !== id) return
      if (envelope.type === "ack") resolve(envelope.result)
      if (envelope.type === "error") reject(new Error(envelope.message))
    }
  })
  socket.send(JSON.stringify({ v: 1, type: "command", id, command }))
  try {
    return await reply
  } finally {
    socket.close()
  }
}

/**
 * Real turns (and the server's title generation) leave sessions in the
 * user's own agent histories, keyed by the working directory, and Kanna
 * lists those as recent projects. Every one this suite makes started under
 * /tmp/kanna-e2e-*: remove exactly those, before and after a run.
 */
function removeE2ESessions() {
  const claudeProjects = path.join(homedir(), ".claude", "projects")
  if (existsSync(claudeProjects)) {
    for (const name of readdirSync(claudeProjects)) {
      if (name.startsWith("-tmp-kanna-e2e-")) rmSync(path.join(claudeProjects, name), { recursive: true, force: true })
    }
  }
  const codexSessions = path.join(homedir(), ".codex", "sessions")
  const walk = (dir: string): string[] => readdirSync(dir, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory() ? walk(path.join(dir, entry.name)) : entry.name.endsWith(".jsonl") ? [path.join(dir, entry.name)] : [])
  if (existsSync(codexSessions)) {
    for (const file of walk(codexSessions)) {
      const head = readFileSync(file, "utf8").slice(0, 2000)
      if (head.includes('"cwd":"/tmp/kanna-e2e-')) rmSync(file, { force: true })
    }
  }
}

interface Outcome { app: string; round: number; name: string; ok: boolean; ms: number; error?: string }

async function runApp(browser: Browser, app: "foldkit", round: number, port: number): Promise<Outcome[]> {
  const root = path.join("/tmp", `kanna-e2e-${app}-${process.pid}-${round}`)
  rmSync(root, { recursive: true, force: true })
  mkdirSync(root, { recursive: true })
  const projects = makeProjects(root)
  const server = await startServer(root, BUILDS[app].dir, port)
  const outcomes: Outcome[] = []
  try {
    for (const localPath of Object.values(projects)) await serverCommand(port, { type: "project.open", localPath })
    const context: E2EContext = {
      app,
      browser,
      origin: `http://127.0.0.1:${port}`,
      projects,
      withAgent,
      command: (command) => serverCommand(port, command),
      state: {},
      pages: [],
    }
    const selected = scenarios.filter((scenario) => only.length === 0 || only.includes(scenario.name) || scenario.always)
    for (const scenario of selected) {
      if (scenario.agent && !withAgent) continue
      const started = Date.now()
      try {
        await scenario.run(context)
        outcomes.push({ app, round, name: scenario.name, ok: true, ms: Date.now() - started })
        console.log(`PASS ${app} #${round} ${scenario.name} (${((Date.now() - started) / 1000).toFixed(1)}s)`)
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error)
        outcomes.push({ app, round, name: scenario.name, ok: false, ms: Date.now() - started, error: message })
        console.log(`FAIL ${app} #${round} ${scenario.name}: ${message.split("\n").slice(0, 6).join("\n     ")}`)
        const shots = path.join(REPO, ".e2e", app, `${round}-${scenario.name}`)
        mkdirSync(shots, { recursive: true })
        for (const [index, page] of context.pages.entries()) {
          if (page.isClosed()) continue
          await page.screenshot({ path: path.join(shots, `${index}.png`) }).catch(() => {})
        }
        console.log(`     screenshots: ${path.relative(REPO, shots)}`)
      } finally {
        for (const page of context.pages.splice(0)) await page.context().close().catch(() => {})
      }
    }
  } finally {
    server.kill()
  }
  // Kept for a look when something failed.
  if (outcomes.every((outcome) => outcome.ok)) rmSync(root, { recursive: true, force: true })
  return outcomes
}

if (!flag("--no-build")) for (const app of apps) build(app as keyof typeof BUILDS)

removeE2ESessions()
const browser = await chromium.launch()
const outcomes: Outcome[] = []
try {
  for (let round = 1; round <= repeat; round += 1) {
    for (const [index, app] of apps.entries()) {
      outcomes.push(...await runApp(browser, app as "foldkit", round, 4840 + index))
    }
  }
} finally {
  await browser.close()
  removeE2ESessions()
}

const failed = outcomes.filter((outcome) => !outcome.ok)
console.log(`\n${outcomes.length - failed.length}/${outcomes.length} scenario runs pass`)
for (const outcome of failed) console.log(`  ${outcome.app} #${outcome.round} ${outcome.name}`)
process.exit(failed.length > 0 ? 1 : 0)
