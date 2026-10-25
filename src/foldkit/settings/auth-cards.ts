import { Effect, Schema } from "effect"
import { Command, Submodel, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { cn } from "../../client/lib/utils"
import { AUTH_SERVICE_ORDER, authServiceForProvider, type AgentProvider, type AuthServiceId, type AuthServiceSnapshot } from "../../shared/types"
import { opaque } from "../core/schema"
import { sendCommand, type KannaSocketService } from "../core/socket"
import * as ProviderAuth from "../core/stores/providerAuth"
import type { Child } from "../ui/attributes"
import { button } from "../ui/button"
import * as CopyButton from "../ui/copy-button"
import * as Dialog from "../ui/dialog"
import { ArrowUpRight, Check, ChevronRight, Flower, Loader2 } from "../ui/icons"
import { input } from "../ui/input"
import { AUTH_SERVICE_ICONS } from "../ui/provider-icons"

// The sign-in cards from src/client/components/auth: AuthCard (with its
// LoginFlowPanel), SetupCard and SignInDialog. Settings › Providers draws the
// AuthCard rows; the home page, the new-chat empty state, the composer and
// the setup wizard draw the same three, so they live here, exported:
//
//   AuthCard      a Submodel per card (its pasted code, the copy check).
//                 Its Commands talk to the server themselves (auth.login.*,
//                 auth.install, auth.openrouter.start), as the React card
//                 called socket.command; results arrive on the
//                 `provider-auth` snapshot.
//   setupCard     a plain view: "Set up Kanna", opening the wizard.
//   SignInDialog  a Submodel: the dialog around an AuthCard for a harness
//                 that isn't signed in.

/** "2.1.218" → "v2.1.218"; calendar/otherwise-shaped versions pass through. */
export function displayVersion(version: string | null): string | null {
  if (!version) return null
  return /^\d/.test(version) && !version.startsWith("v") ? `v${version}` : version
}

function hostOf(url: string): string {
  try {
    return new URL(url).host
  } catch {
    return url
  }
}

/**
 * Open the OpenRouter PKCE flow in a new tab. The tab is opened at once (with
 * a placeholder URL), inside the click's user activation, and navigated once
 * the server returns the auth URL; otherwise mobile Safari, seeing
 * window.open run after an await, hijacks the current tab instead of opening
 * a new one. Falls back to same-tab navigation only when the browser blocks
 * the open.
 */
function startOpenRouterOauth() {
  return Effect.gen(function* () {
    const newTab = window.open("about:blank", "_blank")
    const origin = window.location.origin
    // The `self=1` marker tells the callback page it's running in the current
    // tab (blocked-open fallback) so it navigates back instead of self-closing.
    const callbackUrl = newTab
      ? `${origin}/oauth/openrouter/callback`
      : `${origin}/oauth/openrouter/callback?self=1`
    return yield* sendCommand<{ authUrl: string }>({ type: "auth.openrouter.start", callbackUrl }).pipe(
      Effect.map((result) => {
        if (newTab && !newTab.closed) {
          newTab.location.href = result.authUrl
        } else {
          window.location.assign(result.authUrl)
        }
      }),
      Effect.tapError(() => Effect.sync(() => newTab?.close())),
    )
  })
}

// AUTH CARD: MODEL

export const Model = Schema.Struct({
  id: Schema.String,
  /** The pasted sign-in code (claude's code-entry step). */
  code: Schema.String,
  submitting: Schema.Boolean,
  copy: CopyButton.Model,
})
export type Model = typeof Model.Type

/** `id` names the card among its siblings (a service, or service and account). */
export function init(id: string): Model {
  return { id, code: "", submitting: false, copy: CopyButton.init({ id: `${id}-copy-code` }) }
}

/** The id a card for this service uses: one per service and account. */
export function cardId(service: Pick<AuthServiceSnapshot, "service" | "accountId">): string {
  return service.accountId ? `${service.service}-${service.accountId}` : service.service
}

// AUTH CARD: MESSAGE

const Target = { service: opaque<AuthServiceId>("AuthServiceId"), accountId: Schema.optional(Schema.String) }

export const Message = defineMessageUnion({
  ClickedLogIn: Target,
  ClickedInstall: { service: opaque<AuthServiceId>("AuthServiceId") },
  ClickedCancel: Target,
  ClickedRetry: Target,
  ChangedCode: { code: Schema.String },
  PressedCodeKey: { key: Schema.String, ...Target },
  ClickedSubmitCode: Target,
  CompletedSubmitCode: { ok: Schema.Boolean },
  CompletedCommand: {},
  GotCopyMessage: { message: CopyButton.Message },
})
export type Message = typeof Message.Type

// AUTH CARD: COMMANDS

// Fire-and-forget: errors surface via the snapshot's login state.
const Send = Command.define("SendAuthCardCommand", {
  args: { command: opaque<Parameters<typeof sendCommand>[0]>("ClientCommand") },
  messages: [Message.CompletedCommand],
  execute: ({ command }) => sendCommand(command).pipe(Effect.ignore, Effect.as(Message.CompletedCommand())),
})

const StartOpenRouterOauth = Command.define("StartOpenRouterOauth", {
  messages: [Message.CompletedCommand],
  execute: startOpenRouterOauth().pipe(Effect.ignore, Effect.as(Message.CompletedCommand())),
})

const SubmitCode = Command.define("SubmitAuthCode", {
  args: { service: opaque<AuthServiceId>("AuthServiceId"), accountId: Schema.optional(Schema.String), code: Schema.String },
  messages: [Message.CompletedSubmitCode],
  execute: ({ service, accountId, code }) => sendCommand({ type: "auth.login.submitCode", service, accountId, code }).pipe(
    Effect.as(Message.CompletedSubmitCode({ ok: true })),
    Effect.catch(() => Effect.succeed(Message.CompletedSubmitCode({ ok: false }))),
  ),
})

// AUTH CARD: UPDATE

type Return = Update.Return<Model, Message, KannaSocketService>

function submit(model: Model, service: AuthServiceId, accountId: string | undefined): Return {
  const cleaned = model.code.trim()
  if (!cleaned || model.submitting) return { model }
  return { model: { ...model, submitting: true }, commands: [SubmitCode({ service, accountId, code: cleaned })] }
}

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ClickedLogIn: ({ service, accountId }) => service === "openrouter"
      ? { model, commands: [StartOpenRouterOauth()] }
      : { model, commands: [Send({ command: { type: "auth.login.start", service, accountId } })] },
    ClickedInstall: ({ service }) => ({ model, commands: [Send({ command: { type: "auth.install", service } })] }),
    ClickedCancel: ({ service, accountId }) => ({ model, commands: [Send({ command: { type: "auth.login.cancel", service, accountId } })] }),
    ClickedRetry: ({ service, accountId }) => ({ model, commands: [Send({ command: { type: "auth.login.start", service, accountId } })] }),
    ChangedCode: ({ code }) => ({ model: { ...model, code } }),
    PressedCodeKey: ({ key, service, accountId }) => (key === "Enter" ? submit(model, service, accountId) : { model }),
    ClickedSubmitCode: ({ service, accountId }) => submit(model, service, accountId),
    CompletedSubmitCode: ({ ok }) => ({ model: { ...model, submitting: false, code: ok ? "" : model.code } }),
    CompletedCommand: () => ({ model }),
    GotCopyMessage: ({ message: child }) => {
      const result = CopyButton.update(model.copy, child)
      return {
        model: { ...model, copy: result.model },
        commands: Command.mapMessages(result.commands ?? [], (copyMessage) => Message.GotCopyMessage({ message: copyMessage })),
      }
    },
  })

// AUTH CARD: VIEW

function actionButton<M>(
  options: { onClick?: M; busy?: boolean; text?: boolean },
  children: ReadonlyArray<Child>,
  h: HtmlBuilder<M>,
): Html {
  const busy = options.busy ?? false
  const onClick = options.onClick !== undefined ? [h.OnClick(options.onClick)] : []
  if (options.text) {
    return h.button([
      h.Type("button"),
      ...(busy ? [h.Disabled(true)] : []),
      ...onClick,
      h.Class(cn(
        "inline-flex h-7 shrink-0 cursor-pointer items-center gap-1.5 whitespace-nowrap text-sm font-medium text-foreground",
        "touch-manipulation transition-[color,opacity,scale] duration-150 ease-out hover:text-foreground/70 active:scale-[0.97]",
        "outline-none focus-visible:underline focus-visible:underline-offset-4",
        "disabled:cursor-default disabled:opacity-50 disabled:active:scale-100",
      )),
    ], [
      busy ? Loader2({ class: "h-3.5 w-3.5 animate-spin" }, h) : null,
      ...children,
    ])
  }
  return button({
    variant: "outline",
    size: "sm",
    disabled: busy,
    class: "h-7 shrink-0 rounded-full px-3 text-xs font-semibold",
    attributes: onClick,
  }, [
    busy ? Loader2({ class: "mr-1.5 h-3 w-3 animate-spin" }, h) : null,
    ...children,
  ], h)
}

function externalLink<M>(href: string, className: string, children: ReadonlyArray<Child>, h: HtmlBuilder<M>): Html {
  return h.a([h.Href(href), h.Target("_blank"), h.Rel("noreferrer"), h.Class(className)], children)
}

function loginFlowPanel(model: Model, service: AuthServiceSnapshot, textActions: boolean, h: HtmlBuilder<Message>): Html {
  const login = service.login
  const target = { service: service.service, accountId: service.accountId }
  if (login.phase === "idle") return null

  if (login.phase === "starting" || login.phase === "finishing") {
    return h.div([h.Class("mt-3 flex items-center gap-2 border-t border-border pt-3 text-sm text-muted-foreground")], [
      Loader2({ class: "h-3.5 w-3.5 animate-spin" }, h),
      h.span([h.Class("flex-1")], [login.phase === "starting" ? "Starting sign-in…" : "Finishing sign-in…"]),
    ])
  }

  if (login.phase === "waiting_for_approval") {
    return h.div([h.Class("mt-3 space-y-2.5 border-t border-border pt-3")], [
      ...(login.userCode
        ? [
          h.div([h.Class("text-sm text-muted-foreground")], [
            "Enter this code at ",
            externalLink(login.verificationUrl, "font-medium text-foreground underline underline-offset-2", [hostOf(login.verificationUrl)], h),
          ]),
          h.div([h.Class("flex items-center gap-2")], [
            h.span([h.Class("rounded-lg border border-border bg-muted px-3 py-1.5 font-mono text-base font-semibold tracking-widest text-foreground")], [login.userCode]),
            h.submodel({
              slotId: "copy-code",
              model: model.copy,
              view: CopyButton.view,
              viewInputs: { text: login.userCode, title: "Copy code", class: "h-7 w-7" },
              toParentMessage: (message) => Message.GotCopyMessage({ message }),
            }),
            externalLink(login.verificationUrl, "inline-flex items-center gap-1 text-sm font-medium text-foreground underline-offset-2 hover:underline", [
              "Open ",
              ArrowUpRight({ class: "h-3.5 w-3.5" }, h),
            ], h),
          ]),
        ]
        : [
          h.div([h.Class("text-sm text-muted-foreground")], [
            externalLink(login.verificationUrl, "inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2", [
              `Open ${hostOf(login.verificationUrl)} `,
              ArrowUpRight({ class: "h-3.5 w-3.5" }, h),
            ], h),
            " and approve the sign-in.",
          ]),
        ]),
      h.div([h.Class("flex items-center gap-2 text-xs text-muted-foreground")], [
        Loader2({ class: "h-3 w-3 animate-spin" }, h),
        h.span([h.Class("flex-1")], ["Waiting for approval…"]),
      ]),
    ])
  }

  if (login.phase === "waiting_for_code_entry") {
    return h.div([h.Class("mt-3 space-y-2.5 border-t border-border pt-3")], [
      h.div([h.Class("text-sm text-muted-foreground")], [
        externalLink(login.verificationUrl, "inline-flex items-center gap-1 font-medium text-foreground underline underline-offset-2", [
          "Open the sign-in page ",
          ArrowUpRight({ class: "h-3.5 w-3.5" }, h),
        ], h),
        ", authorize, then paste the code you receive below.",
      ]),
      h.div([h.Class("flex items-center gap-2")], [
        input({
          value: model.code,
          onInput: (code) => Message.ChangedCode({ code }),
          placeholder: "Paste code",
          class: cn(
            "h-8 flex-1 font-mono text-sm",
            textActions && "rounded-none border-0 bg-transparent px-0 placeholder:text-muted-foreground/50",
          ),
          attributes: [
            h.OnKeyDown((key) => Message.PressedCodeKey({ key, ...target })),
            h.Spellcheck(false),
            h.Attribute("autocapitalize", "off"),
            h.Attribute("autocorrect", "off"),
          ],
        }, h),
        actionButton({ text: textActions, onClick: Message.ClickedSubmitCode(target), busy: model.submitting }, ["Submit"], h),
      ]),
    ])
  }

  // error
  return h.div([h.Class("mt-3 space-y-2 border-t border-border pt-3")], [
    h.div([h.Class("text-sm text-destructive")], [login.message]),
    login.hint ? h.div([h.Class("text-xs text-muted-foreground")], [login.hint]) : null,
    h.div([h.Class("flex items-center gap-3")], [
      actionButton({ text: textActions, onClick: Message.ClickedRetry(target) }, ["Try Again"], h),
    ]),
  ])
}

export interface ViewInputs {
  service: AuthServiceSnapshot
  className?: string
  /**
   * Drops the card's own box so several can share one card with hairlines
   * between them (the setup wizard's SetupList, Settings' Accounts).
   */
  row?: boolean
  /** Draws the actions as plain text instead of pills, for Settings, where no row control has a box. */
  textActions?: boolean
}

/**
 * Provider auth card, following the usage-card design:
 * `[ icon Service v1.2.3  <spacer>  Log In | Update to v1.2.4 | account ]`
 * with the live sign-in flow rendered inline below the header.
 *
 *   h.submodel({ slotId: AuthCard.cardId(service), model: cards[id] ?? AuthCard.init(id), view: AuthCard.view,
 *     viewInputs: { service, row: true, textActions: true },
 *     toParentMessage: (message) => GotAuthCardMessage({ id, message }) })
 */
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, inputs, h) => {
  const { service } = inputs
  const row = inputs.row ?? false
  const textActions = inputs.textActions ?? false
  const Icon = AUTH_SERVICE_ICONS[service.service]
  const version = displayVersion(service.version)
  const installing = service.installState === "installing"
  const loginActive = service.login.phase !== "idle"
  const target = { service: service.service, accountId: service.accountId }
  const install = Message.ClickedInstall({ service: service.service })

  let action: Html = null
  if (loginActive) {
    // While a sign-in flow runs (or errored), the header action is Cancel:
    // it kills the flow (and clears an error state) and restores Log In.
    action = h.button([
      h.Type("button"),
      h.OnClick(Message.ClickedCancel(target)),
      h.Class("shrink-0 text-xs text-muted-foreground transition-colors hover:text-foreground"),
    ], ["Cancel"])
  } else if (installing) {
    action = actionButton({ text: textActions, busy: true }, ["Installing…"], h)
  } else if (!service.installed || service.authStatus === "not_installed") {
    action = actionButton({ text: textActions, onClick: install }, ["Install"], h)
  } else if (service.authStatus === "signed_out") {
    action = actionButton({ text: textActions, onClick: Message.ClickedLogIn(target) }, [service.service === "openrouter" ? "Authenticate" : "Log In"], h)
  } else if (service.authStatus === "signed_in" && service.updateAvailable && service.latestVersion) {
    action = actionButton({ text: textActions, onClick: install }, ["Update to ", displayVersion(service.latestVersion) ?? ""], h)
  } else if (service.authStatus === "signed_in") {
    action = h.span([h.Class("flex shrink-0 items-center pr-2"), h.Title(service.account ?? "Connected")], [
      Check({ class: "h-3.5 w-3.5 shrink-0 text-emerald-500 animate-in fade-in zoom-in-90 duration-200 ease-out" }, h),
    ])
  } else if (service.authStatus === "outdated") {
    // The installed CLI can't run the commands Kanna drives: updating is the
    // only way forward, so it's the card's sole action (no Log In).
    action = actionButton({ text: textActions, onClick: install }, [service.latestVersion ? `Update to ${displayVersion(service.latestVersion)}` : "Update"], h)
  } else if (service.authStatus === "error" && service.installed) {
    // A probe error usually means the CLI is too old or broken: offer the
    // installer as the escape hatch instead of dead-ending on the message.
    action = actionButton({ text: textActions, onClick: install }, ["Update"], h)
  } else if (service.authStatus === "unknown") {
    action = h.span([h.Class("shrink-0 text-xs text-muted-foreground")], ["Checking…"])
  }

  return h.div([
    h.Class(cn(row ? "px-4 py-3 text-left" : "rounded-2xl border border-border bg-card/40 px-3.5 py-3 text-left", inputs.className)),
  ], [
    h.div([h.Class("flex min-h-7 items-center justify-between gap-3")], [
      h.div([h.Class(cn("flex min-w-0 items-center", row ? "gap-3" : "gap-2.5"))], [
        Icon({ class: "h-4 w-4 shrink-0 text-foreground" }, h),
        h.span([h.Class(cn("truncate text-sm text-foreground", row ? "font-medium" : "font-semibold"))], [service.label]),
        version ? h.span([h.Class("shrink-0 text-xs tabular-nums text-muted-foreground")], [version]) : null,
      ]),
      action,
    ]),
    service.installState === "error" && service.installError
      ? h.div([h.Class("mt-2 text-xs text-destructive")], [service.installError])
      : null,
    (service.authStatus === "error" || service.authStatus === "outdated") && service.statusDetail
      ? h.div([h.Class("mt-2 text-xs text-muted-foreground")], [service.statusDetail])
      : null,
    loginFlowPanel(model, service, textActions, h),
  ])
})

// SETUP CARD

/**
 * Compact "finish setup" entry point shown on the home page and new-chat
 * empty state until the setup wizard has been completed. Connected services
 * render bright, missing ones muted. Clicking opens the full-screen wizard
 * (the parent sends `ProviderAuth.Message.OpenedSetupWizard` to the store).
 * Draws nothing while `ProviderAuth.showSetupCard` is false.
 */
export function setupCard<M>(options: { providerAuth: ProviderAuth.Model; onOpen: M; class?: string }, h: HtmlBuilder<M>): Html {
  if (!ProviderAuth.showSetupCard(options.providerAuth)) return null
  const status = ProviderAuth.setupStatus(options.providerAuth)
  const snapshot = options.providerAuth.snapshot
  const subtitle = !status.anyAgentConnected
    ? "Connect your coding agents to start building."
    : "Connect the rest of your accounts."
  return h.button([
    h.Type("button"),
    h.OnClick(options.onOpen),
    h.Class(cn(
      "group w-full rounded-2xl border border-border bg-card/40 px-3.5 py-3 text-left transition-colors hover:border-primary/30 hover:bg-muted/40",
      options.class,
    )),
  ], [
    h.div([h.Class("flex items-center justify-between gap-3")], [
      h.div([h.Class("flex min-w-0 items-center gap-2.5")], [
        Flower({ class: "h-4 w-4 shrink-0 text-logo" }, h),
        h.span([h.Class("truncate text-sm font-semibold text-foreground")], ["Set up Kanna"]),
      ]),
      h.span([h.Class("inline-flex shrink-0 items-center gap-0.5 rounded-full border border-border px-2.5 py-1 text-xs font-semibold text-foreground transition-colors group-hover:bg-muted")], [
        "Setup",
        ChevronRight({ class: "h-3.5 w-3.5 -mr-0.5" }, h),
      ]),
    ]),
    h.div([h.Class("mt-2.5 flex items-center gap-3")], [
      h.div([h.Class("flex items-center gap-2.5")], AUTH_SERVICE_ORDER.map((id) => {
        const connected = ProviderAuth.selectAuthService(snapshot, id)?.authStatus === "signed_in"
        return AUTH_SERVICE_ICONS[id]({ class: cn("h-4 w-4", connected ? "text-foreground" : "text-muted-foreground/40") }, h)
      })),
      h.span([h.Class("min-w-0 truncate text-xs text-muted-foreground")], [subtitle]),
    ]),
  ])
}

// SIGN-IN DIALOG

/**
 * Shown when the user picks a harness that isn't signed in. The switch is
 * blocked until sign-in completes: the caller watches the auth store and
 * applies the pending switch (closing this dialog) once the service flips to
 * signed_in.
 *
 *   Model:   signIn: SignInDialogModel                   init: initSignInDialog({ id: "composer-sign-in" })
 *   update:  openSignInDialog(model.signIn, provider, providerAuth) / closeSignInDialog(model.signIn)
 *            GotSignInMessage: updateSignInDialog (OutMessage Closed: React's onOpenChange(false))
 *   view:    h.submodel({ slotId: "sign-in", model: model.signIn, view: signInDialogView,
 *              viewInputs: { providerAuth: app.stores.providerAuth }, toParentMessage: … })
 *
 * React's dialog was open while `provider && service && socket`; there is
 * always a socket here, and `open` only opens it for a harness with a
 * sign-in service the snapshot knows.
 */
export const SignInDialogModel = Schema.Struct({
  /** The harness the user tried to switch to, or null when closed. */
  provider: Schema.NullOr(opaque<AgentProvider>("AgentProvider")),
  dialog: Dialog.Model,
  card: Model,
})
export type SignInDialogModel = typeof SignInDialogModel.Type

export const SignInDialogMessage = defineMessageUnion({
  GotDialogMessage: { message: Dialog.Message },
  GotAuthCardMessage: { message: Message },
})
export type SignInDialogMessage = typeof SignInDialogMessage.Type

export const SignInDialogOutMessage = defineMessageUnion({
  /** Dismissed (React's onOpenChange(false)). */
  Closed: {},
})
export type SignInDialogOutMessage = typeof SignInDialogOutMessage.Type

type SignInDialogReturn = Update.ReturnWithOutMessage<SignInDialogModel, SignInDialogMessage, SignInDialogOutMessage, KannaSocketService>

function liftSignInDialog(model: SignInDialogModel, result: Pick<Update.Return<Dialog.Model, Dialog.Message>, "model" | "commands">) {
  return {
    model: { ...model, dialog: result.model },
    commands: Command.mapMessages(result.commands ?? [], (message) => SignInDialogMessage.GotDialogMessage({ message })),
  }
}

export function initSignInDialog(config: { id: string }): SignInDialogModel {
  return { provider: null, dialog: Dialog.init({ id: config.id }), card: init(`${config.id}-card`) }
}

/** `provider` set: opens it, when the snapshot has the harness's sign-in service. */
export function openSignInDialog(model: SignInDialogModel, provider: AgentProvider, providerAuth: ProviderAuth.Model): Update.Return<SignInDialogModel, SignInDialogMessage> {
  const serviceId = authServiceForProvider(provider)
  const service = serviceId ? ProviderAuth.selectAuthService(providerAuth.snapshot, serviceId) : null
  if (!service) return { model: { ...model, provider } }
  return liftSignInDialog({ ...model, provider }, Dialog.open(model.dialog))
}

/** `provider` back to null. */
export function closeSignInDialog(model: SignInDialogModel): Update.Return<SignInDialogModel, SignInDialogMessage> {
  return liftSignInDialog({ ...model, provider: null }, Dialog.close(model.dialog))
}

export const updateSignInDialog = (model: SignInDialogModel, message: SignInDialogMessage): SignInDialogReturn =>
  SignInDialogMessage.match<SignInDialogReturn>(message, {
    GotDialogMessage: ({ message: child }) => {
      const result = Dialog.update(model.dialog, child)
      const lifted = liftSignInDialog(model, result)
      return result.outMessage ? { ...lifted, outMessage: SignInDialogOutMessage.Closed() } : lifted
    },
    GotAuthCardMessage: ({ message: child }) => {
      const result = update(model.card, child)
      return {
        model: { ...model, card: result.model },
        commands: Command.mapMessages(result.commands ?? [], (cardMessage) => SignInDialogMessage.GotAuthCardMessage({ message: cardMessage })),
      }
    },
  })

export const signInDialogView = Submodel.defineView<SignInDialogModel, SignInDialogMessage, { providerAuth: ProviderAuth.Model }>((model, { providerAuth }, h) => {
  const serviceId = model.provider ? authServiceForProvider(model.provider) : null
  const service = serviceId ? ProviderAuth.selectAuthService(providerAuth.snapshot, serviceId) : null
  return h.submodel({
    slotId: "dialog",
    model: model.dialog,
    view: Dialog.view,
    viewInputs: {
      size: "md",
      content: ({ titleId, descriptionId }: Dialog.ContentParts) => [
        Dialog.dialogHeader({}, [
          Dialog.dialogTitle({ id: titleId }, [`Sign in to ${service?.label ?? ""}`], h),
          Dialog.dialogDescription({ id: descriptionId }, [
            service && !service.installed
              ? `Install and sign in to ${service.label} to use it for this chat.`
              : `Sign in to ${service?.label ?? "this provider"} to use it for this chat. The switch applies automatically once you're signed in.`,
          ], h),
        ], h),
        Dialog.dialogBody({}, [
          service
            ? h.submodel({
              slotId: "card",
              model: model.card,
              view,
              viewInputs: { service },
              toParentMessage: (message) => SignInDialogMessage.GotAuthCardMessage({ message }),
            })
            : null,
        ], h),
      ],
    },
    toParentMessage: (message) => SignInDialogMessage.GotDialogMessage({ message }),
  })
})
