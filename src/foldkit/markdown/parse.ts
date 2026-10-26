import type { Root } from "hast"
import { urlAttributes } from "html-url-attributes"
import remarkGfm from "remark-gfm"
import remarkParse from "remark-parse"
import remarkRehype from "remark-rehype"
import { unified } from "unified"
import { visit } from "unist-util-visit"

/**
 * Parsed markdown, cached by source text. The Foldkit side of
 * `src/client/lib/markdown-cache.ts`, which this copies rather than imports:
 * that module takes `defaultUrlTransform` from react-markdown, and this one
 * must outlive React.
 *
 * Parsing is the most expensive thing a transcript row does, and every
 * mount pays it: react-markdown's `<Markdown>` parses inside render. A
 * profile of opening a 150-message chat put 516 ms of a 1,087 ms task in
 * micromark, all for rows that were parsed the last time the chat was
 * open. The hast tree is a plain immutable object, so it can outlive the
 * row and be handed to the vnode converter again on the next render.
 *
 * The pipeline mirrors what react-markdown does with the same options
 * (`remark-parse`, `remark-gfm`, `remark-rehype`, then its post pass that
 * neutralizes raw HTML and sanitizes URL attributes), so the output is the
 * same tree `<Markdown>` would have built. Both React renderers (the
 * transcript's and the changelog's `<Markdown remarkPlugins={[remarkGfm]}>`)
 * build this tree. Keep them in step if either's options change.
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

const SAFE_PROTOCOL = /^(https?|ircs?|mailto|xmpp)$/i

/**
 * react-markdown's `defaultUrlTransform` (v10), copied: a URL with a
 * protocol other than http(s), irc(s), mailto or xmpp becomes "".
 */
export function defaultUrlTransform(value: string): string {
  const colon = value.indexOf(":")
  const questionMark = value.indexOf("?")
  const numberSign = value.indexOf("#")
  const slash = value.indexOf("/")
  if (
    // No protocol: relative.
    colon === -1
    // The first colon is after a `?`, `#` or `/`: not a protocol.
    || (slash !== -1 && colon > slash)
    || (questionMark !== -1 && colon > questionMark)
    || (numberSign !== -1 && colon > numberSign)
    || SAFE_PROTOCOL.test(value.slice(0, colon))
  ) {
    return value
  }
  return ""
}

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
        if (test === null || test!.includes(node.tagName)) {
          node.properties[key] = defaultUrlTransform(String(node.properties[key] || ""))
        }
      }
    }
    return undefined
  })
  return tree
}

/** The hast tree for `text`, parsed once and reused. Callers must not mutate it. */
export function parseMarkdown(text: string): Root {
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
export function getMarkdownCacheStats() {
  return { entries: cache.size, chars: cachedChars }
}

export function clearMarkdownCache() {
  cache.clear()
  cachedChars = 0
}
