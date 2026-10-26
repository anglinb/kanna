import { Duration, Effect, Schema, Stream } from "effect"
import { Command, Mount, Submodel, Subscription, type Update } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { defineMessageUnion } from "foldkit/message"
import { copyTextToClipboard } from "../../client/lib/clipboard"
import { displayClaimUrl, fetchPairSession, startPairSession, type PairSessionState } from "../../client/lib/pairSession"
import { cn } from "../../client/lib/utils"
import { opaque } from "../core/schema"
import { animatedShinyText } from "../ui/animated-shiny-text"
import { ArrowUpRight, Check, Copy, RefreshCw } from "../ui/icons"
import { domStream } from "../ui/overlay/stream"

// Kanna Cloud pairing (components/cloud/CloudPairPanel.tsx and
// useCloudPairSession.ts), for the setup wizard's Kanna Cloud step and the
// sidebar's pairing dialog:
//
//   Model          one machine's device-code pairing state for the UI
//                  (useCloudPairSession) and the panel's own bits: the view
//                  swap, the copy check, the value held while the tab is
//                  hidden.
//   load(model)    the first status fetch (the hook's mount effect, while
//                  `enabled`).
//   begin(model)   mint a claim URL, or adopt the live session.
//   subscriptions  while a claim is outstanding: the 2s poll; while a change
//                  is held: the page coming back into view. The owner gates
//                  them on its `enabled`.
//   view           the panel, `{ showOpenButton }` as in React (the wizard
//                  draws its own Open button and passes false).
//
// The machine does the polling; this only asks "what's the state", so the
// claim still completes if the user finishes on their phone.

/** While a claim is outstanding, mirror the machine's own poll cadence. */
const PAIR_POLL_MS = 2_000

/**
 * How long after the page comes back into view a held change shows. Long
 * enough for the eye to land on the panel before it moves.
 */
const RETURN_BEAT_MS = 250

const COPIED_MS = 1_600

export const FLEET_URL = "https://kanna.sh/fleet"

/**
 * Presses in a touch (scale 0.97) so the button feels like it heard you. The
 * transition names `scale` because that is the property Tailwind's scale
 * utilities set; with `transform` listed the press snapped.
 */
export const PRIMARY_ACTION_CLASS =
  "inline-flex h-10 items-center justify-center gap-1.5 rounded-full bg-primary px-5 text-sm font-medium text-primary-foreground transition-[scale,background-color,opacity] duration-150 ease-snappy hover:bg-primary/90 active:scale-[0.97]"

/** The arrow leans the way the link goes: out of the app. */
const OUTBOUND_ARROW_CLASS =
  "h-4 w-4 transition-transform duration-150 ease-snappy motion-safe:group-hover:translate-x-0.5 motion-safe:group-hover:-translate-y-0.5"

type PairView = "link" | "paired" | "retry" | "manual"

export function viewFor(session: PairSessionState): PairView {
  if (session.status === "paired" && session.appOrigin) return "paired"
  if (session.status === "unsupported") return "manual"
  if (session.status === "expired" || session.status === "error") return "retry"
  return "link"
}

// MODEL

const Session = opaque<PairSessionState>("PairSessionState")

export const Model = Schema.Struct({
  /** The live session. */
  session: Session,
  /** What the panel shows: the live session, held while the page is hidden. */
  shown: Session,
  /** False until the first status fetch lands: "idle" is ambiguous before it. */
  loaded: Schema.Boolean,
  /** A start request is in flight (the retry button waits on it). */
  starting: Schema.Boolean,
  /** The view that left and is fading out over the new one, drawn as it was. */
  leaving: Schema.NullOr(Schema.Struct({ key: Schema.String, session: Session })),
  /** A view has replaced the first one: views from here on animate in. */
  swapped: Schema.Boolean,
  /** The stage's height, the new view's (null until measured). */
  height: Schema.NullOr(Schema.Number),
  copied: Schema.Boolean,
  copyVersion: Schema.Number,
  /** Bumped by each return to view, so only the last beat shows the held value. */
  holdVersion: Schema.Number,
})
export type Model = typeof Model.Type

export function init(): Model {
  const idle: PairSessionState = { status: "idle" }
  return { session: idle, shown: idle, loaded: false, starting: false, leaving: null, swapped: false, height: null, copied: false, copyVersion: 0, holdVersion: 0 }
}

/** Whether a claim is outstanding (the poll runs). */
export const isWaiting = (model: Model) => model.session.status === "waiting"

// MESSAGE

export const Message = defineMessageUnion({
  /** A status fetch or start answered; `visible` is the page's visibility then. */
  ReceivedSession: { session: Session, visible: Schema.Boolean },
  StartedSession: { session: Session, visible: Schema.Boolean },
  ElapsedPoll: {},
  ReturnedToView: {},
  ElapsedReturnBeat: { version: Schema.Number },
  ClickedRetry: {},
  ClickedCopyLink: { text: Schema.String },
  CopiedLink: { ok: Schema.Boolean },
  ElapsedCopied: { version: Schema.Number },
  EndedLeavingView: {},
  MeasuredStage: { height: Schema.Number },
})
export type Message = typeof Message.Type

type Return = Update.Return<Model, Message>

// COMMANDS

const pageVisible = () => typeof document === "undefined" || document.visibilityState === "visible"

export const FetchPairSession = Command.define("FetchPairSession", {
  messages: [Message.ReceivedSession],
  execute: Effect.promise(() => fetchPairSession()).pipe(
    Effect.map((session) => Message.ReceivedSession({ session, visible: pageVisible() })),
  ),
})

export const StartPairSession = Command.define("StartPairSession", {
  messages: [Message.StartedSession],
  execute: Effect.promise(() => startPairSession()).pipe(
    Effect.map((session) => Message.StartedSession({ session, visible: pageVisible() })),
  ),
})

export const WaitReturnBeat = Command.define("WaitPairReturnBeat", {
  args: { version: Schema.Number },
  messages: [Message.ElapsedReturnBeat],
  execute: ({ version }) => Effect.sleep(Duration.millis(RETURN_BEAT_MS)).pipe(Effect.as(Message.ElapsedReturnBeat({ version }))),
})

export const CopyLink = Command.define("CopyPairLink", {
  args: { text: Schema.String },
  messages: [Message.CopiedLink],
  execute: ({ text }) => Effect.promise(() => copyTextToClipboard(text).catch(() => false)).pipe(
    Effect.map((ok) => Message.CopiedLink({ ok })),
  ),
})

export const WaitCopied = Command.define("WaitPairLinkCopied", {
  args: { version: Schema.Number },
  messages: [Message.ElapsedCopied],
  execute: ({ version }) => Effect.sleep(Duration.millis(COPIED_MS)).pipe(Effect.as(Message.ElapsedCopied({ version }))),
})

// UPDATE

/** useCloudPairSession's mount effect: the current state, without minting a code. */
export function load(model: Model): Return {
  return { model, commands: [FetchPairSession()] }
}

/** useCloudPairSession's `begin`: mint a claim URL, or adopt the live session. */
export function begin(model: Model): Return {
  return { model: { ...model, starting: true }, commands: [StartPairSession()] }
}

/** Shows a session: the view swaps when its kind changes (ViewSwap). */
function show(model: Model, session: PairSessionState): Model {
  const before = viewFor(model.shown)
  const after = viewFor(session)
  if (before === after) return { ...model, shown: session }
  return { ...model, shown: session, leaving: { key: before, session: model.shown }, swapped: true }
}

/**
 * Pairing is finished in another tab, so the session usually turns paired
 * while this page is hidden, and the change would play to nobody: the
 * panel keeps the last value seen until the page is back in view.
 */
function receive(model: Model, session: PairSessionState, visible: boolean): Model {
  const next = { ...model, session, loaded: true }
  return visible ? show(next, session) : next
}

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ReceivedSession: ({ session, visible }) => ({ model: receive(model, session, visible) }),
    StartedSession: ({ session, visible }) => ({ model: { ...receive(model, session, visible), starting: false } }),
    ElapsedPoll: () => ({ model, commands: [FetchPairSession()] }),
    ReturnedToView: () => {
      if (model.shown === model.session) return { model }
      const holdVersion = model.holdVersion + 1
      return { model: { ...model, holdVersion }, commands: [WaitReturnBeat({ version: holdVersion })] }
    },
    ElapsedReturnBeat: ({ version }) => version === model.holdVersion ? { model: show(model, model.session) } : { model },
    ClickedRetry: () => begin(model),
    ClickedCopyLink: ({ text }) => ({ model, commands: [CopyLink({ text })] }),
    CopiedLink: ({ ok }) => {
      if (!ok) return { model }
      const copyVersion = model.copyVersion + 1
      return { model: { ...model, copied: true, copyVersion }, commands: [WaitCopied({ version: copyVersion })] }
    },
    ElapsedCopied: ({ version }) => version === model.copyVersion ? { model: { ...model, copied: false } } : { model },
    EndedLeavingView: () => ({ model: { ...model, leaving: null } }),
    MeasuredStage: ({ height }) => height === model.height ? { model } : { model: { ...model, height } },
  })

// SUBSCRIPTIONS (the owner gates them on its `enabled`)

export const subscriptions = Subscription.make<Model, Message>()((entry) => ({
  poll: entry({ waiting: Schema.Boolean }, {
    modelToDependencies: (model) => ({ waiting: isWaiting(model) }),
    dependenciesToStream: ({ waiting }) => Stream.when(
      Stream.tick(Duration.millis(PAIR_POLL_MS)).pipe(Stream.drop(1), Stream.map(() => Message.ElapsedPoll())),
      Effect.sync(() => waiting),
    ),
  }),
  returnToView: entry({ holding: Schema.Boolean }, {
    modelToDependencies: (model) => ({ holding: model.shown !== model.session }),
    dependenciesToStream: ({ holding }) => Stream.when(
      domStream<Message>((emit) => {
        const onVisibilityChange = () => {
          if (document.visibilityState === "visible") emit(Message.ReturnedToView())
        }
        document.addEventListener("visibilitychange", onVisibilityChange)
        return () => document.removeEventListener("visibilitychange", onVisibilityChange)
      }),
      Effect.sync(() => holding),
    ),
  }),
}))

// VIEW

/** The stage's inner box: its height, as it changes. The leaving view is out of flow, so this is always the new view's. */
export const StageMount = Mount.defineStream("CloudPairStage", {
  messages: [Message.MeasuredStage],
  execute: ({ element }) => domStream<typeof Message.MeasuredStage.Type>((emit) => {
    const inner = element as HTMLElement
    const measure = () => emit(Message.MeasuredStage({ height: inner.offsetHeight }))
    measure()
    const observer = new ResizeObserver(measure)
    observer.observe(inner)
    return () => observer.disconnect()
  }),
})

/** The leaving view's own fade ending (the rows inside animate too, and their ends bubble). */
const LeavingViewMount = Mount.defineStream("CloudPairLeavingView", {
  messages: [Message.EndedLeavingView],
  execute: ({ element }) => domStream<typeof Message.EndedLeavingView.Type>((emit) => {
    const onAnimationEnd = (event: Event) => {
      if (event.target === element) emit(Message.EndedLeavingView())
    }
    element.addEventListener("animationend", onAnimationEnd)
    return () => element.removeEventListener("animationend", onAnimationEnd)
  }),
})

type H = HtmlBuilder<Message>

/** The old two-step flow, kept for runs that can't pair in place. */
function manualPairInstructions(h: H): Html {
  return h.ol([h.Class("cloud-pair-rows list-decimal space-y-2 pl-5 text-sm")], [
    h.li([], [
      "Sign in at ",
      h.a([h.Href(FLEET_URL), h.Target("_blank"), h.Rel("noreferrer"), h.Class("font-medium underline underline-offset-2")], ["kanna.sh/fleet"]),
      " and add a machine to your Fleet.",
    ]),
    h.li([], [
      "Run ",
      h.code([h.Class("rounded bg-muted px-1.5 py-0.5 text-xs")], ["bunx kanna pair <code>"]),
      " in a terminal on this machine.",
    ]),
  ])
}

/** PairedSuccess: where the machine is live now, and a link there. */
export function pairedSuccess<M>(appOrigin: string, h: HtmlBuilder<M>): Html {
  const host = displayClaimUrl(appOrigin)
  return h.div([h.Class("cloud-pair-rows flex flex-col items-center gap-4 py-2 text-center")], [
    h.div([h.Class("cloud-pair-badge relative flex h-10 w-10 items-center justify-center rounded-full bg-emerald-500/15")], [
      h.span([h.AriaHidden(true), h.Class("cloud-pair-ring absolute inset-0 rounded-full border border-emerald-500/60")], []),
      // Lucide's check, with its path turned round: it starts at the short
      // stroke, so it draws the way a hand would.
      h.svg([
        h.AriaHidden(true),
        h.Attribute("viewBox", "0 0 24 24"),
        h.Attribute("fill", "none"),
        h.Attribute("stroke", "currentColor"),
        h.Attribute("stroke-width", "2"),
        h.Attribute("stroke-linecap", "round"),
        h.Attribute("stroke-linejoin", "round"),
        h.Class("cloud-pair-check h-5 w-5 text-emerald-500"),
      ], [h.path([h.Attribute("d", "M4 12l5 5L20 6"), h.Attribute("pathLength", "1")], [])]),
    ]),
    h.p([h.Class("text-sm text-muted-foreground")], [
      "This machine is live at ",
      h.span([h.Class("font-medium text-foreground")], [host]),
      " — it stays reachable while kanna is running.",
    ]),
    h.a([h.Href(appOrigin), h.Target("_blank"), h.Rel("noreferrer"), h.Class(cn(PRIMARY_ACTION_CLASS, "group"))], [
      `Open ${host}`,
      ArrowUpRight({ class: OUTBOUND_ARROW_CLASS }, h),
    ]),
  ])
}

/**
 * Copy, then a check for a moment. The two icons cross-fade with a touch of
 * blur and scale, so the swap reads as one icon changing, not two popping.
 */
function copyLinkButton(model: Model, text: string, disabled: boolean, h: H): Html {
  const iconClass = "absolute inset-0 m-auto size-3.5 transition-[opacity,scale,filter] duration-150 ease-snappy"
  const label = model.copied ? "Copied" : "Copy link"
  return h.button([
    h.Type("button"),
    ...(disabled ? [h.Disabled(true)] : []),
    h.Title(label),
    h.AriaLabel(label),
    h.OnClick(Message.ClickedCopyLink({ text })),
    h.Class("relative size-7 shrink-0 rounded-full text-muted-foreground transition-[scale,background-color,color,opacity] duration-150 ease-snappy hover:bg-foreground/5 hover:text-foreground active:scale-[0.95] disabled:pointer-events-none disabled:opacity-0"),
  ], [
    Copy({ class: cn(iconClass, model.copied ? "scale-50 opacity-0 blur-[2px]" : "scale-100 opacity-100") }, h),
    Check({ class: cn(iconClass, "text-emerald-500", model.copied ? "scale-100 opacity-100" : "scale-50 opacity-0 blur-[2px]") }, h),
  ])
}

/**
 * The claim URL, to open or to copy. It has this shape before the link
 * exists too, with a label where the URL will be and the actions waiting, so
 * the link arriving changes one line of text and nothing moves.
 */
function claimLink(model: Model, claimUrl: string | undefined, showOpenButton: boolean, h: H): Html {
  const ready = Boolean(claimUrl)
  const swapClass = "col-start-1 row-start-1 min-w-0 justify-self-start transition-[opacity,filter] duration-200 ease-snappy"
  const hiddenClass = "pointer-events-none opacity-0 blur-[2px]"
  return h.div([h.Class("cloud-pair-rows flex flex-col items-center gap-4")], [
    h.div([h.Class("flex h-9 w-full items-center gap-1 rounded-full border border-border bg-muted/40 pl-3.5 pr-1")], [
      h.div([h.Class("grid min-w-0 flex-1 items-center")], [
        // Stopped once the link is in: hidden, it would shimmer forever.
        animatedShinyText({
          animate: !ready,
          class: cn(swapClass, "mx-0 max-w-full text-xs", ready && hiddenClass),
          attributes: [h.AriaHidden(ready)],
        }, ["Getting your link…"], h),
        h.a([
          ...(claimUrl ? [h.Href(claimUrl)] : []),
          h.Target("_blank"),
          h.Rel("noreferrer"),
          h.AriaHidden(!ready),
          h.Class(cn(swapClass, "max-w-full truncate font-mono text-xs text-muted-foreground hover:text-foreground", !ready && hiddenClass)),
        ], claimUrl ? [displayClaimUrl(claimUrl)] : []),
      ]),
      copyLinkButton(model, claimUrl ?? "", !ready, h),
    ]),
    showOpenButton
      ? h.a([
        ...(claimUrl ? [h.Href(claimUrl)] : []),
        h.Target("_blank"),
        h.Rel("noreferrer"),
        h.AriaDisabled(!ready),
        h.Class(cn(PRIMARY_ACTION_CLASS, "group mt-1 w-full", !ready && "pointer-events-none opacity-50")),
      ], ["Open link & sign in", ArrowUpRight({ class: OUTBOUND_ARROW_CLASS }, h)])
      : null,
  ])
}

function retryLink(session: PairSessionState, starting: boolean, h: H): Html {
  return h.div([h.Class("cloud-pair-rows flex flex-col items-center gap-3 py-2 text-center")], [
    h.p([h.Class("text-sm text-muted-foreground")], [
      session.status === "expired"
        ? "That link expired."
        : `Couldn't reach kanna.sh${session.error ? ` (${session.error})` : ""}.`,
    ]),
    h.button([
      h.Type("button"),
      h.OnClick(Message.ClickedRetry()),
      ...(starting ? [h.Disabled(true)] : []),
      h.Class(cn(PRIMARY_ACTION_CLASS, "disabled:opacity-60 disabled:active:scale-100")),
    ], [
      // Turns while the request is out, so the press is seen to be working.
      RefreshCw({ class: cn("h-4 w-4", starting && "animate-spin") }, h),
      "Get a new link",
    ]),
  ])
}

function viewContent(model: Model, session: PairSessionState, showOpenButton: boolean, h: H): Html {
  const view = viewFor(session)
  return view === "paired" && session.appOrigin
    ? pairedSuccess(session.appOrigin, h)
    : view === "manual"
      ? manualPairInstructions(h)
      : view === "retry"
        ? retryLink(session, model.starting, h)
        : claimLink(model, session.status === "waiting" ? session.claimUrl : undefined, showOpenButton, h)
}

export interface ViewInputs {
  showOpenButton?: boolean
}

/**
 * The claim URL as a link to open or copy, plus every state the session can
 * be in. No QR: pairing is finished in a browser on this machine. The links
 * are `target="_blank"`, a new tab on the web and the default browser in
 * Kanna for Mac.
 *
 * The views swap (motion in index.css, under "Kanna Cloud pairing"): the old
 * view stays for its short fade, inert and laid over the new one, and the box
 * glides to the new view's height. The first view doesn't animate: the
 * dialog or wizard step it sits in is already arriving.
 */
export const view = Submodel.defineView<Model, Message, ViewInputs>((model, { showOpenButton = true }, h) => {
  const key = viewFor(model.shown)
  const leaving = model.leaving
  // The 4px the box gives up and the inner takes back leave room for focus
  // rings and the taller view's first frames inside the clip.
  return h.div([
    h.Class("cloud-pair-stage -m-1 overflow-clip"),
    ...(model.height === null ? [] : [h.Style({ height: `${model.height}px` })]),
  ], [
    h.div([h.Class("relative p-1"), h.OnMount(StageMount())], [
      leaving
        ? h.keyed("div")(`leaving-${leaving.key}`, [
          h.Inert(true),
          h.AriaHidden(true),
          h.Class("cloud-pair-view-out pointer-events-none absolute inset-x-1 top-1"),
          h.OnMount(LeavingViewMount()),
        ], [viewContent(model, leaving.session, showOpenButton, h)])
        : null,
      h.keyed("div")(key, model.swapped ? [h.Class("cloud-pair-view-in")] : [], [viewContent(model, model.shown, showOpenButton, h)]),
    ]),
  ])
})
