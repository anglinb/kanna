// src/foldkit/chat/emptyState.ts's project section (the picker and the
// project's chats) against the React one (gallery/chat-empty-state.tsx).
import { Command } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { modifyFields } from "foldkit/struct"
import type { AppModel } from "../../../foldkit/app/slice"
import * as ChatInput from "../../../foldkit/core/stores/chatInput"
import * as Tooltip from "../../../foldkit/ui/tooltip"
import { projectPickerView } from "../../../foldkit/chat/emptyState"
import { projectChatsView } from "../../../foldkit/chat/emptyStateProject"
import { Message } from "../../../foldkit/chat/message"
import { init, Model } from "../../../foldkit/chat/model"
import { EMPTY_STATE_PROJECT_ID, EMPTY_STATE_PROJECT_PATH, EMPTY_STATE_SIDEBAR } from "../../gallery-support/empty-state-sidebar"
import { galleryPage } from "../gallery-page"

// The page's view reads the root's stores; this is as much of them as the
// section reads.
const app = {
  stores: {
    sidebar: { data: EMPTY_STATE_SIDEBAR, ready: true },
    chatInput: ChatInput.initialModel,
  },
} as unknown as AppModel

type Return = { model: Model; commands?: ReadonlyArray<Command.Command<Message>> }

function update(model: Model, message: Message): Return {
  switch (message._tag) {
    case "GotTooltipMessage": {
      const result = Tooltip.update(model.tooltips[message.id], message.message)
      return {
        model: modifyFields(model, { tooltips: (tooltips) => ({ ...tooltips, [message.id]: result.model }) }),
        commands: Command.mapMessages(result.commands, (inner: Tooltip.Message) => Message.GotTooltipMessage({ id: message.id, message: inner })),
      }
    }
    case "StartedProjectChats":
      return { model: modifyFields(model, { projectChats: () => ({ query: "", cascadeDone: false, nowMs: message.nowMs, stuck: false }) }) }
    case "ElapsedProjectChatsCascade":
      return { model: modifyFields(model, { projectChats: (state) => ({ ...state, cascadeDone: true }) }) }
    case "ChangedProjectChatsStuck":
      return { model: modifyFields(model, { projectChats: (state) => ({ ...state, stuck: message.stuck }) }) }
    case "ChangedProjectChatsQuery":
      return { model: modifyFields(model, { projectChats: (state) => ({ ...state, query: message.value, cascadeDone: true }) }) }
    default:
      return { model }
  }
}

export default galleryPage<Model, Message>({
  Model,
  init: () => ({ model: init() }),
  update,
  view: (model, h: HtmlBuilder<Message>): Document => ({
    title: "Kanna",
    body: h.div([h.Class("relative h-dvh bg-background text-foreground")], [
      h.div([h.Class("pointer-events-none absolute inset-x-4"), h.Style({ top: "0px", bottom: "0px" })], [
        h.div([
          h.DataAttribute("empty-state-scroller", ""),
          h.Class("pointer-events-auto mx-auto flex h-full max-w-[840px] flex-col items-center overflow-y-auto scrollbar-hide"),
          h.Style({ "--empty-state-header-offset": "72px" }),
        ], [
          h.div([h.AriaHidden(true), h.Class("w-full shrink-0"), h.Style({ height: "72px" })], []),
          h.div([h.Class("my-auto flex w-full flex-col items-center gap-[6vh] py-6")], [
            h.div([h.Class("flex w-full flex-col items-center gap-4")], [
              h.div([h.Class("flex max-w-full justify-center transition-opacity duration-300 pointer-events-auto opacity-100")], [
                projectPickerView(model, EMPTY_STATE_PROJECT_PATH, h),
              ]),
            ]),
            h.div([h.Class("flex w-full justify-center transition-opacity duration-500 pointer-events-auto opacity-100")], [
              h.div([h.Class("w-full space-y-3")], [
                projectChatsView(model, app, EMPTY_STATE_PROJECT_ID, null, false, h),
              ]),
            ]),
          ]),
        ]),
      ]),
    ]),
  }),
})
