// src/foldkit/markdown on the shared fixtures (src/foldkit/markdown/
// fixture.ts), against the React client's renderers (gallery/markdown.tsx
// on the React side). Also the wiring a caller does: the copy button's
// Command and its two-second check, and a local-link Message.
import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { copyTextToClipboard } from "../../../client/lib/clipboard"
import { CHANGELOG_FIXTURE, describeLocalLink, EXPORT_FIXTURE, transcriptFixture } from "../../../foldkit/markdown/fixture"
import { changelogMarkdown, CodeCopy, lazyMarkdown, LocalLinkTarget, markdownBlock, transcriptMarkdown } from "../../../foldkit/markdown"
import { galleryPage } from "../gallery-page"

const Copied = Schema.Struct({ doc: Schema.String, block: Schema.Number })

const Model = Schema.Struct({ opened: Schema.String, copied: Schema.NullOr(Copied) })
type Model = typeof Model.Type

const Message = defineMessageUnion({
  ClickedCopyCode: { doc: Schema.String, copy: CodeCopy },
  CopiedCode: { doc: Schema.String, block: Schema.Number },
  FailedCopyCode: {},
  ExpiredCopiedCode: { doc: Schema.String, block: Schema.Number },
  ClickedLocalLink: { target: LocalLinkTarget },
})
type Message = typeof Message.Type

const CopyCode = Command.define("CopyCode", {
  args: { doc: Schema.String, text: Schema.String, block: Schema.Number },
  messages: [Message.CopiedCode, Message.FailedCopyCode],
  execute: ({ doc, text, block }) =>
    Effect.promise(() => copyTextToClipboard(text)).pipe(
      Effect.map((copied) => (copied ? Message.CopiedCode({ doc, block }) : Message.FailedCopyCode())),
    ),
})

// CopyButton shows its check for two seconds.
const ExpireCopiedCode = Command.define("ExpireCopiedCode", {
  args: { doc: Schema.String, block: Schema.Number },
  messages: [Message.ExpiredCopiedCode],
  execute: ({ doc, block }) => Effect.sleep("2 seconds").pipe(Effect.as(Message.ExpiredCopiedCode({ doc, block }))),
})

const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ClickedCopyCode: ({ doc, copy }) => ({ model, commands: [CopyCode({ doc, text: copy.text, block: copy.block })] }),
    CopiedCode: ({ doc, block }) => ({ model: { ...model, copied: { doc, block } }, commands: [ExpireCopiedCode({ doc, block })] }),
    FailedCopyCode: () => ({ model }),
    ExpiredCopiedCode: ({ doc, block }) => ({
      model: model.copied?.doc === doc && model.copied.block === block ? { ...model, copied: null } : model,
    }),
    ClickedLocalLink: ({ target }) => ({ model: { ...model, opened: describeLocalLink(target) } }),
  })

const copyIn = (doc: string) => (copy: CodeCopy) => Message.ClickedCopyCode({ doc, copy })

// One settings object per call site, kept for the page's life: lazyMarkdown
// compares it by reference.
const transcript = transcriptMarkdown<Message>({
  copyCode: copyIn("transcript"),
  openLocalLink: (target) => Message.ClickedLocalLink({ target }),
})
const changelog = changelogMarkdown<Message>({ copyCode: copyIn("changelog") })
const exported = transcriptMarkdown<Message>({ copyCode: copyIn("export") }, { localLinkMode: "text", sourceOrigin: "http://kanna.example:5174" })

const TRANSCRIPT_TEXT = transcriptFixture(window.location.origin)
const ANSWER_CLASS = "text-pretty prose prose-sm dark:prose-invert px-0.5 w-full max-w-full space-y-4"

function copiedIn(model: Model, doc: string) {
  return model.copied?.doc === doc ? model.copied.block : null
}

export default galleryPage<Model, Message>({
  Model,
  init: () => ({ model: { opened: "No local link opened", copied: null } }),
  update,
  view: (model, h: HtmlBuilder<Message>): Document => ({
    title: "Kanna",
    // #root clips (index.css), so the page scrolls in here.
    body: h.div([h.DataAttribute("gallery-scroll", ""), h.Class("h-full overflow-y-auto bg-background p-4 text-foreground")], [
      h.p([h.Role("status"), h.Class("mb-4 text-sm text-muted-foreground")], [model.opened]),
      h.div([h.Class("grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]")], [
        h.section([h.AriaLabel("Transcript")], [
          lazyMarkdown("gallery-transcript", TRANSCRIPT_TEXT, ANSWER_CLASS, transcript, copiedIn(model, "transcript"), h),
        ]),
        h.div([h.Class("space-y-6")], [
          h.section([h.AriaLabel("Changelog")], [
            h.article([h.Class("rounded-2xl border border-border px-4 py-4 bg-muted")], [
              markdownBlock(CHANGELOG_FIXTURE, "prose prose-sm mt-4 max-w-none text-foreground dark:prose-invert", changelog, copiedIn(model, "changelog"), h),
            ]),
          ]),
          h.section([h.AriaLabel("Export")], [
            markdownBlock(EXPORT_FIXTURE, ANSWER_CLASS, exported, copiedIn(model, "export"), h),
          ]),
        ]),
      ]),
    ]),
  }),
})
