// src/foldkit/composer against the React ChatInput (gallery/composer.tsx), in
// the state `?state=` names (parity/gallery-support/composer-states.ts). The
// page holds the stores the composer reads and applies the store changes it
// asks for, as the root would; sends and cancels go nowhere, as the React
// page's handlers do nothing.
import { Effect, Option, Schema } from "effect"
import { Command, Subscription } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { projectDelegators, resolveDelegateTarget } from "../../../client/lib/delegators"
import { getProjectSidebarLabel } from "../../../client/lib/project-label"
import { flattenSidebarThreads } from "../../../client/lib/thread-sections"
import { createDemoAppSettings } from "../../../demo/backend"
import { readThemeParam } from "../../../demo/environment"
import { PROVIDERS, type AgentProvider } from "../../../shared/types"
import type { AppAction } from "../../../foldkit/app/action"
import type { AppModel } from "../../../foldkit/app/slice"
import * as Stores from "../../../foldkit/app/stores"
import * as Composer from "../../../foldkit/composer"
import * as ChatInput from "../../../foldkit/core/stores/chatInput"
import {
  composerGalleryState,
  GALLERY_CHAT_ID,
  GALLERY_CONTEXT_WINDOW,
  GALLERY_PROJECT_ID,
  GALLERY_SIDEBAR,
  GALLERY_SKILLS,
} from "../../gallery-support/composer-states"
import { galleryPage } from "../gallery-page"

const state = composerGalleryState(window.location.search)

const Model = Schema.Struct({ composer: Composer.Model, stores: Stores.Model })
type Model = typeof Model.Type

const Message = defineMessageUnion({
  GotComposerMessage: { message: Composer.Message },
  GotStoresMessage: { message: Stores.Message },
})
type Message = typeof Message.Type

type AnyCommand = Command.Command<Message>

function initialStores(): Stores.Model {
  const stores = Stores.load()
  const drafts: Record<string, string> = state.draft ? { [GALLERY_CHAT_ID]: state.draft } : {}
  const attachmentDrafts: ChatInput.Model["attachmentDrafts"] = state.attachments ? { [GALLERY_CHAT_ID]: state.attachments } : {}
  const chatInput: ChatInput.Model = { ...stores.chatInput, drafts, attachmentDrafts }
  return {
    ...stores,
    appSettings: { ...stores.appSettings, settings: createDemoAppSettings(readThemeParam()) },
    sidebar: { ...stores.sidebar, data: state.sidebar ?? GALLERY_SIDEBAR, ready: true },
    providerAuth: { ...stores.providerAuth, snapshot: state.auth ?? null },
    chatInput,
  }
}

/** useNewChatDelegate's control for the gallery's project. */
function delegateOf(stores: Stores.Model): Composer.ComposerProps["delegate"] {
  if (!state.delegate) return null
  const group = stores.sidebar.data.projectGroups.find((item) => item.groupKey === GALLERY_PROJECT_ID)
  if (!group) return null
  const delegators = projectDelegators(flattenSidebarThreads({ projectGroups: [group] }), group.groupKey)
  return {
    delegators,
    target: resolveDelegateTarget(delegators, stores.delegate.projects[GALLERY_PROJECT_ID]),
    projectName: getProjectSidebarLabel(group).name,
  }
}

function propsOf(stores: Stores.Model): Composer.ComposerProps {
  return {
    chatId: state.delegate ? null : GALLERY_CHAT_ID,
    projectId: state.noProject ? null : GALLERY_PROJECT_ID,
    projectPath: state.noProject ? null : "/Users/maya/code/tidepool",
    projectRepoLabel: state.noProject ? null : "tidepool/main",
    disabled: Boolean(state.disabled),
    canCancel: Boolean(state.canCancel),
    activeProvider: null,
    availableProviders: PROVIDERS,
    contextWindowSnapshot: state.contextWindow ? GALLERY_CONTEXT_WINDOW : null,
    previousPrompt: state.previousPrompt ?? null,
    listSkills: true,
    editModels: true,
    secondary: false,
    delegate: delegateOf(stores),
  }
}

const contextOf = (model: Model): Composer.Context => ({ props: propsOf(model.stores), stores: model.stores })

/** What the root does with a store change; sends, cancels and the rest go nowhere here. */
function applyAction(stores: Stores.Model, action: AppAction): { stores: Stores.Model; commands: AnyCommand[] } {
  if (action._tag === "Batch") {
    return (action.actions as AppAction[]).reduce<{ stores: Stores.Model; commands: AnyCommand[] }>((acc, next) => {
      const applied = applyAction(acc.stores, next)
      return { stores: applied.stores, commands: [...acc.commands, ...applied.commands] }
    }, { stores, commands: [] })
  }
  if (action._tag !== "Store") return { stores, commands: [] }
  const result = Stores.update(stores, action.message)
  return {
    stores: result.model,
    commands: Command.mapMessages(result.commands ?? [], (message: Stores.Message) => Message.GotStoresMessage({ message })) as AnyCommand[],
  }
}

/** The harness's skills come from the fixture list, as the React page's onListSkills gives them. */
function answerSkills(command: Command.Command<Composer.Message, never, unknown>) {
  if (command.name !== "ListSkills") return command
  const provider = command.args?.provider as AgentProvider
  return { ...command, effect: Effect.succeed(Composer.Message.SucceededListSkills({ provider, skills: GALLERY_SKILLS })) }
}

function update(model: Model, message: Message): { model: Model; commands?: ReadonlyArray<AnyCommand> } {
  if (message._tag === "GotStoresMessage") {
    const result = Stores.update(model.stores, message.message)
    return {
      model: { ...model, stores: result.model },
      commands: Command.mapMessages(result.commands ?? [], (inner: Stores.Message) => Message.GotStoresMessage({ message: inner })) as AnyCommand[],
    }
  }
  const result = Composer.updateWith(model.composer, message.message, contextOf(model))
  const commands = Command.mapMessages((result.commands ?? []).map(answerSkills), (inner: Composer.Message) => Message.GotComposerMessage({ message: inner })) as AnyCommand[]
  const applied = result.outMessage ? applyAction(model.stores, result.outMessage.action) : { stores: model.stores, commands: [] }
  return { model: { composer: result.model, stores: applied.stores }, commands: [...commands, ...applied.commands] }
}

export default galleryPage<Model, Message>({
  Model,
  init: () => ({ model: { composer: Composer.init(), stores: initialStores() } }),
  update,
  view: (model, h: HtmlBuilder<Message>): Document => ({
    title: "Kanna",
    body: h.div([h.Class("flex min-h-dvh flex-col justify-end bg-surface pb-4 text-foreground")], [
      h.div([h.Class("relative pointer-events-auto")], [
        h.submodel({
          slotId: "composer",
          model: model.composer,
          view: Composer.view,
          viewInputs: { app: { stores: model.stores } as AppModel, props: propsOf(model.stores) },
          toParentMessage: (message: Composer.Message) => Message.GotComposerMessage({ message }),
        }),
      ]),
    ]),
  }),
  // The composer's own (the hold's clock, the page's attach requests); none
  // of them talks to the socket.
  subscriptions: Subscription.lift(Composer.subscriptions)<Model, Message>({
    read: (model) => Option.some(model.composer),
    toParentMessage: (message: Composer.Message) => Message.GotComposerMessage({ message }),
  }) as never,
})
