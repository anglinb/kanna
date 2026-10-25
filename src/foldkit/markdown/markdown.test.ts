import { describe, expect, test } from "bun:test"
import { Schema } from "effect"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { Lazy, Scene } from "foldkit/test"
import { CHANGELOG_FIXTURE, CODE_FIXTURE } from "./fixture"
import {
  changelogMarkdown,
  CodeCopy,
  COPIED_BUTTON_CLASS,
  COPY_BUTTON_CLASS,
  lazyMarkdown,
  LocalLinkTarget,
  markdown,
  transcriptMarkdown,
  type MarkdownActions,
  type MarkdownSettings,
} from "./markdown"
import { clearMarkdownCache, getMarkdownCacheStats, parseMarkdown } from "./parse"

const Model = Schema.Struct({ text: Schema.String, copiedBlock: Schema.NullOr(Schema.Number), events: Schema.Array(Schema.String) })
type Model = typeof Model.Type

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

const transcript = transcriptMarkdown(actions)
const changelog = changelogMarkdown(actions)

function describeTarget(target: LocalLinkTarget) {
  return `${target.trigger} ${target.path}${target.line !== undefined ? `:${target.line}` : ""}${target.column !== undefined ? `:${target.column}` : ""}`
}

const update = (model: Model, message: Message) => {
  const event = Message.match(message, {
    ClickedCopyCode: ({ copy }) => `copy ${copy.block}: ${copy.text}`,
    ClickedLocalLink: ({ target }) => describeTarget(target),
    ClickedChatLink: ({ chatId }) => `chat ${chatId}`,
  })
  return { model: { ...model, events: [...model.events, event], copiedBlock: message._tag === "ClickedCopyCode" ? message.copy.block : model.copiedBlock } }
}

function appView(settings: MarkdownSettings<Message>) {
  return (model: Model, h: HtmlBuilder<Message>): Document => ({
    title: "Kanna",
    body: h.div([], [
      h.div([h.Class("prose")], markdown(model.text, settings, model.copiedBlock, h)),
      h.ul([h.AriaLabel("Events")], model.events.map((event) => h.li([], [event]))),
    ]),
  })
}

const given = (text: string) => Scene.given<Model>({ text, copiedBlock: null, events: [] })

describe("interactive overrides", () => {
  test("a local file link reports its path, line and column on click and right-click", () => {
    Scene.scene(
      { update, view: appView(transcript) },
      given("[at](/Users/jake/app.ts#L12C4) and [suffix](/Users/jake/server.ts:40) and [bare](/Users/jake/notes.md)"),
      Scene.click(Scene.role("link", { name: "at" })),
      Scene.expect(Scene.text("click /Users/jake/app.ts:12:4")).toExist(),
      Scene.contextMenu(Scene.role("link", { name: "suffix" })),
      Scene.expect(Scene.text("contextmenu /Users/jake/server.ts:40")).toExist(),
      Scene.click(Scene.role("link", { name: "bare" })),
      Scene.expect(Scene.text("click /Users/jake/notes.md")).toExist(),
    )
  })

  test("a local file link has no target and no rel; an external one opens in a new tab", () => {
    Scene.scene(
      { update, view: appView(transcript) },
      given("[file](/Users/jake/app.ts) [site](https://example.com)"),
      Scene.expect(Scene.role("link", { name: "file" })).toHaveAttr("href", "/Users/jake/app.ts"),
      Scene.expect(Scene.role("link", { name: "file" })).not.toHaveAttr("target"),
      Scene.expect(Scene.role("link", { name: "site" })).toHaveAttr("target", "_blank"),
      Scene.expect(Scene.role("link", { name: "site" })).toHaveAttr("rel", "noopener noreferrer"),
    )
  })

  test("without an openLocalLink action a local link has no handler", () => {
    expect(() => Scene.scene(
      { update, view: appView(transcriptMarkdown<Message>({ copyCode: actions.copyCode })) },
      given("[file](/Users/jake/app.ts)"),
      Scene.click(Scene.role("link", { name: "file" })),
    )).toThrow(/click handler/)
  })

  test("a chat link is a route link that reports its chat", () => {
    Scene.scene(
      { update, view: appView(transcript) },
      given("[Other chat](/chat/abc-123?ticket=tk_1)"),
      Scene.expect(Scene.role("link", { name: "Other chat" })).toHaveAttr("href", "/chat/abc-123?ticket=tk_1"),
      Scene.expect(Scene.role("link", { name: "Other chat" })).toHaveAttr("data-discover", "true"),
      Scene.click(Scene.role("link", { name: "Other chat" })),
      Scene.expect(Scene.text("chat abc-123")).toExist(),
    )
  })

  test("the copy button reports the block's text and index, and shows the check when copied", () => {
    Scene.scene(
      { update, view: appView(transcript) },
      given("```\nfirst\n```\n\n```ts\nsecond()\n```"),
      Scene.expectAll(Scene.all.selector("button svg.lucide-copy")).toHaveCount(2),
      Scene.click(Scene.last(Scene.all.role("button"))),
      Scene.expect(Scene.text("copy 1: second()", { exact: false })).toExist(),
      Scene.expect(Scene.within(Scene.last(Scene.all.role("button")), Scene.selector("svg.lucide-check"))).toExist(),
      Scene.expect(Scene.within(Scene.first(Scene.all.role("button")), Scene.selector("svg.lucide-copy"))).toExist(),
      Scene.expect(Scene.last(Scene.all.role("button"))).toHaveAttr("class", COPIED_BUTTON_CLASS),
    )
  })

  test("the changelog's links all open in a new tab and dispatch nothing", () => {
    Scene.scene(
      { update, view: appView(changelog) },
      given(CHANGELOG_FIXTURE),
      Scene.expect(Scene.role("link", { name: "App.tsx" })).toHaveAttr("target", "_blank"),
      Scene.expect(Scene.role("link", { name: "chat" })).toHaveAttr("target", "_blank"),
      Scene.expect(Scene.role("link", { name: "chat" })).not.toHaveAttr("data-discover"),
    )
    expect(() => Scene.scene(
      { update, view: appView(changelog) },
      given(CHANGELOG_FIXTURE),
      Scene.click(Scene.role("link", { name: "App.tsx" })),
    )).toThrow(/click handler/)
  })

  test("export mode draws local and chat links as text", () => {
    Scene.scene(
      { update, view: appView(transcriptMarkdown(actions, { localLinkMode: "text" })) },
      given("[file](/Users/jake/app.ts) [chat](/chat/abc) [site](https://example.com)"),
      Scene.expect(Scene.role("link", { name: "file" })).not.toExist(),
      Scene.expect(Scene.role("link", { name: "chat" })).not.toExist(),
      Scene.expect(Scene.text("file")).toExist(),
      Scene.expect(Scene.role("link", { name: "site" })).toExist(),
    )
  })
})

describe("overrides", () => {
  test("the copy button's classes are React's CopyButton's", () => {
    expect(COPY_BUTTON_CLASS).toBe("touch-manipulation inline-flex items-center justify-center whitespace-nowrap cursor-pointer text-sm font-medium ring-offset-background focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none hover:bg-accent dark:hover:bg-card disabled:text-muted-foreground/50 border border-border/0 hover:border-border absolute top-[35px] -translate-y-[50%] -translate-x-[1px] rounded-md right-1.5 h-8 w-8 text-muted-foreground opacity-0 group-hover/pre:opacity-100 transition-opacity hover:text-foreground")
    expect(COPIED_BUTTON_CLASS).toContain("hover:!bg-transparent hover:!border-transparent")
    expect(COPIED_BUTTON_CLASS).not.toContain("hover:text-foreground")
  })

  test("headings, tables, task lists and inline code", () => {
    Scene.scene(
      { update, view: appView(transcript) },
      given("# Title\n\n| a | b |\n|:-|-:|\n| `x` | 2 |\n\n- [x] done\n- [ ] open"),
      Scene.expect(Scene.role("heading", { name: "Title", level: 1 })).toHaveAttr("class", "text-[20px] font-normal leading-tight mt-5 mb-3 first:mt-0 last:mb-0"),
      Scene.expect(Scene.selector("div.border table.table-auto tbody.divide-y tr td")).toExist(),
      Scene.expect(Scene.role("columnheader", { name: "a" })).toHaveStyle("text-align", "left"),
      Scene.expect(Scene.role("cell", { name: "2" })).toHaveStyle("text-align", "right"),
      Scene.expect(Scene.selector("td code.break-all")).toExist(),
      Scene.expect(Scene.role("checkbox", { checked: true })).toBeDisabled(),
      Scene.expect(Scene.role("checkbox", { checked: false })).toExist(),
    )
  })

  test("a fenced block without a language gets the inline code styling, as in React", () => {
    Scene.scene(
      { update, view: appView(transcript) },
      given(CODE_FIXTURE),
      Scene.expect(Scene.selector("pre code.block.whitespace-pre")).toExist(),
      Scene.expect(Scene.selector("pre code.break-all")).toExist(),
    )
  })
})

describe("parseMarkdown", () => {
  test("parses once per text", () => {
    clearMarkdownCache()
    const a = parseMarkdown("# Title\n\nSome **bold** text")
    expect(parseMarkdown("# Title\n\nSome **bold** text")).toBe(a)
    expect(parseMarkdown("other")).not.toBe(a)
    expect(getMarkdownCacheStats().entries).toBe(2)
  })

  test("builds the tree react-markdown would: gfm, raw html as text, safe urls", () => {
    const tree = parseMarkdown("| a |\n|---|\n| b |\n\n<b>raw</b>\n\n[x](javascript:alert(1))")
    const json = JSON.stringify(tree)
    expect(json).toContain('"tagName":"table"')
    expect(json).toContain('"value":"<b>"')
    expect(json).not.toContain("javascript:")
  })
})

describe("lazyMarkdown", () => {
  test("reuses the rendered block while nothing changed", () => {
    const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
      title: "Kanna",
      body: h.div([], [lazyMarkdown("row-1", model.text, "prose", transcript, model.copiedBlock, h)]),
    })
    Lazy.expectAllReused({ view, model: { text: CODE_FIXTURE, copiedBlock: 1, events: [] } })
  })
})
