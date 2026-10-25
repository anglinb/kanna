/**
 * Markdown documents that exercise everything the renderers handle, shared
 * by the unit tests and the parity gallery (src/parity/{react,foldkit}/
 * gallery/markdown.*), so both apps render the same text.
 */

const LONG_WORDS = "Lorem ipsum dolor sit amet, consectetur adipiscing elit, sed do eiusmod tempor incididunt ut labore et dolore magna aliqua. Ut enim ad minim veniam, quis nostrud exercitation ullamco laboris nisi ut aliquip ex ea commodo consequat."
const LONG_TOKEN = "src/client/components/messages/a_very_long_identifier_without_any_break_opportunities_that_keeps_going_and_going_until_it_overflows.tsx"

/** Headings, inline marks, lists, task lists and tables. */
export const STRUCTURE_FIXTURE = `# Heading one

## Heading two

### Heading three

#### Heading four

##### Heading five

###### Heading six

A paragraph with *emphasis*, **strong**, ***both***, ~~strikethrough~~, \`inline code\` and a hard break
on the next line. An autolink https://example.com/docs and a [titled link](https://example.com/page "Example page").

- Bullet one
- Bullet two
  - Nested bullet
    - Deeper bullet with \`code\`
- Bullet three

1. First
2. Second
   1. Nested ordered
   2. Another
3. Third

A list that starts later:

7. Starts at seven
8. Eight

- [ ] An open task
- [x] A finished task
  - [ ] A nested task

| Left | Centre | Right | Default |
|:-----|:------:|------:|---------|
| a | b | c | d |
| \`code\` | **bold** | [link](https://example.com/table) | ${LONG_WORDS} |
`

/** Fenced and indented code, inline code, long lines. */
export const CODE_FIXTURE = `Fenced with a language:

\`\`\`ts
const greeting: string = "hello"
console.log(greeting)
\`\`\`

Fenced without one:

\`\`\`
plain fenced block
  keeps its indentation
\`\`\`

    an indented code block

A long line of code that scrolls sideways:

\`\`\`sh
bun run parity gallery-markdown --region page && echo "${LONG_TOKEN}" | tee /tmp/output.log
\`\`\`

Inline code that has to break: \`${LONG_TOKEN}\`

${LONG_WORDS} ${LONG_WORDS}
`

/**
 * Every link form the transcript recognises. Absolute same-origin local
 * links keep their href as written, which carries the page's port, so they
 * are left to the unit tests (`localLinkFixture`).
 */
export function linksFixture(origin: string) {
  return `Local files: [App.tsx](/Users/jake/Projects/kanna/src/client/app/App.tsx), [line](/Users/jake/Projects/kanna/src/client/app/App.tsx#L12), [line and column](/Users/jake/Projects/kanna/src/client/app/App.tsx#L12C4), [suffix line](/Users/jake/Projects/kanna/src/server/agent.ts:40), [suffix column](/Users/jake/Projects/kanna/src/server/agent.ts:40:7) and a bare path [/home/dev/notes.md](/home/dev/notes.md).

Chats: [Other chat](/chat/abc-123), [a ticket](/chat/deleg-9?ticket=tk_00000d), [same origin](${origin}/chat/def-456) and [another origin](https://other.example/chat/abc-123).

Not local: [docs](https://docs.example/guide), [mail](mailto:team@example.com), [relative](docs/readme.md), [anchor](#section), [unsafe](javascript:alert(1)), [file url](file:///etc/hosts).
`
}

/** Absolute same-origin local links, recognised against `origin`. */
export function localLinkFixture(origin: string) {
  return `[same origin](${origin}/Users/jake/app.ts#L3) and [same origin suffix](${origin}/Users/jake/app.ts:3:9) and [other origin](https://elsewhere.example/Users/jake/app.ts)`
}

/** Quotes, rules, images, raw HTML, footnotes. */
export const BLOCKS_FIXTURE = `> A blockquote with **bold** text.
>
> - and a list inside
>
> > and a nested quote

---

![The Kanna icon](/icon-192.png "Kanna")

Inline <b>html</b> stays as text, <span style="color:red">styled</span> too.

<div class="raw">A raw HTML block</div>

A footnote reference[^note] and another[^2].

[^note]: The footnote's text, with a [link](https://example.com/footnote).
[^2]: Second note.
`

/** What a release body looks like, for the changelog renderer. */
export const CHANGELOG_FIXTURE = `## What's new

- Chats can be **forked** from any message ([#412](https://github.com/jakemor/kanna/pull/412))
- The \`kanna\` CLI gained \`slim-transcripts\`
- Local and chat links open in a new tab here: [App.tsx](/Users/jake/app.tsx#L3), [chat](/chat/abc-123)

### Fixes

1. Reconnects no longer drop queued prompts
2. Tables render with borders:

| Change | Kind |
|--------|:----:|
| socket | fix |

\`\`\`sh
npm install -g kanna-code@latest
\`\`\`

> Thanks to everyone who reported issues.
`

/** A transcript in a standalone export: local and chat links as inert text. */
export const EXPORT_FIXTURE = `[Source chat](http://kanna.example:5174/chat/abc-123), [external chat](https://other.example/chat/abc-123), [relative chat](/chat/abc-123), [a file](/Users/jake/app.ts#L3) and [docs](https://docs.example/guide).`

/** How the gallery reports an opened local link, in both apps. */
export function describeLocalLink(target: { path: string; line?: number; column?: number; trigger?: string }) {
  return `Opened ${target.path}${target.line !== undefined ? `:${target.line}` : ""}${target.column !== undefined ? `:${target.column}` : ""} (${target.trigger ?? "click"})`
}

/** Every fixture in one document, as an agent's long answer would mix them. */
export function transcriptFixture(origin: string) {
  return [STRUCTURE_FIXTURE, CODE_FIXTURE, linksFixture(origin), BLOCKS_FIXTURE].join("\n")
}
