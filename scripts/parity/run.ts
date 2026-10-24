#!/usr/bin/env bun
// Parity runner: drives every scenario against the React reference and the
// Foldkit candidate (both on the demo backend, src/parity) and compares
// pixels, painted styles, the accessibility tree, the ClientCommand log,
// unhandled commands and console errors.
//
//   bun run parity                       every scenario
//   bun run parity chat-featured home    just these
//   bun run parity home --region sidebar just one region of each capture
//   bun run parity --selfcheck           React against React: must pass
//   bun run parity --selfcheck --inject-css 'button{letter-spacing:.01em}' --expect-fail
//                                        proves a one-rule change is caught
//
// Artifacts land in .parity/runs/<stamp>/ (.parity/latest points at the last
// run): screenshots, a diff image, both captures and a summary.md.
// Exit 0 = every capture passes, 1 = differences, 2 = the harness itself failed.

import { createHash } from "node:crypto"
import { existsSync, mkdirSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs"
import { open, readFile, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import pixelmatch from "pixelmatch"
import { chromium, type Browser } from "playwright"
import { PNG } from "pngjs"
import { capture, instrumentPage, settle } from "./capture"
import { compareCaptures, comparePixels, passes, type Capture, type CheckResult } from "./compare"
import { VIEWPORTS, type Scenario, type Theme, type ViewportName } from "./scenario"
import { scenarios as allScenarios } from "./scenarios"

const ROOT = path.resolve(import.meta.dirname, "../..")
const PARITY_DIR = path.join(ROOT, ".parity")
// Machine-wide, not per checkout: port agents each run in their own worktree.
const LOCK_PATH = path.join(tmpdir(), "kanna-parity.lock")
const FIXED_TIME = new Date("2026-06-01T12:00:00Z")
// Exact color match per pixel. pixelmatch's default (0.1) can't see a dark
// theme's surfaces: the sidebar is a few levels off the page background, and
// a blank candidate scored under 1% different. Antialiased pixels are still
// skipped (includeAA: false), which absorbs text rasterization noise.
const PIXEL_THRESHOLD = 0
// Chromium rasterizes a small curve a few levels differently from run to run
// (19 px of a toggle's edge on one React-vs-React run). 0.01% of the page
// absorbs that; anything structural also fails the paint check, which has
// no tolerance.
const DEFAULT_PIXEL_TOLERANCE = 0.0001

// Inputs of each app's build. A change to any of them rebuilds that app.
// Both hash all of src/: gallery pages cross over (the React icon gallery
// reads the Foldkit icon list), and the Foldkit app imports React-free
// modules from src/client.
const BUILD_INPUTS = {
  react: ["src", "public", "vite.parity.config.ts", "vite-plugin-message-scroller.ts", "package.json", "bun.lock"],
  foldkit: ["src", "public", "vite.parity.config.ts", "package.json", "bun.lock"],
} as const
type AppName = keyof typeof BUILD_INPUTS

interface Options {
  names: string[]
  selfcheck: boolean
  injectCss: string | null
  expectFail: boolean
  /** Region names to compare ("page" is the whole page). Empty: all of them. */
  regions: string[]
}

function parseArgs(argv: string[]): Options {
  const options: Options = { names: [], selfcheck: false, injectCss: null, expectFail: false, regions: [] }
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i]!
    if (arg === "--selfcheck") options.selfcheck = true
    else if (arg === "--expect-fail") options.expectFail = true
    else if (arg === "--inject-css") options.injectCss = argv[++i] ?? ""
    else if (arg === "--region") options.regions.push(...(argv[++i] ?? "").split(","))
    else if (arg === "--scenario") options.names.push(...(argv[++i] ?? "").split(","))
    else if (arg.startsWith("--")) throw new Error(`unknown flag ${arg}`)
    else options.names.push(arg)
  }
  return options
}

// One run at a time on this machine: two browsers plus two builds would
// starve a 2-core box and make timings (and settling) flaky.
async function acquireLock(): Promise<() => void> {
  mkdirSync(PARITY_DIR, { recursive: true })
  for (let attempt = 0; ; attempt++) {
    try {
      const handle = await open(LOCK_PATH, "wx")
      await handle.writeFile(String(process.pid))
      await handle.close()
      const release = () => rmSync(LOCK_PATH, { force: true })
      process.on("exit", release)
      return release
    } catch {
      const holder = Number(readFileSync(LOCK_PATH, "utf8"))
      let alive = false
      try {
        process.kill(holder, 0)
        alive = true
      } catch {}
      if (!alive) {
        rmSync(LOCK_PATH, { force: true })
        continue
      }
      if (attempt === 0) console.log(`waiting for parity run ${holder} to finish…`)
      await Bun.sleep(2000)
    }
  }
}

async function inputHash(app: AppName) {
  const proc = Bun.spawnSync(["git", "ls-files", "-co", "--exclude-standard", "--", ...BUILD_INPUTS[app]], { cwd: ROOT })
  const files = proc.stdout.toString().split("\n").filter(Boolean).sort()
  const hash = createHash("sha256")
  for (const file of files) {
    const full = path.join(ROOT, file)
    if (!existsSync(full)) continue
    hash.update(file)
    hash.update(await readFile(full))
  }
  return hash.digest("hex").slice(0, 16)
}

async function build(app: AppName) {
  const outDir = path.join(ROOT, "dist/parity", app)
  const stampPath = path.join(PARITY_DIR, `build-${app}.hash`)
  const hash = await inputHash(app)
  if (existsSync(path.join(outDir, "index.html")) && existsSync(stampPath) && readFileSync(stampPath, "utf8") === hash) {
    return outDir
  }
  console.log(`building ${app}…`)
  const proc = Bun.spawn(["bunx", "vite", "build", "--config", "vite.parity.config.ts", "--logLevel", "warn"], {
    cwd: ROOT,
    env: { ...process.env, PARITY_APP: app },
    stdout: "inherit",
    stderr: "inherit",
  })
  if ((await proc.exited) !== 0) throw new Error(`${app} build failed`)
  writeFileSync(stampPath, hash)
  return outDir
}

function serve(dir: string) {
  const server = Bun.serve({
    port: 0,
    hostname: "127.0.0.1",
    async fetch(request) {
      const pathname = decodeURIComponent(new URL(request.url).pathname)
      const file = path.join(dir, pathname)
      if (file.startsWith(dir) && existsSync(file) && (await stat(file)).isFile()) return new Response(Bun.file(file))
      // SPA fallback, as the real server does for client routes.
      return new Response(Bun.file(path.join(dir, "index.html")), { headers: { "Content-Type": "text/html" } })
    },
  })
  return { origin: `http://127.0.0.1:${server.port}`, stop: () => server.stop(true) }
}

interface Run {
  label: string
  capture: Capture
  screenshot: Buffer
}

async function runApp(browser: Browser, origin: string, scenario: Scenario, theme: Theme, viewport: ViewportName, injectCss: string | null, regionFilter: string[]): Promise<Run[]> {
  const size = VIEWPORTS[viewport]
  const context = await browser.newContext({
    viewport: { width: size.width, height: size.height },
    deviceScaleFactor: 1,
    isMobile: size.mobile,
    hasTouch: size.mobile,
    locale: "en-US",
    timezoneId: "UTC",
    colorScheme: theme,
  })
  const page = await context.newPage()
  const errors: string[] = []
  await instrumentPage(page, errors)
  await page.clock.setFixedTime(FIXED_TIME)
  if (injectCss) {
    await page.addInitScript((css: string) => {
      document.addEventListener("DOMContentLoaded", () => {
        const style = document.createElement("style")
        style.textContent = css
        document.head.append(style)
      })
    }, injectCss)
  }
  const runs: Run[] = []
  const regions: [string, string | undefined][] = [["page", undefined], ...Object.entries(scenario.regions ?? {})]
  const take = async (label: string) => {
    await settle(page, errors)
    for (const [name, selector] of regions) {
      if (regionFilter.length > 0 && !regionFilter.includes(name)) continue
      const result = await capture(page, errors, selector)
      runs.push({ label: name === "page" ? label : `${label}@${name}`, ...result })
    }
  }
  try {
    const separator = scenario.route.includes("?") ? "&" : "?"
    await page.goto(`${origin}${scenario.route}${separator}theme=${theme}`)
    await settle(page, errors)
    await scenario.run?.({
      page,
      theme,
      viewport,
      settle: () => settle(page, errors),
      capture: take,
      async advance(ms) {
        await page.evaluate((amount) => (window as unknown as { __parity: { advance(ms: number): void } }).__parity.advance(amount), ms)
        await settle(page, errors)
      },
    })
    if (runs.length === 0) await take("final")
  } catch (error) {
    errors.push(`scenario threw: ${error instanceof Error ? error.message : String(error)}`)
    if (runs.length === 0) await take("final").catch(() => {})
  } finally {
    await context.close()
  }
  return runs
}

function diffImages(reference: Buffer, candidate: Buffer) {
  const a = PNG.sync.read(reference)
  const b = PNG.sync.read(candidate)
  if (a.width !== b.width || a.height !== b.height) {
    return { different: a.width * a.height, total: a.width * a.height, diff: null as Buffer | null, note: `size ${a.width}x${a.height} → ${b.width}x${b.height}` }
  }
  const out = new PNG({ width: a.width, height: a.height })
  const different = pixelmatch(a.data, b.data, out.data, a.width, a.height, { threshold: PIXEL_THRESHOLD, includeAA: false })
  return { different, total: a.width * a.height, diff: different > 0 ? PNG.sync.write(out) : null, note: "" }
}

interface Outcome {
  id: string
  results: CheckResult[]
  pass: boolean
}

async function main() {
  const options = parseArgs(process.argv.slice(2))
  const selected = options.names.length === 0 ? allScenarios : allScenarios.filter((s) => options.names.includes(s.name))
  const missing = options.names.filter((name) => !allScenarios.some((s) => s.name === name))
  if (missing.length > 0) throw new Error(`no scenario named ${missing.join(", ")}`)

  const release = await acquireLock()
  const stamp = new Date().toISOString().replace(/[:.]/g, "-")
  const runDir = path.join(PARITY_DIR, "runs", stamp)
  mkdirSync(runDir, { recursive: true })

  const referenceDir = await build("react")
  const candidateDir = options.selfcheck ? referenceDir : await build("foldkit")
  const reference = serve(referenceDir)
  const candidate = options.selfcheck ? serve(referenceDir) : serve(candidateDir)
  const browser = await chromium.launch()
  const outcomes: Outcome[] = []

  try {
    for (const scenario of selected) {
      for (const viewport of scenario.viewports ?? (["desktop", "mobile"] as ViewportName[])) {
        for (const theme of scenario.themes ?? (["dark", "light"] as Theme[])) {
          const variant = `${viewport}-${theme}`
          const refRuns = await runApp(browser, reference.origin, scenario, theme, viewport, null, options.regions)
          const candRuns = await runApp(browser, candidate.origin, scenario, theme, viewport, options.injectCss, options.regions)
          const labels = [...new Set([...refRuns, ...candRuns].map((run) => run.label))]
          for (const label of labels) {
            const id = `${scenario.name}/${variant}/${label}`
            const dir = path.join(runDir, scenario.name, variant, label)
            mkdirSync(dir, { recursive: true })
            const ref = refRuns.find((run) => run.label === label)
            const cand = candRuns.find((run) => run.label === label)
            if (!ref || !cand) {
              outcomes.push({ id, pass: false, results: [{ check: "errors", status: "different", detail: [`capture "${label}" exists only in the ${ref ? "reference" : "candidate"}`] }] })
              continue
            }
            writeFileSync(path.join(dir, "reference.png"), ref.screenshot)
            writeFileSync(path.join(dir, "candidate.png"), cand.screenshot)
            writeFileSync(path.join(dir, "reference.json"), JSON.stringify(ref.capture, null, 2))
            writeFileSync(path.join(dir, "candidate.json"), JSON.stringify(cand.capture, null, 2))
            const pixels = diffImages(ref.screenshot, cand.screenshot)
            if (pixels.diff) writeFileSync(path.join(dir, "diff.png"), pixels.diff)
            const pixelResult = comparePixels(pixels.different, pixels.total, scenario.pixelTolerance ?? DEFAULT_PIXEL_TOLERANCE)
            if (pixels.note) pixelResult.detail.unshift(pixels.note)
            const results = [pixelResult, ...compareCaptures(ref.capture, cand.capture, { reference: reference.origin, candidate: candidate.origin })]
            writeFileSync(path.join(dir, "result.json"), JSON.stringify(results, null, 2))
            const pass = passes(results)
            outcomes.push({ id, results, pass })
            const failing = results.filter((r) => r.status === "different").map((r) => r.check)
            console.log(`${pass ? "PASS" : "FAIL"} ${id}${failing.length ? `  (${failing.join(", ")})` : ""}`)
          }
        }
      }
    }
  } finally {
    await browser.close()
    reference.stop()
    candidate.stop()
  }

  const passed = outcomes.filter((o) => o.pass).length
  const lines = [
    `# Parity run ${stamp}`,
    "",
    `${options.selfcheck ? "Selfcheck (React against React)" : "React against Foldkit"}${options.injectCss ? `, candidate CSS injected: \`${options.injectCss}\`` : ""}`,
    "",
    `${passed}/${outcomes.length} captures pass.`,
    "",
  ]
  for (const outcome of outcomes) {
    lines.push(`## ${outcome.pass ? "PASS" : "FAIL"} ${outcome.id}`, "")
    for (const result of outcome.results.filter((r) => r.status !== "identical")) {
      lines.push(`- **${result.check}**: ${result.status}`)
      for (const line of result.detail.slice(0, 40)) lines.push(`  - \`${line}\``)
      if (result.detail.length > 40) lines.push(`  - …${result.detail.length - 40} more`)
    }
    lines.push("")
  }
  writeFileSync(path.join(runDir, "summary.md"), lines.join("\n"))
  const latest = path.join(PARITY_DIR, "latest")
  rmSync(latest, { force: true })
  symlinkSync(runDir, latest)
  release()

  const allPass = passed === outcomes.length
  console.log(`\n${passed}/${outcomes.length} captures pass — ${path.relative(ROOT, path.join(runDir, "summary.md"))}`)
  if (options.expectFail) {
    console.log(allPass ? "expected a difference and found none: the harness missed it" : "difference detected, as expected")
    process.exit(allPass ? 1 : 0)
  }
  process.exit(allPass ? 0 : 1)
}

main().catch((error) => {
  console.error(error)
  process.exit(2)
})
