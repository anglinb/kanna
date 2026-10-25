#!/usr/bin/env bun
// Walks the import graph of the Foldkit app (src/foldkit, minus tests and
// the React-side parity pages) and fails if any module it reaches imports
// React or a React-only library. Prints the import chain to each one, so a
// pure helper that happens to live in a React file shows where to cut.
//
//   bun run ./scripts/foldkit/react-free.ts            the app
//   bun run ./scripts/foldkit/react-free.ts <entry…>   other entries

import { existsSync, readFileSync, readdirSync, statSync } from "node:fs"
import path from "node:path"

const ROOT = path.resolve(import.meta.dirname, "../..")
const REACT_PACKAGES = /^(react|react-dom|react-router|react-router-dom|react-markdown|react-resizable-panels|recharts|cmdk|zustand(?!\/(vanilla|middleware))|lucide-react|@radix-ui\/|@dnd-kit\/|@shadcn\/react|@vitejs\/plugin-react|hast-util-to-jsx-runtime)(\/|$)/

function walk(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const full = path.join(dir, name)
    if (statSync(full).isDirectory()) return walk(full)
    return /\.tsx?$/.test(name) && !/\.test\.tsx?$/.test(name) ? [full] : []
  })
}

const entries = process.argv.slice(2).length > 0
  ? process.argv.slice(2).map((entry) => path.resolve(entry))
  : [
    ...walk(path.join(ROOT, "src/foldkit")),
    path.join(ROOT, "src/parity/foldkit/main.ts"),
  ]

function resolve(from: string, specifier: string): string | null {
  const base = path.resolve(path.dirname(from), specifier)
  for (const candidate of [base, `${base}.ts`, `${base}.tsx`, path.join(base, "index.ts"), path.join(base, "index.tsx")]) {
    if (existsSync(candidate) && statSync(candidate).isFile()) return candidate
  }
  return null
}

// Statements at the start of a line only, so an import inside a string
// (the demo's made-up file contents) isn't taken for one.
const IMPORT = /^\s*(?:import|export)\s+(?:type\s+)?(?:[^'"]*?\sfrom\s+)?["']([^"']+)["']|\bimport\(\s*["']([^"']+)["']\s*\)/gm

const parent = new Map<string, string | null>()
const offenders: { file: string; specifier: string }[] = []
const queue: string[] = []
for (const entry of entries) {
  parent.set(entry, null)
  queue.push(entry)
}
while (queue.length > 0) {
  const file = queue.shift()!
  const source = readFileSync(file, "utf8")
  for (const match of source.matchAll(IMPORT)) {
    const statement = match[0]
    // Type-only imports vanish at build time.
    if (/^\s*(import|export)\s+type\s/.test(statement)) continue
    const specifier = match[1] ?? match[2]!
    if (specifier.startsWith(".")) {
      const target = resolve(file, specifier)
      if (target && !parent.has(target)) {
        parent.set(target, file)
        queue.push(target)
      }
    } else if (REACT_PACKAGES.test(specifier)) {
      offenders.push({ file, specifier })
    }
  }
}

function chain(file: string) {
  const steps: string[] = []
  for (let at: string | null | undefined = file; at; at = parent.get(at)) steps.unshift(path.relative(ROOT, at))
  return steps.join("\n    → ")
}

if (offenders.length === 0) {
  console.log(`React-free: ${parent.size} modules reached from ${entries.length} entries`)
  process.exit(0)
}
const seen = new Set<string>()
for (const offender of offenders) {
  if (seen.has(offender.file)) continue
  seen.add(offender.file)
  console.log(`${path.relative(ROOT, offender.file)} imports ${offender.specifier}\n    ${chain(offender.file)}\n`)
}
console.log(`${seen.size} modules reached from the Foldkit app import React or a React library`)
process.exit(1)
