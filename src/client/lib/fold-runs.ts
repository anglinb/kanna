/**
 * The transcript's folding of consecutive rows, for any list of them: two or
 * more foldable rows in a row are one group, a lone one stays a row, and a
 * row that does not fold ends the run. A row that draws nothing (`shown`
 * false) inside a run is passed over: it neither ends the run nor joins it.
 * `KannaTranscript` folds a chat's tool calls with it.
 */
export type FoldedRun<T> =
  | { type: "single"; item: T; index: number }
  | { type: "group"; items: T[]; startIndex: number }

export function foldRuns<T>(
  items: readonly T[],
  folds: (item: T) => boolean,
  shown: (index: number) => boolean = () => true,
): FoldedRun<T>[] {
  const result: FoldedRun<T>[] = []
  let index = 0

  while (index < items.length) {
    const item = items[index]!
    if (shown(index) && folds(item)) {
      const group: T[] = [item]
      const startIndex = index
      index += 1

      while (index < items.length) {
        if (!shown(index)) {
          index += 1
          continue
        }
        const next = items[index]!
        if (!folds(next)) break
        group.push(next)
        index += 1
      }

      result.push(group.length >= 2 ? { type: "group", items: group, startIndex } : { type: "single", item, index: startIndex })
      continue
    }

    result.push({ type: "single", item, index })
    index += 1
  }

  return result
}

export interface FoldCategory {
  key: string
  singular: string
  plural: string
}

/** What a folded group says of itself: "3 reads, 2 edits", each kind in order of first appearance. */
export function foldedRunLabel<T>(items: readonly T[], categoryOf: (item: T) => FoldCategory): string {
  const counts = new Map<string, { category: FoldCategory; count: number }>()
  for (const item of items) {
    const category = categoryOf(item)
    const existing = counts.get(category.key)
    if (existing) existing.count += 1
    else counts.set(category.key, { category, count: 1 })
  }
  return [...counts.values()]
    .map(({ category, count }) => `${count} ${count === 1 ? category.singular : category.plural}`)
    .join(", ")
}
