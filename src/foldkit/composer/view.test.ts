import { describe, test } from "bun:test"
import { Scene } from "foldkit/test"
import { PROVIDERS, type SidebarData } from "../../shared/types"
import { AppAction, batch } from "../app/action"
import type { AppModel } from "../app/slice"
import { SliceOutMessage } from "../app/slice"
import * as Stores from "../app/stores"
import * as ChatSession from "../core/chatSession"
import * as ChatInput from "../core/stores/chatInput"
import { memoryStorage } from "../core/stores/testing"
import * as Commands from "./commands"
import type { ComposerProps } from "./context"
import { Bridge, BridgeComposerEvents, TextareaLifecycle } from "./effects"
import { Message } from "./message"
import { init, type Model } from "./model"
import { updateWith } from "./update"
import { view } from "./view"

// ChatInput's view: what it shows for a project, a running turn, nothing
// to send; and the textarea's keys, which reach it through the event
// bridge (effects.ts) as the browser's do.

const DATA = { projectGroups: [] } as unknown as SidebarData

function props(extra: Partial<ComposerProps> = {}): ComposerProps {
  return {
    chatId: "c1",
    projectId: "p1",
    projectPath: "/work/tidepool",
    projectRepoLabel: "tidepool/main",
    disabled: false,
    canCancel: false,
    activeProvider: "claude",
    availableProviders: PROVIDERS,
    contextWindowSnapshot: null,
    previousPrompt: null,
    listSkills: true,
    editModels: true,
    secondary: false,
    delegate: null,
    ...extra,
  }
}

function scene(extra: Partial<ComposerProps> = {}, drafts: Record<string, string> = {}) {
  const loaded = Stores.load(memoryStorage())
  const stores: Stores.Model = { ...loaded, sidebar: { ...loaded.sidebar, data: DATA, ready: true }, chatInput: { ...loaded.chatInput, drafts } }
  const app = { stores } as AppModel
  const composerProps = props(extra)
  return {
    update: (model: Model, message: Message) => updateWith(model, message, { props: composerProps, stores }),
    view: Scene.withViewInputs(view, { app, props: composerProps })(),
  }
}

const mounted = [
  Scene.Mount.resolve(BridgeComposerEvents, Message.CompletedMountComposer()),
  Scene.Mount.resolve(TextareaLifecycle, Message.CompletedMountTextarea()),
]

const asks = (action: AppAction) => SliceOutMessage.RequestedAppAction({ action })

/** A keydown as the bridge hands it on: the native event's fields that matter. */
function key(key: string, extra: Partial<KeyboardEvent> = {}) {
  return { key, shiftKey: false, altKey: false, ctrlKey: false, metaKey: false, repeat: false, isComposing: false, keyCode: 0, target: { value: "" }, preventDefault: () => {}, ...extra }
}

describe("composer view", () => {
  test("says where the work lands, and offers the mic while there's nothing to send", () => {
    Scene.scene(
      scene(),
      Scene.given(init()),
      ...mounted,
      Scene.expect(Scene.placeholder("Build in tidepool/main")).toExist(),
      Scene.expect(Scene.role("button", { name: "Record voice message" })).toExist(),
      Scene.expect(Scene.role("button", { name: "Send message" })).not.toExist(),
      Scene.expect(Scene.role("button", { name: "Claude" })).toExist(),
    )
  })

  test("a running turn shows Stop, and a click on it stops the turn", () => {
    Scene.scene(
      scene({ canCancel: true }),
      Scene.given(init()),
      ...mounted,
      Scene.expect(Scene.role("button", { name: "Stop" })).toExist(),
      Scene.CustomElement.emit(Bridge, Scene.role("button", { name: "Stop" }), "kanna-composer-pointerdown", { preventDefault: () => {}, metaKey: false, ctrlKey: false }),
      Scene.expectOutMessage(asks(AppAction.Chat({ message: ChatSession.Message.ClickedCancel() }))),
    )
  })

  test("with a draft, Enter sends it", () => {
    Scene.scene(
      scene({}, { c1: "Show the swell" }),
      Scene.given(init()),
      ...mounted,
      Scene.expect(Scene.role("button", { name: "Send message" })).toExist(),
      Scene.CustomElement.emit(Bridge, "textarea[data-chat-input]", "kanna-composer-keydown", key("Enter", { target: { value: "Show the swell" } as never })),
      Scene.Command.resolveAll(
        [Commands.ResetHeight, Message.CompletedSideEffect()],
        [Commands.AutoResize, Message.CompletedSideEffect()],
        [Commands.ClearDraftAfterSend, Message.ClearedDraftAfterSend({ draftId: "c1" })],
      ),
      // The send went first; then, behind it, the draft leaves the store.
      Scene.expectOutMessage(asks(batch(
        AppAction.Store({ message: Stores.Message.GotChatInputMessage({ message: ChatInput.Message.ClearedDraft({ chatId: "c1" }) }) }),
        AppAction.Store({ message: Stores.Message.GotChatInputMessage({ message: ChatInput.Message.ClearedAttachmentDrafts({ chatId: "c1" }) }) }),
      ))),
    )
  })

  test("Tab moves on; it never types a tab", () => {
    Scene.scene(
      scene(),
      Scene.given(init()),
      ...mounted,
      Scene.CustomElement.emit(Bridge, "textarea[data-chat-input]", "kanna-composer-keydown", key("Tab")),
      Scene.Command.resolve(Commands.FocusNextChatInput, Message.CompletedSideEffect()),
    )
  })
})
