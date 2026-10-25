// The React client's markdown renderers on the shared fixtures
// (src/foldkit/markdown/fixture.ts), against src/foldkit/markdown
// (gallery/markdown.ts on the Foldkit side): the transcript's
// TranscriptMarkdown as an agent's answer draws it, with a local-link
// handler; the changelog's react-markdown; and an export's text-mode links.
import { useState } from "react"
import Markdown from "react-markdown"
import remarkGfm from "remark-gfm"
import { TranscriptRenderOptionsProvider } from "../../../client/components/messages/render-context"
import { markdownComponents, OpenLocalLinkProvider, TranscriptMarkdown } from "../../../client/components/messages/shared"
import { CHANGELOG_FIXTURE, describeLocalLink, EXPORT_FIXTURE, transcriptFixture } from "../../../foldkit/markdown/fixture"

export default function MarkdownGallery() {
  const [opened, setOpened] = useState("No local link opened")
  return (
    // #root clips (index.css), so the page scrolls in here.
    <div data-gallery-scroll="" className="h-full overflow-y-auto bg-background p-4 text-foreground">
      <p role="status" className="mb-4 text-sm text-muted-foreground">{opened}</p>
      <div className="grid grid-cols-1 gap-6 lg:grid-cols-[minmax(0,1fr)_minmax(0,1fr)]">
        <section aria-label="Transcript">
          <OpenLocalLinkProvider onOpenLocalLink={(target) => setOpened(describeLocalLink(target))}>
            {/* As AssistantText (TextMessage.tsx) wraps an agent's answer. */}
            <div className="text-pretty prose prose-sm dark:prose-invert px-0.5 w-full max-w-full space-y-4">
              <TranscriptMarkdown text={transcriptFixture(window.location.origin)} />
            </div>
          </OpenLocalLinkProvider>
        </section>
        <div className="space-y-6">
          <section aria-label="Changelog">
            {/* As ChangelogSection draws a release. */}
            <article className="rounded-2xl border border-border px-4 py-4 bg-muted">
              <div className="prose prose-sm mt-4 max-w-none text-foreground dark:prose-invert">
                <Markdown remarkPlugins={[remarkGfm]} components={markdownComponents}>
                  {CHANGELOG_FIXTURE}
                </Markdown>
              </div>
            </article>
          </section>
          <section aria-label="Export">
            <TranscriptRenderOptionsProvider value={{ localLinkMode: "text", sourceOrigin: "http://kanna.example:5174" }}>
              <div className="text-pretty prose prose-sm dark:prose-invert px-0.5 w-full max-w-full space-y-4">
                <TranscriptMarkdown text={EXPORT_FIXTURE} />
              </div>
            </TranscriptRenderOptionsProvider>
          </section>
        </div>
      </div>
    </div>
  )
}
