/**
 * Radix's typeahead (react-select, react-menu): typed characters build a
 * search that resets after a second of quiet; the next item whose text starts
 * with it is the match. A repeated single character cycles through matches.
 */

function wrapArray<T>(array: ReadonlyArray<T>, startIndex: number): T[] {
  return array.map((_, index) => array[(startIndex + index) % array.length]!)
}

export function findNextMatch<T>(items: ReadonlyArray<T>, textOf: (item: T) => string, search: string, current: T | undefined): T | undefined {
  const isRepeated = search.length > 1 && Array.from(search).every((char) => char === search[0])
  const normalizedSearch = isRepeated ? search[0]! : search
  const currentIndex = current ? items.indexOf(current) : -1
  let wrapped = wrapArray(items, Math.max(currentIndex, 0))
  if (normalizedSearch.length === 1) wrapped = wrapped.filter((item) => item !== current)
  const next = wrapped.find((item) => textOf(item).toLowerCase().startsWith(normalizedSearch.toLowerCase()))
  return next !== current ? next : undefined
}

export function createTypeahead() {
  let search = ""
  let timer = 0
  const set = (value: string) => {
    search = value
    window.clearTimeout(timer)
    if (value !== "") timer = window.setTimeout(() => set(""), 1000)
  }
  return {
    get search() {
      return search
    },
    /** Adds a key to the search and returns the whole search. */
    type(key: string) {
      const next = search + key
      set(next)
      return next
    },
    reset() {
      set("")
    },
    dispose() {
      window.clearTimeout(timer)
    },
  }
}
