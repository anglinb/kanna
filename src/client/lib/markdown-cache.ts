import type { Root } from "hast"
import { urlAttributes } from "html-url-attributes"
import { defaultUrlTransform } from "react-markdown"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import { unified } from "unified"
import { visit } from "unist-util-visit"

/**
 * Parsed markdown, cached by source text.
 *
 * Parsing is the most expensive thing a transcript row does, and every
 * mount pays it: react-markdown's `<Markdown>` parses inside render. A
 * profile of opening a 150-message chat put 516 ms of a 1,087 ms task in
 * micromark, all for rows that were parsed the last time the chat was
 * open. The hast tree is a plain immutable object, so it can outlive the
 * row and be handed to the JSX converter again on the next mount.
 *
 * The pipeline mirrors what react-markdown does with the same options
 * (`remark-parse`, `remark-gfm`, `remark-rehype`, then its post pass that
 * neutralizes raw HTML and sanitizes URL attributes), so the output is the
 * same tree `<Markdown>` would have built. Keep them in step if the
 * transcript's markdown options change.
 *
 * Bounded by source characters, not entries: one 200 KB message costs what
 * it costs, and a cap in characters keeps the retained trees proportional.
 * Eviction is least-recently-used via Map insertion order.
 */

const CACHE_LIMIT_CHARS = 8 * 1024 * 1024

// `allowDangerousHtml` keeps inline HTML as raw nodes so the pass below can
// show it as literal text, the way react-markdown does. Without it the tags
// are dropped and `<b>x</b>` renders as just `x`.
const processor = unified().use(remarkParse).use(remarkGfm).use(remarkRehype, { allowDangerousHtml: true })

const cache = new Map<string, Root>()
let cachedChars = 0

function parse(text: string): Root {
  const tree = processor.runSync(processor.parse(text)) as Root
  // Same post pass as react-markdown: raw HTML becomes text (`skipHtml`
  // off), and URL-bearing attributes go through its default transform.
  visit(tree, (node, index, parent) => {
    if (node.type === "raw" && parent && typeof index === "number") {
      parent.children[index] = { type: "text", value: node.value }
      return index
    }
    if (node.type === "element") {
      for (const key in urlAttributes) {
        if (!Object.hasOwn(urlAttributes, key) || !Object.hasOwn(node.properties, key)) continue
        const test = urlAttributes[key]
        if (test === null || test.includes(node.tagName)) {
          node.properties[key] = defaultUrlTransform(String(node.properties[key] || ""))
        }
      }
    }
    return undefined
  })
  return tree
}

/** The hast tree for `text`, parsed once and reused. Callers must not mutate it. */
export function parseTranscriptMarkdown(text: string): Root {
  const hit = cache.get(text)
  if (hit) {
    // Refresh recency.
    cache.delete(text)
    cache.set(text, hit)
    return hit
  }
  const tree = parse(text)
  if (text.length <= CACHE_LIMIT_CHARS) {
    while (cachedChars + text.length > CACHE_LIMIT_CHARS) {
      const oldest = cache.keys().next().value
      if (oldest === undefined) break
      cache.delete(oldest)
      cachedChars -= oldest.length
    }
    cache.set(text, tree)
    cachedChars += text.length
  }
  return tree
}

/** Test hook. */
export function getTranscriptMarkdownCacheStats() {
  return { entries: cache.size, chars: cachedChars }
}

export function clearTranscriptMarkdownCache() {
  cache.clear()
  cachedChars = 0
}
