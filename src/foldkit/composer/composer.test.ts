import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { Story } from "foldkit/test"
import { fromString } from "foldkit/url"
import { PROVIDERS, type AuthServiceSnapshot, type HarnessSkill, type SidebarChatRow, type SidebarData } from "../../shared/types"
import { AppAction } from "../app/action"
import type { Flags } from "../app/model"
import { SliceOutMessage, type AppModel } from "../app/slice"
import * as Stores from "../app/stores"
import { init as initApp } from "../app/update"
import * as ChatSession from "../core/chatSession"
import * as ChatInput from "../core/stores/chatInput"
import * as ChatPreferences from "../core/stores/chatPreferences"
import * as Delegate from "../core/stores/delegate"
import { memoryStorage } from "../core/stores/testing"
import * as AppDialog from "../ui/app-dialog"
import * as Dialog from "../ui/dialog"
import * as Commands from "./commands"
import type { ComposerProps, Context } from "./context"
import { Message } from "./message"
import { init, type Model } from "./model"
import { observe, reconcile, updateWith } from "./update"

// ChatInput's handlers as Stories: typing and its draft, sending and a
// failed send, the "/" menu, Shift+Tab, a harness that needs signing in,
// the Escape hold, and what a new chat does to the composer.

function row(chatId: string, extra: Partial<SidebarChatRow> = {}): SidebarChatRow {
  return {
    _id: chatId,
    _creationTime: 1,
    chatId,
    title: "Fix the tide chart",
    status: "idle",
    unread: false,
    localPath: "/work/tidepool",
    provider: "claude",
    lastMessageAt: 1_000,
    canFork: true,
    ...extra,
  } as SidebarChatRow
}

const DATA: SidebarData = {
  projectGroups: [
    { groupKey: "p1", title: "tidepool", realTitle: "tidepool", localPath: "/work/tidepool", chats: [row("c1")], previewChats: [], olderChats: [], defaultCollapsed: false },
    { groupKey: "p2", title: "portolan", realTitle: "portolan", localPath: "/work/portolan", chats: [], previewChats: [], olderChats: [], defaultCollapsed: false },
  ],
} as unknown as SidebarData

function stores(extra: Partial<Stores.Model> = {}): Stores.Model {
  const loaded = Stores.load(memoryStorage())
  return { ...loaded, sidebar: { ...loaded.sidebar, data: DATA, ready: true }, ...extra }
}

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
    previousPrompt: "Show the swell",
    listSkills: true,
    editModels: true,
    secondary: false,
    delegate: null,
    ...extra,
  }
}

function appAt(path: string): AppModel {
  const flags: Flags = { sidebarCollapsed: false, systemTheme: "dark", initialAppSettings: null, stores: Stores.load(memoryStorage()) }
  return initApp(flags, Option.getOrThrow(fromString(`http://localhost${path}`))).model
}

const context = (extra: Partial<ComposerProps> = {}, storeExtra: Partial<Stores.Model> = {}): Context => ({ props: props(extra), stores: stores(storeExtra) })
const updateFor = (ctx: Context) => (model: Model, message: Message) => updateWith(model, message, ctx)
const asks = (action: AppAction) => SliceOutMessage.RequestedAppAction({ action })
const chatInputStore = (message: ChatInput.Message) => asks(AppAction.Store({ message: Stores.Message.GotChatInputMessage({ message }) }))

/** The composer as the page first shows it. */
const fresh = (ctx: Context) => reconcile(init(), ctx).model

describe("composer: typing", () => {
  test("a keystroke saves the draft in the same update, stamped with its time, and resizes the box", () => {
    const ctx = context()
    Story.story(
      updateFor(ctx),
      Story.given(fresh(ctx)),
      Story.message(Message.ChangedInput({ value: "Show the swell", caret: 14, at: 5 })),
      Story.expectOutMessage(chatInputStore(ChatInput.Message.ChangedDraft({ chatId: "c1", value: "Show the swell", at: 5 }))),
      Story.Command.expectExact(Commands.AutoResize),
      // (The root applies that write in this same update; this test's store
      // is fixed, so look before another message reconciles against it.)
      Story.model((model) => {
        expect(model.value).toBe("Show the swell")
        expect(model.writtenDraft).toBe("Show the swell")
      }),
      Story.Command.resolve(Commands.AutoResize, Message.CompletedSideEffect()),
    )
  })

  test("a draft write overtaken by the next keystroke is dropped", () => {
    const ctx = context()
    const typed = { ...fresh(ctx), value: "Show the swell!" }
    const result = updateWith(typed, Message.GotChatInputStoreMessage({ message: ChatInput.Message.ChangedDraft({ chatId: "c1", value: "Show the swell", at: 5 }) }), ctx)
    expect(result.outMessage).toBeUndefined()
  })

  test("ArrowUp in an empty box brings the last prompt back", () => {
    const ctx = context()
    const result = updateWith(fresh(ctx), Message.RecalledPreviousPrompt(), ctx)
    expect(result.model.value).toBe("Show the swell")
  })

  test("a draft cleared from outside empties the box", () => {
    const ctx = context()
    const typed = { ...fresh(ctx), value: "half a thought", writtenDraft: "half a thought" }
    expect(reconcile(typed, ctx).model.value).toBe("")
  })
})

describe("composer: sending", () => {
  test("Enter sends the text with the composer's settings and empties the box", () => {
    const ctx = context()
    const typed = { ...fresh(ctx), value: "Show the swell" }
    const result = updateWith(typed, Message.PressedEnter({ withModifier: false }), ctx)
    expect(result.model.value).toBe("")
    // The draft leaves the store once the send is out.
    expect(result.commands?.map((command) => command.name)).toContain("ClearComposerDraftAfterSend")
    expect(result.model.pendingSubmit?.value).toBe("Show the swell")
    const action = result.outMessage?.action
    expect(action?._tag).toBe("Chat")
    const sent = action?._tag === "Chat" ? action.message : null
    expect(sent?._tag).toBe("SubmittedMessage")
    if (sent?._tag !== "SubmittedMessage") throw new Error("not a send")
    expect(sent.content).toBe("Show the swell")
    expect(sent.options).toMatchObject({ steer: false, provider: "claude", planMode: false, autoPlan: false, attachments: [] })
  })

  test("⌘Enter while a turn runs steers instead of queueing", () => {
    const ctx = context({ canCancel: true })
    const typed = { ...fresh(ctx), value: "Skip the table" }
    const result = updateWith(typed, Message.PressedEnter({ withModifier: true }), ctx)
    const action = result.outMessage?.action
    const sent = action?._tag === "Chat" ? action.message : null
    expect(sent?._tag === "SubmittedMessage" && sent.options.steer).toBe(true)
  })

  test("nothing to send: Enter does nothing", () => {
    const ctx = context()
    const result = updateWith({ ...fresh(ctx), value: "   " }, Message.PressedEnter({ withModifier: false }), ctx)
    expect(result.outMessage).toBeUndefined()
  })

  test("a failed send puts the text back", () => {
    const ctx = context()
    const sent = updateWith({ ...fresh(ctx), value: "Show the swell" }, Message.PressedEnter({ withModifier: false }), ctx).model
    const failed = updateWith(sent, Message.FailedSend({ content: "Show the swell", error: "offline" }), ctx)
    expect(failed.model.value).toBe("Show the swell")
    expect(failed.model.pendingSubmit).toBeNull()
  })

  test("the round button stops a running turn when there is nothing to send", () => {
    const ctx = context({ canCancel: true })
    const result = updateWith(fresh(ctx), Message.PressedPrimaryAction({ withModifier: false }), ctx)
    expect(result.outMessage).toEqual(asks(AppAction.Chat({ message: ChatSession.Message.ClickedCancel() })))
  })
})

describe("composer: the \"/\" menu", () => {
  const skills: HarnessSkill[] = [
    { name: "review", description: "Review a pull request", source: "builtin" } as HarnessSkill,
    { name: "compact", description: "Clear the conversation", source: "builtin" } as HarnessSkill,
  ]

  test("the caret in a \"/\" token lists the harness's skills, and Enter takes the best match", () => {
    // The draft is in the store already (the store doesn't move in a Story).
    const base = stores()
    const ctx: Context = { props: props(), stores: { ...base, chatInput: { ...base.chatInput, drafts: { c1: "/rev" } } } }
    Story.story(
      updateFor(ctx),
      Story.given(fresh(ctx)),
      Story.message(Message.MovedCaret({ caret: 4 })),
      Story.Command.resolve(Commands.ListSkills, Message.SucceededListSkills({ provider: "claude", skills })),
      Story.Command.resolve(Commands.RevealSelected, Message.CompletedSideEffect()),
      Story.model((model) => expect(model.skills?.length).toBe(2)),
      Story.message(Message.AcceptedSkill({ index: 0 })),
      Story.Command.resolveAll([Commands.PlaceCaret, Message.CompletedSideEffect()], [Commands.AutoResize, Message.CompletedSideEffect()], [ChatInput.ChangeDraft, ChatInput.Message.ChangedDraft({ chatId: "c1", value: "/review ", at: 6 })]),
      Story.model((model) => expect(model.value).toBe("/review ")),
    )
  })

  test("Escape closes the menu for the token it was pressed in", () => {
    const ctx = context()
    const open = { ...fresh(ctx), value: "/", caret: 1, skills, skillsFetch: { provider: "claude" as const, pending: false } }
    const result = updateWith(open, Message.DismissedSkillMenu(), ctx)
    expect(result.model.skillMenuDismissed).toBe(true)
  })
})

describe("composer: modes and harnesses", () => {
  test("Shift+Tab moves claude from Full Access to Plan Mode", () => {
    const ctx = context()
    const result = updateWith(fresh(ctx), Message.PressedShiftTab(), ctx)
    expect(result.outMessage).toEqual(asks(AppAction.Store({
      message: Stores.Message.GotChatPreferencesMessage({ message: ChatPreferences.Message.ChangedChatComposerMode({ chatId: "c1", mode: "plan" }) }),
    })))
  })

  test("a harness that isn't signed in waits behind the sign-in dialog", () => {
    const signedOut: AuthServiceSnapshot = {
      service: "codex",
      label: "Codex",
      installed: true,
      version: null,
      latestVersion: null,
      updateAvailable: false,
      authStatus: "signed_out",
      account: null,
      statusDetail: null,
      login: { status: "idle" },
      installState: "idle",
    } as unknown as AuthServiceSnapshot
    const base = stores()
    const ctx = context({}, { providerAuth: { ...base.providerAuth, snapshot: { services: [signedOut] } } })
    const result = updateWith(fresh(ctx), Message.PickedProvider({ provider: "codex" }), ctx)
    expect(result.model.pendingSignInProvider).toBe("codex")
    expect(result.model.signIn.provider).toBe("codex")
    // The harness doesn't change until the sign-in lands.
    expect(result.outMessage).toBeUndefined()

    // It lands: the switch the user asked for applies, and the dialog goes.
    const signedIn = { ...signedOut, authStatus: "signed_in" } as AuthServiceSnapshot
    const before: AppModel = { ...appAt("/chat/c1"), stores: ctx.stores }
    const after: AppModel = { ...before, stores: { ...ctx.stores, providerAuth: { ...ctx.stores.providerAuth, snapshot: { services: [signedIn] } } } }
    const observed = observe(result.model, before, after)
    expect(observed.model.pendingSignInProvider).toBeNull()
    expect(observed.outMessage?.action._tag).toBe("Batch")
  })
})

describe("composer: a new delegator", () => {
  test("New Delegator… asks for a name, creates it, and delegates to it", () => {
    const ctx = context()
    Story.story(
      updateFor(ctx),
      Story.given(fresh(ctx)),
      Story.message(Message.ClickedNewDelegator()),
      Story.Command.resolve(AppDialog.FocusInput, AppDialog.Message.CompletedFocusInput()),
      Story.model((model) => expect(model.appDialog.request._tag).toBe("Some")),
      Story.message(Message.GotAppDialogMessage({ message: AppDialog.Message.ChangedInput({ value: "Release captain" }) })),
      Story.message(Message.GotAppDialogMessage({ message: AppDialog.Message.ClickedConfirm() })),
      Story.Command.resolveAll(
        [Dialog.WaitForExitAnimation, Dialog.Message.CompletedExitAnimation({ version: 2 })],
        [Commands.CreateDelegator, Message.SucceededCreateDelegator({ projectId: "p1", chatId: "d1" })],
      ),
      Story.expectOutMessage(asks(AppAction.Store({
        message: Stores.Message.GotDelegateMessage({ message: Delegate.Message.ChangedPreference({ projectId: "p1", preference: { on: true, chatId: "d1" } }) }),
      }))),
    )
  })

  test("a failed create says so", () => {
    const ctx = context()
    const result = updateWith(fresh(ctx), Message.FailedCreateDelegator({ error: "The server is gone." }), ctx)
    expect(result.model.appDialog.request._tag).toBe("Some")
  })
})

describe("composer: holding Escape", () => {
  test("a held Escape stops the turn; let go early, it doesn't", () => {
    const ctx = context({ canCancel: true })
    const holding = updateWith(fresh(ctx), Message.PressedEscapeToStop(), ctx).model
    expect(holding.hold.phase).toBe("holding")
    const confirmed = updateWith(holding, Message.ConfirmedHold({ version: holding.hold.version }), ctx)
    expect(confirmed.outMessage).toEqual(asks(AppAction.Chat({ message: ChatSession.Message.ClickedCancel() })))

    const released = updateWith(holding, Message.ReleasedHold({ version: holding.hold.version }), ctx)
    expect(released.model.hold.phase).toBe("released")
    expect(released.outMessage).toBeUndefined()
  })

  test("with no turn running, Escape starts nothing", () => {
    const ctx = context()
    expect(updateWith(fresh(ctx), Message.PressedEscapeToStop(), ctx).model.hold.phase).toBe("idle")
  })
})

describe("composer: another chat", () => {
  test("the composer starts over for the next chat, with that chat's draft", () => {
    const ctx = context()
    const typed = { ...fresh(ctx), value: "for c1" }
    const base = stores()
    const next: Context = { props: props({ chatId: "c2" }), stores: { ...base, chatInput: { ...base.chatInput, drafts: { c2: "for c2" } } } }
    const moved = reconcile(typed, next).model
    expect(moved.instance?.chatKey).toBe("c2")
    expect(moved.value).toBe("for c2")
  })

  test("files can't be attached outside a project", () => {
    const ctx = context({ projectId: null })
    const result = updateWith(fresh(ctx), Message.ReceivedFiles({ files: [new File(["x"], "x.txt")] }), ctx)
    expect(result.model.uploadError?.message).toBe("Open a project before uploading files.")
  })
})
