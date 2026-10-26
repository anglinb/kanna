// Pure comparisons between a reference capture (React) and a candidate
// capture (Foldkit). No IO here, so the rules are unit-tested
// (compare.test.ts) and the runner only moves files around.

/** One element that paints something: text, a background, a border, an image. */
export interface PaintItem {
  tag: string
  /** x, y, width, height in CSS px, rounded. */
  box: [number, number, number, number]
  text: string
  style: Record<string, string>
}

export interface Capture {
  url: string
  title: string
  paint: PaintItem[]
  aria: string
  commands: unknown[]
  subscriptions: unknown[]
  unhandled: unknown[]
  errors: string[]
}

export type CheckStatus = "identical" | "tolerated" | "different"

export interface CheckResult {
  check: "pixels" | "paint" | "aria" | "commands" | "subscriptions" | "unhandled" | "errors" | "url" | "title"
  status: CheckStatus
  detail: string[]
}

const BOX_TOLERANCE_PX = 1

function sameBox(a: PaintItem["box"], b: PaintItem["box"]) {
  return a.every((value, index) => Math.abs(value - b[index]!) <= BOX_TOLERANCE_PX)
}

function describeItem(item: PaintItem) {
  const text = item.text ? ` "${item.text.slice(0, 60)}"` : ""
  return `<${item.tag}>${text} at ${item.box.join(",")}`
}

/**
 * Matches painted elements by text and box, ignoring tag names and wrapper
 * elements (a React <div> and a Foldkit <span> that paint the same thing at
 * the same place are the same item), then compares their computed styles.
 * Catches what pixels can miss: cursor, a color one step off, a hidden
 * outline.
 */
export function comparePaint(reference: PaintItem[], candidate: PaintItem[]): CheckResult {
  const detail: string[] = []
  const used = new Set<number>()
  for (const item of reference) {
    const index = candidate.findIndex((other, i) => !used.has(i) && other.text === item.text && sameBox(other.box, item.box))
    if (index === -1) {
      detail.push(`missing in candidate: ${describeItem(item)}`)
      continue
    }
    used.add(index)
    const other = candidate[index]!
    for (const key of Object.keys(item.style)) {
      if (item.style[key] !== other.style[key]) {
        detail.push(`${describeItem(item)}: ${key} ${item.style[key]} → ${other.style[key] ?? "(unset)"}`)
      }
    }
  }
  candidate.forEach((item, index) => {
    if (!used.has(index)) detail.push(`extra in candidate: ${describeItem(item)}`)
  })
  return { check: "paint", status: detail.length === 0 ? "identical" : "different", detail }
}

/** Line diff of two accessibility snapshots, LCS-based so one change is one hunk. */
export function diffLines(a: string, b: string): string[] {
  const left = a.split("\n")
  const right = b.split("\n")
  const table: number[][] = Array.from({ length: left.length + 1 }, () => new Array(right.length + 1).fill(0))
  for (let i = left.length - 1; i >= 0; i--) {
    for (let j = right.length - 1; j >= 0; j--) {
      table[i]![j] = left[i] === right[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!)
    }
  }
  const out: string[] = []
  let i = 0
  let j = 0
  while (i < left.length && j < right.length) {
    if (left[i] === right[j]) {
      i++
      j++
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      out.push(`- ${left[i++]}`)
    } else {
      out.push(`+ ${right[j++]}`)
    }
  }
  while (i < left.length) out.push(`- ${left[i++]}`)
  while (j < right.length) out.push(`+ ${right[j++]}`)
  return out
}

export function compareAria(reference: string, candidate: string): CheckResult {
  const detail = reference === candidate ? [] : diffLines(reference, candidate)
  return { check: "aria", status: detail.length === 0 ? "identical" : "different", detail }
}

const ID_PATTERN = /\b(?:[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}|[0-9a-z]{6,}-[0-9a-z]{4,}-[0-9a-z]{4,})\b/gi

/**
 * Generated ids (uuids, client-made terminal and message ids) differ between
 * runs, so they become placeholders numbered by first appearance. Two logs
 * that use the same id in the same places still compare equal.
 */
export function normalizeIds(values: unknown[]): string[] {
  const seen = new Map<string, string>()
  return values.map((value) =>
    stableStringify(value).replace(ID_PATTERN, (id) => {
      if (!seen.has(id)) seen.set(id, `<id${seen.size + 1}>`)
      return seen.get(id)!
    }),
  )
}

export function stableStringify(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(stableStringify).join(",")}]`
  if (value && typeof value === "object") {
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, v]) => v !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${stableStringify(v)}`).join(",")}}`
  }
  return JSON.stringify(value)
}

/** Commands must match in order: that order is what the server sees. */
export function compareCommands(reference: unknown[], candidate: unknown[]): CheckResult {
  const left = normalizeIds(reference)
  const right = normalizeIds(candidate)
  const detail = left.join("\n") === right.join("\n") ? [] : diffLines(left.join("\n"), right.join("\n"))
  return { check: "commands", status: detail.length === 0 ? "identical" : "different", detail }
}

/** Subscriptions are compared as a multiset: boot opens them concurrently. */
export function compareSubscriptions(reference: unknown[], candidate: unknown[]): CheckResult {
  const left = normalizeIds(reference).sort()
  const right = normalizeIds(candidate).sort()
  const detail = left.join("\n") === right.join("\n") ? [] : diffLines(left.join("\n"), right.join("\n"))
  return { check: "subscriptions", status: detail.length === 0 ? "identical" : "different", detail }
}

export function comparePixels(differentPixels: number, totalPixels: number, toleranceRatio: number): CheckResult {
  const ratio = totalPixels === 0 ? 0 : differentPixels / totalPixels
  const status: CheckStatus = differentPixels === 0 ? "identical" : ratio <= toleranceRatio ? "tolerated" : "different"
  return {
    check: "pixels",
    status,
    detail: differentPixels === 0 ? [] : [`${differentPixels} px differ (${(ratio * 100).toFixed(3)}%, tolerance ${(toleranceRatio * 100).toFixed(3)}%)`],
  }
}

export function compareCaptures(reference: Capture, candidate: Capture, origins: { reference: string; candidate: string }): CheckResult[] {
  const results: CheckResult[] = []
  const path = (url: string, origin: string) => url.startsWith(origin) ? url.slice(origin.length) : url
  const refUrl = path(reference.url, origins.reference)
  const candUrl = path(candidate.url, origins.candidate)
  results.push({ check: "url", status: refUrl === candUrl ? "identical" : "different", detail: refUrl === candUrl ? [] : [`${refUrl} → ${candUrl}`] })
  results.push({ check: "title", status: reference.title === candidate.title ? "identical" : "different", detail: reference.title === candidate.title ? [] : [`${reference.title} → ${candidate.title}`] })
  results.push(comparePaint(reference.paint, candidate.paint))
  results.push(compareAria(reference.aria, candidate.aria))
  results.push(compareCommands(reference.commands, candidate.commands))
  results.push(compareSubscriptions(reference.subscriptions, candidate.subscriptions))
  // Absolute, not relative: any unhandled command or console error fails,
  // even one the reference shares.
  const unhandled = [...reference.unhandled.map((c) => `reference: ${stableStringify(c)}`), ...candidate.unhandled.map((c) => `candidate: ${stableStringify(c)}`)]
  results.push({ check: "unhandled", status: unhandled.length === 0 ? "identical" : "different", detail: unhandled })
  const errors = [...reference.errors.map((e) => `reference: ${e}`), ...candidate.errors.map((e) => `candidate: ${e}`)]
  results.push({ check: "errors", status: errors.length === 0 ? "identical" : "different", detail: errors })
  return results
}

export function passes(results: CheckResult[]) {
  return results.every((result) => result.status !== "different")
}
