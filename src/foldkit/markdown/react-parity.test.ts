import { afterEach, describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { Scene } from "foldkit/test"
import { parseFragment } from "parse5"
import { createElement, type ReactNode } from "react"
import { renderToStaticMarkup } from "react-dom/server"
import Markdown from "react-markdown"
import { MemoryRouter } from "react-router-dom"
import remarkGfm from "remark-gfm"
import { TranscriptRenderOptionsProvider } from "../../client/components/messages/render-context"
import { markdownComponents, OpenLocalLinkProvider, TranscriptMarkdown } from "../../client/components/messages/shared"
import {
  BLOCKS_FIXTURE,
  CHANGELOG_FIXTURE,
  CODE_FIXTURE,
  EXPORT_FIXTURE,
  linksFixture,
  localLinkFixture,
  STRUCTURE_FIXTURE,
  transcriptFixture,
} from "./fixture"
import { changelogMarkdown, CodeCopy, LocalLinkTarget, markdown, transcriptMarkdown, type MarkdownActions, type MarkdownSettings } from "./markdown"

// The DOM the Foldkit renderer builds, against what React renders for the
// same text, element by element: tags, attributes (class tokens, style),
// text. The parity gallery checks the same thing in a browser for pixels
// and the accessibility tree; this covers the cases the gallery can't hold
// (origin-dependent links, the export mode).

type Canon = string | { tag: string; attributes: string[]; children: Canon[] }

function normalizeAttribute(name: string, value: string) {
  if (name === "class") return `class=${value.split(/\s+/).filter(Boolean).join(" ")}`
  if (name === "style") {
    return `style=${value.split(";").map((part) => part.trim().replace(/\s*:\s*/, ":")).filter(Boolean).sort().join(";")}`
  }
  return `${name}=${value}`
}

function mergeText(children: Canon[]): Canon[] {
  const merged: Canon[] = []
  for (const child of children) {
    const previous = merged[merged.length - 1]
    if (typeof child === "string" && typeof previous === "string") merged[merged.length - 1] = previous + child
    else if (child !== "") merged.push(child)
  }
  return merged
}

interface Parse5Node {
  nodeName: string
  value?: string
  attrs?: { name: string; value: string }[]
  childNodes?: Parse5Node[]
}

function fromParse5(node: Parse5Node): Canon[] {
  if (node.nodeName === "#text") return [node.value ?? ""]
  if (node.nodeName.startsWith("#")) return []
  // React's server renderer adds a preload hint for images; the client doesn't.
  if (node.nodeName === "link") return []
  return [{
    tag: node.nodeName,
    attributes: (node.attrs ?? []).map((attribute) => normalizeAttribute(attribute.name, attribute.value)).sort(),
    children: mergeText((node.childNodes ?? []).flatMap(fromParse5)),
  }]
}

function reactCanon(element: ReactNode): Canon[] {
  const html = renderToStaticMarkup(createElement("div", null, element))
  const root = parseFragment(html) as unknown as Parse5Node
  // React's server renderer hoists image preload hints in front of the root.
  const div = root.childNodes!.find((node) => node.nodeName === "div")!
  return (fromParse5(div)[0] as Exclude<Canon, string>).children
}

interface VNodeLike {
  sel?: string
  text?: string
  data?: { attrs?: Record<string, unknown>; props?: Record<string, unknown>; class?: Record<string, boolean>; style?: Record<string, string> }
  children?: Array<VNodeLike | string>
}

function fromVNode(node: VNodeLike | string): Canon[] {
  if (typeof node === "string") return [node]
  if (node.sel === undefined) return [node.text ?? ""]
  const attributes: string[] = []
  for (const [name, value] of Object.entries(node.data?.attrs ?? {})) attributes.push(normalizeAttribute(name, String(value)))
  // Boolean properties as React's markup writes them: present and empty, or absent.
  for (const [name, value] of Object.entries(node.data?.props ?? {})) {
    if (value === false) continue
    attributes.push(normalizeAttribute(name, value === true ? "" : String(value)))
  }
  const classes = Object.entries(node.data?.class ?? {}).filter(([, on]) => on).map(([name]) => name)
  if (classes.length > 0) attributes.push(normalizeAttribute("class", classes.join(" ")))
  const style = Object.entries(node.data?.style ?? {}).map(([name, value]) => `${name}:${value}`).join(";")
  if (style) attributes.push(normalizeAttribute("style", style))
  const children = node.children ?? (node.text !== undefined ? [node.text] : [])
  return [{ tag: node.sel.split(/[#.]/)[0]!, attributes: attributes.sort(), children: mergeText(children.flatMap(fromVNode)) }]
}

const Message = defineMessageUnion({
  ClickedCopyCode: { copy: CodeCopy },
  ClickedLocalLink: { target: LocalLinkTarget },
  ClickedChatLink: { chatId: Schema.String },
})
type Message = typeof Message.Type

const actions: MarkdownActions<Message> = {
  copyCode: (copy: CodeCopy) => Message.ClickedCopyCode({ copy }),
  openLocalLink: (target: LocalLinkTarget) => Message.ClickedLocalLink({ target }),
  openChat: (chatId: string) => Message.ClickedChatLink({ chatId }),
}

function foldkitCanon(text: string, settings: MarkdownSettings<Message>): Canon[] {
  let rendered: Canon[] = []
  const view = (_model: null, h: HtmlBuilder<Message>): Html => h.div([], markdown(text, settings, null, h))
  Scene.scene(
    { update: (model: null) => ({ model }), view },
    Scene.given(null),
    Scene.tap((simulation) => {
      rendered = (fromVNode(simulation.html as unknown as VNodeLike)[0] as Exclude<Canon, string>).children
    }),
  )
  return rendered
}

function transcriptReact(text: string, options: { localLinkMode?: "open" | "text"; sourceOrigin?: string; onOpenLocalLink?: boolean } = {}) {
  let tree: ReactNode = createElement(TranscriptMarkdown, { text })
  if (options.localLinkMode) {
    tree = createElement(TranscriptRenderOptionsProvider, { value: { localLinkMode: options.localLinkMode, sourceOrigin: options.sourceOrigin ?? null }, children: tree })
  }
  if (options.onOpenLocalLink) tree = createElement(OpenLocalLinkProvider, { onOpenLocalLink: () => {}, children: tree })
  return reactCanon(createElement(MemoryRouter, null, tree))
}

function changelogReact(text: string) {
  return reactCanon(createElement(Markdown, { remarkPlugins: [remarkGfm], components: markdownComponents }, text))
}

const ORIGIN = "http://127.0.0.1:4810"
const globals = globalThis as { window?: unknown }

function withWindowOrigin<T>(origin: string, run: () => T): T {
  const previous = globals.window
  globals.window = { location: { origin } }
  try {
    return run()
  } finally {
    globals.window = previous
  }
}

afterEach(() => {
  delete globals.window
})

const FIXTURES = {
  structure: STRUCTURE_FIXTURE,
  code: CODE_FIXTURE,
  links: linksFixture(ORIGIN),
  blocks: BLOCKS_FIXTURE,
  changelog: CHANGELOG_FIXTURE,
  export: EXPORT_FIXTURE,
}

describe("the transcript renderer builds React's DOM", () => {
  for (const [name, text] of Object.entries(FIXTURES)) {
    test(name, () => {
      expect(foldkitCanon(text, transcriptMarkdown(actions))).toEqual(transcriptReact(text, { onOpenLocalLink: true }))
    })
  }

  test("without handlers", () => {
    const text = transcriptFixture(ORIGIN)
    expect(foldkitCanon(text, transcriptMarkdown())).toEqual(transcriptReact(text))
  })

  test("same-origin absolute links, against the page's origin", () => {
    const text = `${linksFixture(ORIGIN)}\n\n${localLinkFixture(ORIGIN)}`
    withWindowOrigin(ORIGIN, () => {
      const react = transcriptReact(text, { onOpenLocalLink: true })
      expect(JSON.stringify(react)).toContain('"href=/chat/def-456"')
      expect(foldkitCanon(text, transcriptMarkdown(actions))).toEqual(react)
    })
  })

  test("a standalone export: local and chat links are text", () => {
    const text = `${EXPORT_FIXTURE}\n\n${linksFixture("http://kanna.example:5174")}\n\n${localLinkFixture(ORIGIN)}`
    const settings = transcriptMarkdown(actions, { localLinkMode: "text", sourceOrigin: "http://kanna.example:5174" })
    withWindowOrigin(ORIGIN, () => {
      expect(foldkitCanon(text, settings)).toEqual(transcriptReact(text, { localLinkMode: "text", sourceOrigin: "http://kanna.example:5174" }))
    })
  })

  test("an export without a source origin", () => {
    const text = `${EXPORT_FIXTURE}\n\n${linksFixture(ORIGIN)}`
    expect(foldkitCanon(text, transcriptMarkdown(actions, { localLinkMode: "text" }))).toEqual(transcriptReact(text, { localLinkMode: "text" }))
  })
})

describe("the changelog renderer builds react-markdown's DOM", () => {
  for (const [name, text] of Object.entries(FIXTURES)) {
    test(name, () => {
      expect(foldkitCanon(text, changelogMarkdown(actions))).toEqual(changelogReact(text))
    })
  }

  test("same-origin absolute links stay plain new-tab links", () => {
    const text = `${linksFixture(ORIGIN)}\n\n${localLinkFixture(ORIGIN)}`
    withWindowOrigin(ORIGIN, () => {
      expect(foldkitCanon(text, changelogMarkdown())).toEqual(changelogReact(text))
    })
  })
})
