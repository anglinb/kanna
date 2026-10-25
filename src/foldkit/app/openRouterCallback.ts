import { Effect, Schema } from "effect"
import { Command, Navigation, Submodel, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { errorMessage, sendCommand, type KannaSocketService } from "../core/socket"
import { button } from "../ui/button"
import { Check, Loader2 } from "../ui/icons"
import { OpenRouterIcon } from "../ui/provider-icons"

// src/client/app/OpenRouterCallbackPage.tsx: the OAuth PKCE callback target,
// opened in a new tab outside the layout. Exchanges the one-time code
// through the server (which holds the verifier); the original app tab flips
// to connected on its own via the provider-auth push (BroadcastChannel is a
// belt-and-suspenders nudge). A new tab closes itself; the `self=1` fallback
// (the browser blocked the new tab, so this IS the app tab) goes back.

export const OPENROUTER_AUTH_CHANNEL = "kanna-openrouter-auth"

export const Model = Schema.Struct({
  status: Schema.Literals(["waiting", "exchanging", "done", "error"]),
  code: Schema.NullOr(Schema.String),
  selfFlow: Schema.Boolean,
  error: Schema.String,
})
export type Model = typeof Model.Type

export const Message = defineMessageUnion({
  SucceededExchange: {},
  FailedExchange: { error: Schema.String },
  ClickedBack: {},
  CompletedSideEffect: {},
})
export type Message = typeof Message.Type

export function init(search: string): Model {
  const params = new URLSearchParams(search)
  const code = params.get("code")
  return {
    status: code ? "waiting" : "error",
    code,
    selfFlow: params.get("self") === "1",
    error: code ? "" : "Missing authorization code in the callback URL.",
  }
}

const Exchange = Command.define("ExchangeOpenRouterCode", {
  args: { code: Schema.String },
  messages: [Message.SucceededExchange, Message.FailedExchange],
  execute: ({ code }) => sendCommand({ type: "auth.openrouter.exchange", code }).pipe(
    Effect.as(Message.SucceededExchange()),
    Effect.catch((error) => Effect.succeed(Message.FailedExchange({ error: error instanceof Error ? errorMessage(error) : "The key exchange failed." }))),
  ),
})

const Finish = Command.define("FinishOpenRouterCallback", {
  args: { selfFlow: Schema.Boolean },
  messages: [Message.CompletedSideEffect],
  execute: ({ selfFlow }) => Effect.gen(function* () {
    try {
      new BroadcastChannel(OPENROUTER_AUTH_CHANNEL).postMessage("done")
    } catch {
      // BroadcastChannel unavailable — the auth snapshot push covers it.
    }
    if (selfFlow) {
      yield* Effect.sleep(700)
      yield* Navigation.pushUrl("/settings/providers")
    } else {
      // Opened as its own tab: close it and return the user to the app.
      yield* Effect.sleep(800)
      window.close()
    }
    return Message.CompletedSideEffect()
  }),
})

const BackToSettings = Command.define("BackToSettings", {
  messages: [Message.CompletedSideEffect],
  execute: Navigation.pushUrl("/settings/providers").pipe(Effect.as(Message.CompletedSideEffect())),
})

/** The socket is up: start the exchange (once). */
export function start(model: Model): Update.Return<Model, Message, KannaSocketService> {
  if (model.status !== "waiting" || !model.code) return { model }
  return { model: modifyFields(model, { status: () => "exchanging" as const }), commands: [Exchange({ code: model.code })] }
}

export const update = (model: Model, message: Message): Update.Return<Model, Message, KannaSocketService> =>
  Message.match<Update.Return<Model, Message, KannaSocketService>>(message, {
    SucceededExchange: () => ({ model: modifyFields(model, { status: () => "done" as const }), commands: [Finish({ selfFlow: model.selfFlow })] }),
    FailedExchange: ({ error }) => ({ model: modifyFields(model, { status: () => "error" as const, error: () => error }) }),
    ClickedBack: () => ({ model, commands: [BackToSettings()] }),
    CompletedSideEffect: () => ({ model }),
  })

export const view = Submodel.defineView<Model, Message>((model, h) =>
  h.div([h.Class("flex min-h-[100dvh] items-center justify-center bg-background px-6")], [
    h.div([h.Class("flex w-full max-w-sm flex-col items-center gap-4 rounded-2xl border border-border bg-card/40 px-6 py-8 text-center")], [
      OpenRouterIcon({ class: "h-8 w-8 text-foreground" }, h),
      ...(model.status === "waiting" || model.status === "exchanging"
        ? [h.div([h.Class("flex items-center gap-2 text-sm text-muted-foreground")], [
          Loader2({ class: "h-4 w-4 animate-spin" }, h),
          "Connecting OpenRouter…",
        ])]
        : model.status === "done"
          ? [
            h.div([h.Class("flex items-center gap-2 text-sm font-medium text-foreground")], [
              Check({ class: "h-4 w-4 text-emerald-500" }, h),
              "OpenRouter connected",
            ]),
            ...(model.selfFlow
              ? [
                h.p([h.Class("text-sm text-muted-foreground")], ["Your API key was saved."]),
                button({ variant: "outline", size: "sm", attributes: [h.OnClick(Message.ClickedBack())] }, ["Back to Kanna"], h),
              ]
              : [h.p([h.Class("text-sm text-muted-foreground")], ["You can close this tab."])]),
          ]
          : [
            h.div([h.Class("text-sm font-medium text-destructive")], ["OpenRouter sign-in failed"]),
            h.p([h.Class("text-sm text-muted-foreground")], [model.error]),
            button({ variant: "outline", size: "sm", attributes: [h.OnClick(Message.ClickedBack())] }, ["Back to Settings"], h),
          ]),
    ]),
  ]),
)
