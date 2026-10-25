import { Schema } from "effect"
import type { Element, ElementContent, Root, RootContent } from "hast"
import { createKeyedLazy, type Attribute, type Html, type HtmlBuilder } from "foldkit/html"
import { parseChatLink } from "../../shared/chat-links"
import { chatIdFromChatPath } from "../../client/lib/chat-open"
import { parseLocalFileLink } from "../../client/lib/pathUtils"
import { cn } from "../../client/lib/utils"
import { Check, Copy } from "../ui/icons"
import { parseMarkdown } from "./parse"

/**
 * Markdown as Foldkit Html: the hast tree from `./parse.ts`, converted the
 * way react-markdown's `hast-util-to-jsx-runtime` step converts it, with the
 * same component overrides as `src/client/components/messages/shared.tsx`
 * (`markdownComponents` and `createMarkdownComponents`). The DOM matches
 * what React renders, quirks included (see "Matching React" below).
 *
 * Interactive parts (a code block's copy button, a local file link, a link
 * to another chat) dispatch Messages the caller names in `MarkdownActions`;
 * the caller's update does the work (copy, open, navigate). The one piece of
 * state, which copy button shows its check, comes back in as `copiedBlock`.
 */

// ── Messages the caller wires ────────────────────────────────────────────

/** What a local file link reports, as React's `OpenLocalLinkTarget` without the pointer position. */
export const LocalLinkTarget = Schema.Struct({
  path: Schema.String,
  line: Schema.optional(Schema.Number),
  column: Schema.optional(Schema.Number),
  trigger: Schema.Literals(["click", "contextmenu"]),
})
export type LocalLinkTarget = typeof LocalLinkTarget.Type

/** A copy button press: the block's text, and its index among the document's code blocks. */
export const CodeCopy = Schema.Struct({ text: Schema.String, block: Schema.Number })
export type CodeCopy = typeof CodeCopy.Type

/**
 * Message constructors for the interactive overrides. Each is optional;
 * without one the element renders the same and does what React does with no
 * handler: a copy button that dispatches nothing, a local link the browser
 * follows, a chat link the app's router follows.
 */
export interface MarkdownActions<Message> {
  /** A code block's copy button was pressed. Copy `text` (e.g. `copyTextToClipboard` in a Command), then pass `block` back as `copiedBlock` for two seconds, as React's CopyButton does. */
  readonly copyCode?: (copy: CodeCopy) => Message
  /**
   * A local file link was clicked or right-clicked (React's
   * `OpenLocalLinkProvider` handler). Both prevent the browser's default.
   * Foldkit's click and contextmenu attributes carry no pointer position, so
   * a context menu has to anchor to the link (or the pointer, tracked
   * elsewhere) rather than to `clientX/clientY`.
   */
  readonly openLocalLink?: (target: LocalLinkTarget) => Message
  /**
   * A link to another Kanna chat was clicked (React's
   * `ChatReferenceActions.onOpenChat`). Prevents the default. React leaves
   * Shift/Alt-clicks and other buttons to the browser; Foldkit's click
   * attribute can't see modifiers, so this fires for every primary click.
   */
  readonly openChat?: (chatId: string) => Message
}

/** Which React renderer to match. */
export type MarkdownVariant =
  /** `TranscriptMarkdown`: `createMarkdownComponents()`, with local file and chat links. */
  | "transcript"
  /** The changelog's `<Markdown components={markdownComponents}>`: every link opens in a new tab. */
  | "changelog"

/**
 * Everything about a rendering that isn't the text. Make one per call site
 * and keep it (module scope, or in the Model): lazy views compare it by
 * reference.
 */
export interface MarkdownSettings<Message> {
  readonly variant: MarkdownVariant
  readonly actions: MarkdownActions<Message>
  /** React's `TranscriptRenderOptions.localLinkMode`: "text" draws local and chat links as inert spans (standalone exports). */
  readonly localLinkMode: "open" | "text"
  /** React's `TranscriptRenderOptions.sourceOrigin`: in "text" mode, the origin absolute chat links are recognised against. */
  readonly sourceOrigin: string | null
}

export function transcriptMarkdown<Message>(
  actions: MarkdownActions<Message> = {},
  options: { localLinkMode?: "open" | "text"; sourceOrigin?: string | null } = {},
): MarkdownSettings<Message> {
  return { variant: "transcript", actions, localLinkMode: options.localLinkMode ?? "open", sourceOrigin: options.sourceOrigin ?? null }
}

export function changelogMarkdown<Message>(actions: Pick<MarkdownActions<Message>, "copyCode"> = {}): MarkdownSettings<Message> {
  return { variant: "changelog", actions, localLinkMode: "open", sourceOrigin: null }
}

// ── Entry points ─────────────────────────────────────────────────────────

/** An element's child: what `h.div([...], children)` takes. */
export type MarkdownChild = Html | string

/**
 * The rendered children of `text`, for the caller to put in its own element
 * (React's `<TranscriptMarkdown text>` is a fragment too). Parsing is cached
 * by text; the conversion runs on every call, so wrap the caller's row in a
 * lazy view, or use `lazyMarkdown`.
 */
export function markdown<Message>(text: string, settings: MarkdownSettings<Message>, copiedBlock: number | null, h: HtmlBuilder<Message>): ReadonlyArray<MarkdownChild> {
  return markdownTree(parseMarkdown(text), settings, copiedBlock, h)
}

/** `markdown` for an already-parsed tree. */
export function markdownTree<Message>(tree: Root, settings: MarkdownSettings<Message>, copiedBlock: number | null, h: HtmlBuilder<Message>): ReadonlyArray<MarkdownChild> {
  const context: Context<Message> = { h, settings, copiedBlock, nextBlock: 0 }
  return tree.children.flatMap((child) => renderNode(child, context))
}

/** `markdown` inside a `<div class={className}>`, the shape every React call site has. */
export function markdownBlock<Message>(text: string, className: string, settings: MarkdownSettings<Message>, copiedBlock: number | null, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class(className)], markdown(text, settings, copiedBlock, h))
}

const lazyBlocks = createKeyedLazy()

/**
 * `markdownBlock`, memoized per `key`: while `text`, `className`,
 * `settings` (by reference) and `copiedBlock` are unchanged, the previous
 * vnode is reused and neither converted nor diffed. Foldkit never evicts a
 * key, so use keys from a bounded set (a row id within one chat, a call
 * site); a transcript that outlives its chat should memoize its own rows.
 */
export function lazyMarkdown<Message>(key: string, text: string, className: string, settings: MarkdownSettings<Message>, copiedBlock: number | null, h: HtmlBuilder<Message>): Html {
  return lazyBlocks(key, markdownBlock<Message>, [text, className, settings, copiedBlock, h])
}

// ── Matching React ───────────────────────────────────────────────────────
//
// - Overrides that spread their props (`<p className="…" {...props}>`) also
//   get `node`, the hast node `passNode` hands every component, and React
//   writes an object-valued unknown prop as the string "[object Object]". So
//   those elements carry node="[object Object]" in React's DOM, and here.
// - A spread after `className` lets the hast className win (a footnote's
//   back-reference keeps class="data-footnote-backref").
// - Headings take no props: a heading loses its id and class (the footnote
//   label is visible, not sr-only).
// - `code` is inline when it has no class, so a fenced block without a
//   language gets the inline styling inside its `<pre>`.
// - `a` in the changelog opens every link, local and chat ones too, in a new tab.

const HEADING_CLASSES: Record<string, string> = {
  h1: "text-[20px] font-normal leading-tight mt-5 mb-3 first:mt-0 last:mb-0",
  h2: "text-[18px] font-normal leading-tight mt-5 mb-3 first:mt-0 last:mb-0",
  h3: "text-[16px] font-normal leading-tight mt-5 mb-3 first:mt-0 last:mb-0",
  h4: "text-[16px] font-normal leading-tight mt-5 mb-3 first:mt-0 last:mb-0",
  h5: "text-[16px] font-normal leading-tight mt-5 mb-3 first:mt-0 last:mb-0",
  h6: "text-[16px] font-normal leading-tight mt-5 mb-3 first:mt-0 last:mb-0",
}

// Overrides of the form `<tag className="…" {...props}>{children}</tag>`.
const SPREAD_CLASSES: Record<string, string> = {
  p: "break-words mt-5 mb-3 first:mt-0 last:mb-0",
  tbody: "divide-y divide-border",
  th: "text-left text-xs uppercase text-muted-foreground tracking-wider p-2 pl-0 first:pl-3 bg-muted dark:bg-card [&_*]:font-semibold",
  td: "text-left    p-2 pl-0 first:pl-3 [&_*]:font-normal ",
  blockquote: "my-2 mt-5 mb-3 first:mt-0 last:mb-0 border-l-2 border-border/80 pl-2 text-muted-foreground",
}

const PRE_WRAPPER_CLASS = "relative overflow-x-auto max-w-full min-w-0 no-code-highlight group/pre"
const PRE_CLASS = "min-w-0 rounded-xl py-2.5 px-3.5 [.no-pre-highlight_&]:bg-background"
const INLINE_CODE_CLASS = "break-all px-1 bg-border/60 dark:[.no-pre-highlight_&]:bg-background dark:[.text-pretty_&]:bg-neutral [.no-code-highlight_&]:!bg-transparent py-0.5 rounded text-sm whitespace-wrap"
const BLOCK_CODE_CLASS = "block text-xs whitespace-pre"
const TABLE_WRAPPER_CLASS = "border border-border  rounded-xl overflow-x-auto"
const TABLE_CLASS = "table-auto min-w-full divide-y divide-border bg-surface"
const LINK_CLASS = "transition-all underline decoration-2 text-logo decoration-logo/50 hover:text-logo/70 dark:text-logo dark:decoration-logo/70 dark:hover:text-logo/60 dark:hover:decoration-logo/40 "
const CHAT_LINK_CLASS = "transition-all underline decoration-2 text-logo decoration-logo/50 hover:text-logo/70"
const LOCAL_LINK_TEXT_CLASS = "transition-all underline decoration-2 text-logo decoration-logo/50"
const NODE_PROP = "[object Object]"

// The pre's CopyButton: `<Button variant="ghost" size="icon">` from
// components/ui/button.tsx with the className shared.tsx passes, resolved
// through the same cva + cn as React.
const BUTTON_BASE_CLASS = "touch-manipulation inline-flex items-center justify-center whitespace-nowrap cursor-pointer rounded-md text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none"
const BUTTON_GHOST_CLASS = "hover:bg-accent dark:hover:bg-card hover:text-accent-foreground text-muted-foreground disabled:text-muted-foreground/50 border border-border/0 hover:border-border"
const BUTTON_ICON_CLASS = "h-9 w-9 rounded-full"
const PRE_COPY_CLASS = "absolute top-[35px] -translate-y-[50%] -translate-x-[1px] rounded-md right-1.5 h-8 w-8 text-muted-foreground opacity-0 group-hover/pre:opacity-100 transition-opacity"
export const COPY_BUTTON_CLASS = cn(BUTTON_BASE_CLASS, BUTTON_GHOST_CLASS, BUTTON_ICON_CLASS, cn(PRE_COPY_CLASS, "hover:text-foreground"))
export const COPIED_BUTTON_CLASS = cn(BUTTON_BASE_CLASS, BUTTON_GHOST_CLASS, BUTTON_ICON_CLASS, cn(PRE_COPY_CLASS, "hover:!bg-transparent hover:!border-transparent"))

// ── Conversion ───────────────────────────────────────────────────────────

interface Context<Message> {
  readonly h: HtmlBuilder<Message>
  readonly settings: MarkdownSettings<Message>
  readonly copiedBlock: number | null
  /** Index of the next code block, in document order. */
  nextBlock: number
}

/** React props as hast-util-to-jsx-runtime builds them, already in DOM attribute form. */
interface Props {
  readonly attributes: Map<string, string>
  readonly style: Record<string, string> | undefined
  /**
   * A task list's checkbox state, set as properties: React sets
   * `input.checked` (and `defaultChecked`), and Foldkit's Checked/Disabled
   * are what its accessibility queries read.
   */
  readonly checked: boolean | undefined
  readonly disabled: boolean | undefined
}

type ElementFunction = (attributes: ReadonlyArray<unknown>, children?: ReadonlyArray<MarkdownChild>) => Html

// Whitespace-only text in these is dropped (hast-util-to-jsx-runtime does,
// because React rejects text inside table structure).
const TABLE_ELEMENTS = new Set(["table", "tbody", "thead", "tfoot", "tr"])
const TABLE_CELLS = new Set(["td", "th"])
const VOID_ELEMENTS = new Set(["area", "base", "br", "col", "embed", "hr", "img", "input", "link", "meta", "source", "track", "wbr"])

// hast property names React renders as boolean attributes (present or absent).
const BOOLEAN_PROPERTIES = new Set([
  "allowFullScreen", "async", "autoFocus", "autoPlay", "checked", "controls", "default", "defer", "disabled",
  "formNoValidate", "hidden", "inert", "isMap", "itemScope", "loop", "multiple", "muted", "noModule",
  "noValidate", "open", "playsInline", "readOnly", "required", "reversed", "scoped", "seamless", "selected",
])

const SPECIAL_ATTRIBUTE_NAMES: Record<string, string> = {
  className: "class",
  htmlFor: "for",
  httpEquiv: "http-equiv",
  acceptCharset: "accept-charset",
}

function attributeName(property: string): string {
  const special = SPECIAL_ATTRIBUTE_NAMES[property]
  if (special) return special
  if (/^data[A-Z0-9]/.test(property)) return `data-${property.slice(4).replace(/[A-Z]/g, (letter) => `-${letter.toLowerCase()}`).replace(/^-/, "")}`
  if (/^aria[A-Z]/.test(property)) return `aria-${property.slice(4).toLowerCase()}`
  return property.toLowerCase()
}

function isWhitespace(value: string) {
  return /^[ \t\n\f\r]*$/.test(value)
}

/**
 * The props hast-util-to-jsx-runtime gives an element, written as React
 * writes them to the DOM. `className`, when given, replaces the hast class
 * (React's `cloneElement(child, { className })`).
 */
function hastProps(node: Element, className?: string): Props {
  const attributes = new Map<string, string>()
  let style: Record<string, string> | undefined
  let checked: boolean | undefined
  let disabled: boolean | undefined
  for (const property in node.properties) {
    if (!Object.hasOwn(node.properties, property)) continue
    let value = node.properties[property]
    if (property === "className" && className !== undefined) continue
    if (value === null || value === undefined || (typeof value === "number" && Number.isNaN(value))) continue
    if (Array.isArray(value)) value = value.join(" ")
    const name = attributeName(property)
    if (name === "align" && typeof value === "string" && TABLE_CELLS.has(node.tagName)) {
      style = { ...style, "text-align": value }
      continue
    }
    // Only produced by raw HTML, which is text by now; React drops a style it can't parse.
    if (name === "style") continue
    if (typeof value === "boolean") {
      if (property === "checked") checked = value
      else if (property === "disabled") disabled = value
      else if (name.startsWith("data-") || name.startsWith("aria-")) attributes.set(name, String(value))
      else if (value && BOOLEAN_PROPERTIES.has(property)) attributes.set(name, "")
      continue
    }
    const text = String(value)
    // React 19 writes no empty src, nor an empty href except on <a>.
    if (text === "" && (name === "src" || name === "href") && !(name === "href" && node.tagName === "a")) continue
    attributes.set(name, text)
  }
  if (className !== undefined) attributes.set("class", className)
  return { attributes, style, checked, disabled }
}

/** `<tag className={base} {...props}>`: the hast props (and `node`) win over `base`. */
function spreadProps(base: string, node: Element, className?: string): Props {
  const props = hastProps(node, className)
  const attributes = new Map([["class", base]])
  for (const [name, value] of props.attributes) attributes.set(name, value)
  attributes.set("node", NODE_PROP)
  return { ...props, attributes }
}

function toAttributes<Message>(props: Props, h: HtmlBuilder<Message>): Array<Attribute<Message>> {
  const attributes: Array<Attribute<Message>> = []
  for (const [name, value] of props.attributes) {
    attributes.push(name === "class" && value !== "" ? h.Class(value) : h.Attribute(name, value))
  }
  if (props.style) attributes.push(h.Style(props.style))
  if (props.checked !== undefined) attributes.push(h.Checked(props.checked))
  if (props.disabled) attributes.push(h.Disabled(true))
  return attributes
}

function element<Message>(tag: string, attributes: ReadonlyArray<Attribute<Message>>, children: ReadonlyArray<MarkdownChild>, h: HtmlBuilder<Message>): Html {
  const build = (h as unknown as Record<string, ElementFunction | undefined>)[tag]
  // Markdown only yields standard HTML tags (raw HTML is text by now); an
  // unknown one renders as a span rather than crash the view.
  const make = typeof build === "function" ? build : (h.span as unknown as ElementFunction)
  return VOID_ELEMENTS.has(tag) ? make(attributes) : make(attributes, children)
}

function renderNode<Message>(node: RootContent | ElementContent, context: Context<Message>, className?: string): ReadonlyArray<MarkdownChild> {
  if (node.type === "text") return [node.value]
  if (node.type === "element") return [renderElement(node, context, className)]
  // Comments, doctypes and leftover raw nodes render nothing, as in React.
  return []
}

function renderChildren<Message>(node: Element, context: Context<Message>): Array<MarkdownChild> {
  const children = node.children.flatMap((child) => renderNode(child, context))
  return TABLE_ELEMENTS.has(node.tagName)
    ? children.filter((child) => typeof child !== "string" || !isWhitespace(child))
    : children
}

function textContent(node: Element | ElementContent): string {
  if (node.type === "text") return node.value
  if (node.type === "element") return node.children.map(textContent).join("")
  return ""
}

function hastClass(node: Element): string | undefined {
  const value = node.properties.className
  if (value === null || value === undefined || value === false) return undefined
  return Array.isArray(value) ? value.join(" ") : String(value)
}

function renderElement<Message>(node: Element, context: Context<Message>, className?: string): Html {
  const { h } = context
  const tag = node.tagName
  const heading = HEADING_CLASSES[tag]
  if (heading !== undefined) return h[tag as "h1"]([h.Class(heading)], renderChildren(node, context))
  switch (tag) {
    case "pre":
      return renderPre(node, context, className)
    case "code":
      return renderCode(node, context, className)
    case "table":
      return h.div([h.Class(TABLE_WRAPPER_CLASS)], [
        h.table(toAttributes(spreadProps(TABLE_CLASS, node, className), h), renderChildren(node, context)),
      ])
    case "blockquote":
      return renderBlockquote(node, context, className)
    case "a":
      return context.settings.variant === "transcript"
        ? renderTranscriptLink(node, context, className)
        : h.a(toAttributes(linkProps(node, className), h), renderChildren(node, context))
  }
  const spread = SPREAD_CLASSES[tag]
  const props = spread !== undefined ? spreadProps(spread, node, className) : hastProps(node, className)
  return element(tag, toAttributes(props, h), renderChildren(node, context), h)
}

function renderPre<Message>(node: Element, context: Context<Message>, className?: string): Html {
  const { h, settings } = context
  const block = context.nextBlock++
  const text = textContent(node)
  const copied = context.copiedBlock === block
  const copyCode = settings.actions.copyCode
  return h.div([h.Class(PRE_WRAPPER_CLASS)], [
    h.pre(toAttributes(spreadProps(PRE_CLASS, node, className), h), renderChildren(node, context)),
    h.button(
      [h.Class(copied ? COPIED_BUTTON_CLASS : COPY_BUTTON_CLASS), ...(copyCode ? [h.OnClick(copyCode({ text, block }))] : [])],
      [copied ? Check({ class: "h-4 w-4 text-green-400" }, h) : Copy({ class: "h-4 w-4" }, h)],
    ),
  ])
}

function renderCode<Message>(node: Element, context: Context<Message>, className?: string): Html {
  const { h } = context
  const inline = !(className ?? hastClass(node))
  // `className` is taken out of the props before the spread.
  const props = spreadProps(inline ? INLINE_CODE_CLASS : BLOCK_CODE_CLASS, { ...node, properties: { ...node.properties, className: undefined } })
  return h.code(toAttributes(props, h), renderChildren(node, context))
}

function renderBlockquote<Message>(node: Element, context: Context<Message>, className?: string): Html {
  const { h } = context
  // React adds mt-0 to the first child and mb-0 to the last with
  // cloneElement, which only touches elements. remark-rehype wraps a
  // blockquote's content in newline text nodes, so in practice neither end
  // is an element and nothing changes; kept for the trees where one is.
  const last = node.children.length - 1
  const children = node.children.flatMap((child, index) => {
    if (child.type !== "element" || (index !== 0 && index !== last)) return renderNode(child, context)
    let childClass = hastClass(child)
    if (index === 0) childClass = cn(childClass, "mt-0")
    if (index === last) childClass = cn(childClass, "mb-0")
    return renderNode(child, context, childClass)
  })
  return h.blockquote(toAttributes(spreadProps(SPREAD_CLASSES.blockquote!, node, className), h), children)
}

/** `markdownComponents.a`: `<a className target="_blank" rel {...props}>`. */
function linkProps(node: Element, className: string | undefined): Props {
  const props = spreadProps(LINK_CLASS, node, className)
  const attributes = new Map([["class", LINK_CLASS], ["target", "_blank"], ["rel", "noopener noreferrer"]])
  for (const [name, value] of props.attributes) attributes.set(name, value)
  return { ...props, attributes }
}

/** `createMarkdownComponents().a`: chat links, local file links, then everything else. */
function renderTranscriptLink<Message>(node: Element, context: Context<Message>, className?: string): Html {
  const { h, settings } = context
  const children = renderChildren(node, context)
  const rawHref = node.properties.href
  const href = rawHref === null || rawHref === undefined ? undefined : String(rawHref)
  const textMode = settings.localLinkMode === "text"
  const chatOrigin = textMode
    ? settings.sourceOrigin ?? undefined
    : typeof window === "undefined" ? undefined : window.location.origin
  const chatLink = parseChatLink(href, chatOrigin)
  if (chatLink) {
    // Standalone exports have no router to resolve a chat against.
    if (textMode) return h.span([h.Class(CHAT_LINK_CLASS)], children)
    // React Router's <Link {...props} className to={chatLink}>: the props
    // spread first, so its class is fixed; the href is the route.
    const props = spreadProps(CHAT_LINK_CLASS, withoutHref(node), className)
    props.attributes.set("class", CHAT_LINK_CLASS)
    props.attributes.set("href", chatLink)
    props.attributes.set("data-discover", "true")
    const chatId = chatIdFromChatPath(chatLink)
    const openChat = settings.actions.openChat
    return h.a(
      [...toAttributes(props, h), ...(openChat && chatId ? [h.OnClick(openChat(chatId), { defaultAction: "Prevent" })] : [])],
      children,
    )
  }
  const local = parseLocalFileLink(href)
  if (local && textMode) return h.span([h.Class(LOCAL_LINK_TEXT_CLASS)], children)
  // <a className href target rel onClick onContextMenu {...props}>, href taken out of props.
  const attributes = new Map([["class", LINK_CLASS]])
  if (href !== undefined) attributes.set("href", href)
  if (!local) {
    attributes.set("target", "_blank")
    attributes.set("rel", "noopener noreferrer")
  }
  const spread = spreadProps(LINK_CLASS, withoutHref(node), className)
  for (const [name, value] of spread.attributes) attributes.set(name, value)
  const openLocalLink = settings.actions.openLocalLink
  const events = local && openLocalLink
    ? [
        h.OnClick(openLocalLink(localTarget(local, "click")), { defaultAction: "Prevent" }),
        h.OnContextMenu(openLocalLink(localTarget(local, "contextmenu"))),
      ]
    : []
  return h.a([...toAttributes({ ...spread, attributes }, h), ...events], children)
}

function withoutHref(node: Element): Element {
  return { ...node, properties: { ...node.properties, href: undefined } }
}

function localTarget(link: { path: string; line?: number; column?: number }, trigger: LocalLinkTarget["trigger"]): LocalLinkTarget {
  return {
    path: link.path,
    ...(link.line !== undefined ? { line: link.line } : {}),
    ...(link.column !== undefined ? { column: link.column } : {}),
    trigger,
  }
}
