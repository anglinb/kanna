import { describe, test } from "bun:test"
import { Effect, Schema } from "effect"
import { Command, Update } from "foldkit"
import type { Document, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { Scene, Story } from "foldkit/test"

// Canary for the toolchain, not for the app: foldkit pins effect@4.0.0 as a
// peer and we run 4.0.5, and its docs only show Vitest. If an upgrade of
// either breaks Story or Scene under bun test, this fails first.
// See docs/foldkit-migration.md, decision 1.

const Chat = Schema.Struct({ id: Schema.String, title: Schema.String })
const Model = Schema.Struct({ chats: Schema.Array(Chat), draft: Schema.String, sending: Schema.Boolean })
type Model = typeof Model.Type

const Message = defineMessageUnion({
  ReceivedSidebarSnapshot: { chats: Schema.Array(Chat) },
  ChangedDraft: { value: Schema.String },
  SubmittedPrompt: {},
  SentPrompt: {},
})
type Message = typeof Message.Type

const SendPrompt = Command.define("SendPrompt", {
  args: { content: Schema.String },
  messages: [Message.SentPrompt],
  execute: () => Effect.succeed(Message.SentPrompt()),
})

const update = (model: Model, message: Message) =>
  Message.match<Update.Return<Model, Message>>(message, {
    ReceivedSidebarSnapshot: ({ chats }) => ({ model: modifyFields(model, { chats: () => chats }) }),
    ChangedDraft: ({ value }) => ({ model: modifyFields(model, { draft: () => value }) }),
    SubmittedPrompt: () =>
      model.sending || model.draft.trim() === ""
        ? { model }
        : { model: modifyFields(model, { sending: () => true }), commands: [SendPrompt({ content: model.draft })] },
    SentPrompt: () => ({ model: modifyFields(model, { sending: () => false, draft: () => "" }) }),
  })

const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: "Kanna",
  body: h.div([], [
    h.nav([h.AriaLabel("Chats")], [h.ul([], model.chats.map((chat) => h.li([h.Key(chat.id)], [chat.title])))]),
    h.textarea([h.AriaLabel("Prompt"), h.Value(model.draft), h.OnInput((value) => Message.ChangedDraft({ value }))]),
    h.button([h.OnClick(Message.SubmittedPrompt()), h.Disabled(model.sending)], ["Send"]),
  ]),
})

describe("foldkit toolchain", () => {
  test("Story runs under bun test", () => {
    Story.story(
      update,
      Story.given({ chats: [], draft: "hello", sending: false }),
      Story.message(Message.SubmittedPrompt()),
      Story.Command.expectExact(SendPrompt({ content: "hello" })),
      Story.Command.resolve(SendPrompt, Message.SentPrompt()),
      Story.model((model) => {
        if (model.draft !== "" || model.sending) throw new Error("expected a cleared, idle composer")
      }),
    )
  })

  test("Story: a submit while one is in flight sends nothing", () => {
    Story.story(
      update,
      Story.given({ chats: [], draft: "hello", sending: true }),
      Story.message(Message.SubmittedPrompt()),
      Story.Command.expectNone(),
    )
  })

  test("Scene runs under bun test", () => {
    Scene.scene(
      { update, view },
      Scene.given({ chats: [], draft: "", sending: false }),
      Scene.Subscription.emit(Message.ReceivedSidebarSnapshot({ chats: [{ id: "c1", title: "Fix the build" }] })),
      Scene.expect(Scene.text("Fix the build")).toExist(),
      Scene.type(Scene.label("Prompt"), "ship it"),
      Scene.click(Scene.role("button", { name: "Send" })),
      Scene.Command.expectExact(SendPrompt({ content: "ship it" })),
      Scene.expect(Scene.role("button", { name: "Send" })).toBeDisabled(),
      Scene.Command.resolve(SendPrompt, Message.SentPrompt()),
      Scene.expect(Scene.label("Prompt")).toHaveValue(""),
    )
  })
})
