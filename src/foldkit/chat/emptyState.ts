import type { Html, HtmlBuilder } from "foldkit/html"
import { EMPTY_STATE_TEXT } from "../../client/app/ChatPage/utils"
import { TRANSCRIPT_PADDING_BOTTOM_OFFSET } from "../../client/app/kannaStateHelpers"
import { getPathBasename } from "../../client/lib/formatters"
import { formatPathWithTilde } from "../../client/lib/pathUtils"
import { cn } from "../../client/lib/utils"
import type { AppModel } from "../app/slice"
import { ChevronDown, Flower } from "../ui/icons"
import * as Tooltip from "../ui/tooltip"
import { Message } from "./message"
import type { Model } from "./model"
import type { PageFacts } from "./page"
import type { ChatPageContext } from "./pageInputs"

// The new chat page's empty state, as ChatTranscriptViewport drew it when
// `showEmptyState` (src/client/app/ChatPage/ChatTranscriptViewport.tsx), with
// EmptyStateProject's picker. The transcript calls it through the
// `emptyState` view input (pageInputs.ts), so it sits where React put it.

type H = HtmlBuilder<Message>

/** The header's height the transcript leaves at its top (CHAT_NAVBAR_OFFSET_PX). */
const HEADER_OFFSET_PX = 72

/**
 * The project the chat will start in, by its folder name. The full path is in
 * the tooltip rather than revealed in place: the button is centred, so growing
 * it would move the chevron out from under the pointer. Pressing it opens the
 * palette's "New Chat in…" page.
 */
function projectPickerView(model: Model, localPath: string, h: H): Html {
  return h.submodel({
    slotId: "tooltip-picker",
    model: model.tooltips.picker,
    view: Tooltip.view,
    viewInputs: {
      side: "bottom",
      content: () => [formatPathWithTilde(localPath)],
      toView: ({ trigger, portal }) => h.button([
        h.Type("button"),
        h.OnClick(Message.ClickedProjectPicker()),
        h.AriaLabel(`Switch project (${formatPathWithTilde(localPath)})`),
        h.Class("flex h-8 min-w-0 max-w-full items-center gap-1.5 rounded-lg border border-border pl-3 pr-2 text-sm text-muted-foreground outline-none transition-colors hover:bg-muted hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"),
        ...trigger,
      ], [
        h.span([h.Class("min-w-0 truncate")], [getPathBasename(localPath)]),
        ChevronDown({ class: "size-3.5 shrink-0" }, h),
        portal,
      ]),
    },
    toParentMessage: (message) => Message.GotTooltipMessage({ id: "picker", message }),
  })
}

export function emptyStateView(model: Model, _app: AppModel, facts: PageFacts, page: ChatPageContext, h: H): Html {
  // Animates in only on the entrance that types the hero line out; a page
  // that opens already typed shows as is.
  const animatesIn = !page.isEmptyStateTypingComplete
  const complete = page.isEmptyStateTypingComplete
  const projectId = facts.projectId
  const projectPath = page.projectPath
  return h.div([
    h.Class(cn("pointer-events-none absolute inset-x-4", animatesIn && "animate-fade-in")),
    h.Style({
      // To the window's top, not the header's bottom: scrolled, the content
      // passes under the header and its fade.
      top: "0px",
      // Align the scroll area's bottom to the top of the chat input.
      bottom: `${Math.max(0, page.transcriptPaddingBottom - TRANSCRIPT_PADDING_BOTTOM_OFFSET)}px`,
    }),
  ], [
    // The composer's width, so the project card lines up with it.
    h.div([
      h.DataAttribute("empty-state-scroller", ""),
      h.Class("pointer-events-auto mx-auto flex h-full max-w-[840px] flex-col items-center overflow-y-auto scrollbar-hide"),
      h.Style({ "--empty-state-header-offset": `${HEADER_OFFSET_PX}px` }),
    ], [
      h.div([h.AriaHidden(true), h.Class("w-full shrink-0"), h.Style({ height: `${HEADER_OFFSET_PX}px` })], []),
      // Flexbox-only center-or-scroll: my-auto centers the group when there's
      // room, but its auto margins collapse once the content outgrows the
      // container, so overflow-y-auto scrolls it from the top instead.
      h.div([h.Class("my-auto flex w-full flex-col items-center gap-[6vh] py-6")], [
        h.div([h.Class("flex w-full flex-col items-center gap-4")], [
          h.div([h.Class("flex flex-col items-center justify-center gap-4 text-muted-foreground opacity-70")], [
            Flower({ strokeWidth: 1.5, class: cn("size-8 text-muted-foreground", animatesIn && "kanna-empty-state-flower") }, h),
            h.div([
              h.Class(cn(animatesIn && "kanna-empty-state-text", "flex max-w-xs items-center text-center text-base font-normal text-muted-foreground")),
              h.AriaLabel(EMPTY_STATE_TEXT),
            ], [
              h.span([h.Class("relative inline-grid place-items-start")], [
                h.span([h.Class("invisible col-start-1 row-start-1 flex items-center whitespace-pre")], [
                  h.span([], [EMPTY_STATE_TEXT]),
                  h.span([h.Class("kanna-typewriter-cursor-slot"), h.AriaHidden(true)], []),
                ]),
                h.span([h.Class("col-start-1 row-start-1 flex items-center whitespace-pre")], [
                  h.span([], [page.typedEmptyStateText]),
                  h.span([h.Class("kanna-typewriter-cursor-slot"), h.AriaHidden(true)], [
                    h.span([h.Class("kanna-typewriter-cursor"), h.DataAttribute("typing-complete", complete ? "true" : "false")], []),
                  ]),
                ]),
              ]),
            ]),
          ]),
          // Where the chat will start, under the line that asks what to
          // build. Outside the dimmed group so it reads as a control.
          projectId && projectPath
            ? h.div([h.Class(cn(
              "flex max-w-full justify-center transition-opacity duration-300",
              complete ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
            ))], [projectPickerView(model, projectPath, h)])
            : null,
        ]),
        // Everything below sits on the page background, like the sidebars'
        // lists: onboarding first while it applies, then the project's chats.
        h.div([h.Class(cn(
          "flex w-full justify-center transition-opacity duration-500",
          complete ? "pointer-events-auto opacity-100" : "pointer-events-none opacity-0",
        ))], [
          h.div([h.Class("w-full space-y-3")], []),
        ]),
      ]),
    ]),
  ])
}
