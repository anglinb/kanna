#!/usr/bin/env bun
// Coverage audit for the parity suite (docs/foldkit-migration.md, "Loops:
// coverage audit"): every ClientCommand in shared/protocol.ts, every default
// keybinding action, every route in App.tsx and every settings section must
// be named by some scenario's `covers` (a settings section also counts when
// a scenario opens `/settings/<id>`).
//
//   bun run parity:coverage                 the report; exit 1 if anything
//                                           is uncovered without a reason
//   bun run parity:coverage --verify [dir]  also checks each scenario's
//                                           `covers.commands` against what it
//                                           actually sent in a parity run
//                                           (default .parity/latest), and
//                                           that it took every capture its
//                                           run names (a throw loses the rest)
//
// Items that can't be covered on the fixture are listed in UNCOVERABLE with
// the reason. One that becomes covered must leave the list (the report says
// so), so the list only ever shrinks.

import { existsSync, readdirSync, readFileSync, statSync } from "node:fs"
import path from "node:path"
import { DEFAULT_KEYBINDINGS } from "../../src/shared/types"
import { scenarios } from "./scenarios"

const ROOT = path.resolve(import.meta.dirname, "../..")

/** Why an item has no scenario. Keys: a command type, `keybinding:<action>`, a route, `settings:<id>`. */
const UNCOVERABLE: Record<string, string> = {
  // Never sent by the React client: no code path builds them.
  "accounts.cancelLogin": "not sent by the React client (declared in the protocol for the iOS app)",
  "accounts.submitCode": "not sent by the React client (declared in the protocol for the iOS app)",
  "accounts.rename": "not sent by the React client (no rename in Settings → Providers)",
  "chat.getReadAnchor": "not sent by the React client (the read anchor rides on the chat snapshot)",
  "fs.mkdir": "not sent by the React client",
  "settings.readKeybindings": "not sent by the React client (keybindings come by subscription)",
  "settings.writeAppSettings": "not sent by the React client (it writes patches)",
  "skills.listInstalled": "not sent by the React client",
  // The fixture can't stand in for these.
  "project.clone": "needs a real server: the demo can't clone a repository; it answers with the install prompt by design (backend.test.ts pins that)",
  "auth.login.submitCode": "needs a provider CLI waiting for a pasted code; the demo answers auth.login.start with 'needs your machine', so no sign-in gets that far",
  "auth.login.cancel": "needs a provider CLI mid sign-in (see auth.login.submitCode)",
  "auth.openrouter.start": "opens OpenRouter's OAuth popup; the demo has no OAuth app",
  "auth.openrouter.exchange": "needs a code from OpenRouter's OAuth redirect",
  "update.install": "only offered with an update available; the demo is always up to date",
  "update.installStable": "only offered while on a nightly build",
  "system.ping": "the socket pings only a connection that has been quiet for 25s by Date.now(), which the runner freezes, so it is never sent under the harness",
  // The harness can't compare these yet.
  "chat.exportStandalone": "harness: the command carries window.location.origin, and the two apps are served on different ports, so their command logs never match; compareCommands needs to normalize origins as the url check does",
  "browser.killLocalHttpServer": "needs a local HTTP server; seeding one would link demo visitors to a port that isn't there",
  "browser.exposeLocalHttpServer": "needs a local HTTP server (see browser.killLocalHttpServer) and cloudflared",
  "browser.unexposeLocalHttpServer": "needs an exposed local HTTP server (see browser.exposeLocalHttpServer)",
  "chat.usageLimitResume": "needs a chat waiting on its usage limit (runtime.usageLimitResume); no demo chat is",
  "chat.initGit": "needs a project folder with no git repo; every demo project has one, and project.create makes one (as the real server does for an empty folder)",
  "chat.checkGitHubRepoAvailability": "sent only once gh is signed in; the demo's gh is signed out, so the Push to GitHub dialog stops at sign-in (dialog-push-to-github)",
  "chat.publishToGitHub": "needs gh signed in (see chat.checkGitHubRepoAvailability)",
  "chat.stopDraining": "needs a chat draining its queue after a stop (runtime.isDraining); the demo never drains",
}

/** Sent by every page as it boots or opens a chat; `--verify` doesn't ask scenarios to list them. */
const BOOT_COMMANDS = new Set([
  "chat.setDraftProtection",
  "update.check",
  "settings.readAppSettings",
  "settings.readLlmProvider",
  "project.readQuickActions",
  "chat.refreshDiffs",
  "github.listRecentRepos",
])

function clientCommandTypes() {
  const source = readFileSync(path.join(ROOT, "src/shared/protocol.ts"), "utf8")
  const start = source.indexOf("export type ClientCommand =")
  const end = source.indexOf("\nexport type", start + 1)
  const block = source.slice(start, end)
  return [...new Set([...block.matchAll(/type: "([\w.]+)"/g)].map((match) => match[1]!))].sort()
}

function appRoutes() {
  const source = readFileSync(path.join(ROOT, "src/client/app/App.tsx"), "utf8")
  return [...new Set([...source.matchAll(/<Route\s+path="([^"]+)"/g)].map((match) => match[1]!))]
}

function settingsSections() {
  const source = readFileSync(path.join(ROOT, "src/client/app/settings/registry.ts"), "utf8")
  const start = source.indexOf("export const SETTINGS_SECTIONS")
  const end = source.indexOf("] as const", start)
  return [...source.slice(start, end).matchAll(/id: "([\w-]+)"/g)].map((match) => match[1]!)
}

interface Item {
  key: string
  kind: "command" | "keybinding" | "route" | "settings"
  label: string
  by: string[]
}

function collect(): Item[] {
  const items: Item[] = []
  const byCommand = new Map<string, string[]>()
  const byKeybinding = new Map<string, string[]>()
  const byRoute = new Map<string, string[]>()
  const add = (map: Map<string, string[]>, key: string, name: string) => map.set(key, [...(map.get(key) ?? []), name])
  for (const scenario of scenarios) {
    for (const command of scenario.covers?.commands ?? []) add(byCommand, command, scenario.name)
    for (const action of scenario.covers?.keybindings ?? []) add(byKeybinding, action, scenario.name)
    for (const route of scenario.covers?.routes ?? []) add(byRoute, route, scenario.name)
  }
  for (const type of clientCommandTypes()) {
    items.push({ key: type, kind: "command", label: type, by: byCommand.get(type) ?? [] })
  }
  for (const action of Object.keys(DEFAULT_KEYBINDINGS)) {
    items.push({ key: `keybinding:${action}`, kind: "keybinding", label: action, by: byKeybinding.get(action) ?? [] })
  }
  for (const route of appRoutes()) {
    items.push({ key: route, kind: "route", label: route, by: byRoute.get(route) ?? [] })
  }
  for (const id of settingsSections()) {
    const sectionPath = `/settings/${id}`
    const by = scenarios
      .filter((scenario) => scenario.route.split(/[?#]/)[0] === sectionPath || scenario.covers?.routes?.includes(sectionPath))
      .map((scenario) => scenario.name)
    items.push({ key: `settings:${id}`, kind: "settings", label: id, by })
  }
  return items
}

/** Commands each scenario sent in a parity run, read from its reference captures. */
function sentCommands(runDir: string) {
  const sent = new Map<string, Set<string>>()
  if (!existsSync(runDir)) return sent
  for (const scenario of readdirSync(runDir)) {
    const scenarioDir = path.join(runDir, scenario)
    if (!statSync(scenarioDir).isDirectory()) continue
    const types = new Set<string>()
    const walk = (dir: string) => {
      for (const entry of readdirSync(dir)) {
        const full = path.join(dir, entry)
        if (statSync(full).isDirectory()) walk(full)
        else if (entry === "reference.json") {
          const capture = JSON.parse(readFileSync(full, "utf8")) as { commands: { type: string }[] }
          for (const command of capture.commands) types.add(command.type)
        }
      }
    }
    walk(scenarioDir)
    sent.set(scenario, types)
  }
  return sent
}

/**
 * The capture labels a scenario's `run` names (`context.capture("…")`), or
 * "final" when it names none. Read from the function's source, so a label
 * built at run time isn't seen; every scenario here uses literals.
 */
function expectedCaptures(scenario: (typeof scenarios)[number]) {
  const source = scenario.run?.toString() ?? ""
  const labels = [...source.matchAll(/\.capture\(\s*"([^"]+)"\s*\)/g)].map((match) => match[1]!)
  return labels.length > 0 ? [...new Set(labels)] : ["final"]
}

/**
 * Captures each variant of a scenario is missing in a run. A scenario that
 * throws keeps the captures it took before the throw and loses the rest
 * without a trace in the summary, so a selfcheck where both runs threw at
 * the same step reads as a pass. This is what catches it.
 */
function missingCaptures(runDir: string) {
  const missing: string[] = []
  for (const scenario of scenarios) {
    const scenarioDir = path.join(runDir, scenario.name)
    if (!existsSync(scenarioDir)) continue
    const expected = expectedCaptures(scenario)
    for (const variant of readdirSync(scenarioDir)) {
      const variantDir = path.join(scenarioDir, variant)
      if (!statSync(variantDir).isDirectory()) continue
      const taken = new Set(readdirSync(variantDir).map((entry) => entry.split("@")[0]!))
      const absent = expected.filter((label) => !taken.has(label))
      if (absent.length > 0) missing.push(`${scenario.name}/${variant}: no ${absent.map((label) => `"${label}"`).join(", ")}`)
    }
  }
  return missing
}

function main() {
  const args = process.argv.slice(2)
  const verifyIndex = args.indexOf("--verify")
  const items = collect()
  const lines: string[] = []
  let problems = 0

  const groups: [Item["kind"], string][] = [["command", "ClientCommands"], ["keybinding", "Keybindings"], ["route", "Routes"], ["settings", "Settings sections"]]
  lines.push("# Parity coverage", "")
  for (const [kind, title] of groups) {
    const all = items.filter((item) => item.kind === kind)
    const covered = all.filter((item) => item.by.length > 0)
    lines.push(`${title}: ${covered.length}/${all.length} covered`)
  }
  lines.push("")

  const uncovered = items.filter((item) => item.by.length === 0)
  const explained = uncovered.filter((item) => UNCOVERABLE[item.key])
  const unexplained = uncovered.filter((item) => !UNCOVERABLE[item.key])
  if (explained.length > 0) {
    lines.push(`## Uncovered, with the reason (${explained.length})`, "")
    for (const item of explained) lines.push(`- ${item.kind} \`${item.label}\`: ${UNCOVERABLE[item.key]}`)
    lines.push("")
  }
  if (unexplained.length > 0) {
    problems += unexplained.length
    lines.push(`## Uncovered, no reason given (${unexplained.length})`, "")
    for (const item of unexplained) lines.push(`- ${item.kind} \`${item.label}\``)
    lines.push("")
  }
  const known = new Set(items.map((item) => item.key))
  const stale = Object.entries(UNCOVERABLE)
    .filter(([key, reason]) => reason && (!known.has(key) || items.find((item) => item.key === key)!.by.length > 0))
  if (stale.length > 0) {
    problems += stale.length
    lines.push("## Listed as uncoverable but covered (or gone): take them off the list", "")
    for (const [key] of stale) lines.push(`- \`${key}\``)
    lines.push("")
  }

  const allCommands = new Set(clientCommandTypes())
  const allActions = new Set(Object.keys(DEFAULT_KEYBINDINGS))
  const unknown: string[] = []
  for (const scenario of scenarios) {
    for (const command of scenario.covers?.commands ?? []) if (!allCommands.has(command)) unknown.push(`${scenario.name}: command ${command}`)
    for (const action of scenario.covers?.keybindings ?? []) if (!allActions.has(action)) unknown.push(`${scenario.name}: keybinding ${action}`)
  }
  if (unknown.length > 0) {
    problems += unknown.length
    lines.push("## `covers` naming something that doesn't exist", "")
    for (const entry of unknown) lines.push(`- ${entry}`)
    lines.push("")
  }

  if (verifyIndex !== -1) {
    const dirArg = args[verifyIndex + 1]
    const runDir = path.resolve(ROOT, dirArg && !dirArg.startsWith("--") ? dirArg : ".parity/latest")
    const sent = sentCommands(runDir)
    const mismatched: string[] = []
    const undeclared: string[] = []
    for (const scenario of scenarios) {
      const types = sent.get(scenario.name)
      if (!types) continue
      const declared = new Set(scenario.covers?.commands ?? [])
      for (const command of declared) {
        if (!types.has(command)) mismatched.push(`${scenario.name}: covers ${command} but never sent it`)
      }
      const extra = [...types].filter((type) => !declared.has(type) && !BOOT_COMMANDS.has(type))
      if (extra.length > 0) undeclared.push(`${scenario.name}: ${extra.join(", ")}`)
    }
    lines.push(`## Verified against ${path.relative(ROOT, runDir) || runDir} (${sent.size} scenarios in the run)`, "")
    if (mismatched.length === 0) lines.push("Every declared command was sent.")
    for (const entry of mismatched) lines.push(`- ${entry}`)
    lines.push("")
    problems += mismatched.length
    const missing = missingCaptures(runDir)
    if (missing.length === 0) lines.push("Every scenario took every capture its run names.")
    else lines.push("Captures a scenario names but didn't take (it threw before them):", "")
    for (const entry of missing) lines.push(`- ${entry}`)
    lines.push("")
    problems += missing.length
    if (undeclared.length > 0) {
      // Not a failure: a scenario may send what another one is about.
      lines.push("Sent but not in `covers` (beyond what every page sends on boot):", "")
      for (const entry of undeclared) lines.push(`- ${entry}`)
      lines.push("")
    }
  }

  lines.push(`Scenarios: ${scenarios.length}`)
  console.log(lines.join("\n"))
  process.exit(problems > 0 ? 1 : 0)
}

main()
