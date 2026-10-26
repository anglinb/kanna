import { readdirSync } from "node:fs"
import path from "node:path"
import type { Scenario } from "../scenario"

// Every other file in this folder exports `scenarios: Scenario[]`, one file
// per area (routes.ts, sidebar.ts, gallery-buttons.ts, …), so authors adding
// scenarios in parallel never edit the same file. Names must be unique.

const files = readdirSync(import.meta.dirname)
  .filter((file) => file.endsWith(".ts") && file !== "index.ts" && !file.endsWith(".test.ts"))
  .sort()

const loaded: Scenario[] = []
for (const file of files) {
  const module = (await import(path.join(import.meta.dirname, file))) as { scenarios?: Scenario[] }
  if (!module.scenarios) throw new Error(`${file} exports no scenarios`)
  loaded.push(...module.scenarios)
}

const seen = new Set<string>()
for (const scenario of loaded) {
  if (seen.has(scenario.name)) throw new Error(`duplicate scenario name ${scenario.name}`)
  seen.add(scenario.name)
}

export const scenarios = loaded
