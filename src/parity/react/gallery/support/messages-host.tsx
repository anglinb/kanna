// What the React message-row galleries share: a page that scrolls, a status
// line saying what the last press asked for, and sections of transcript
// rows drawn through KannaTranscriptRow in the row box the viewport gives
// them. Matched by src/parity/foldkit/gallery/support/messages-host.ts.
import { useCallback, useState, type ReactNode } from "react"
import { KannaTranscriptRow } from "../../../../client/app/KannaTranscript"
import { OpenLocalLinkProvider } from "../../../../client/components/messages/shared"
import { TRANSCRIPT_ROW_CLASS } from "../../../../client/components/messages/transcript-row"
import type { AskUserQuestionAnswerMap, AskUserQuestionItem } from "../../../../shared/types"
import type { GallerySection } from "../../../../foldkit/transcript/messages/fixture"
import { describeAnswers, describePlan, describeLocalLinkOpen, NO_ACTION } from "../../../../foldkit/transcript/messages/fixture-status"

export function useGalleryStatus() {
  const [status, setStatus] = useState(NO_ACTION)
  const onAnswer = useCallback((toolUseId: string, _questions: AskUserQuestionItem[], answers: AskUserQuestionAnswerMap) => {
    setStatus(describeAnswers(toolUseId, answers))
  }, [])
  const onPlan = useCallback((toolUseId: string, confirmed: boolean, clearContext?: boolean, message?: string) => {
    setStatus(describePlan(toolUseId, confirmed, clearContext, message))
  }, [])
  return { status, setStatus, onAnswer, onPlan }
}

export function GalleryShell({ status, children }: { status: string; children: ReactNode }) {
  return (
    // #root clips (index.css), so the page scrolls in here.
    <div data-gallery-scroll="" className="h-full overflow-y-auto bg-background py-4 px-3 text-foreground">
      <p role="status" className="mx-auto mb-4 max-w-[816px] px-2 text-sm text-muted-foreground">{status}</p>
      {children}
    </div>
  )
}

export function RowSections({ sections, onAnswer, onPlan, onStatus }: {
  sections: ReadonlyArray<GallerySection>
  onAnswer: (toolUseId: string, questions: AskUserQuestionItem[], answers: AskUserQuestionAnswerMap) => void
  onPlan: (toolUseId: string, confirmed: boolean, clearContext?: boolean, message?: string) => void
  onStatus: (status: string) => void
}) {
  const [expanded, setExpanded] = useState<Record<string, boolean>>({})
  const onExpandedChange = useCallback((groupId: string, next: boolean) => {
    setExpanded((current) => ({ ...current, [groupId]: next }))
  }, [])
  return (
    <OpenLocalLinkProvider onOpenLocalLink={(target) => onStatus(describeLocalLinkOpen(target))}>
      {sections.map((section) => (
        <section key={section.label} aria-label={section.label} className="mb-6">
          <h2 className="mx-auto mb-2 max-w-[816px] px-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{section.label}</h2>
          {section.rows.map((row) => (
            <div key={row.id} className={TRANSCRIPT_ROW_CLASS} data-transcript-row-id={row.id}>
              <KannaTranscriptRow
                row={row}
                toolGroupExpanded={row.kind === "tool-group" ? (expanded[row.id] ?? false) : undefined}
                onToolGroupExpandedChange={onExpandedChange}
                onAskUserQuestionSubmit={onAnswer}
                onExitPlanModeConfirm={onPlan}
              />
            </div>
          ))}
        </section>
      ))}
    </OpenLocalLinkProvider>
  )
}
