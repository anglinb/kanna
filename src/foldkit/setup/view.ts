import { Schema } from "effect"
import { Mount, Submodel } from "foldkit"
import type { Html, HtmlBuilder } from "foldkit/html"
import { displayClaimUrl } from "../../client/lib/pairSession"
import { cn } from "../../client/lib/utils"
import { AUTH_SERVICE_LABELS, type AuthServiceId, type AuthServiceSnapshot } from "../../shared/types"
import type { SliceViewInputs } from "../app/slice"
import * as ProviderAuth from "../core/stores/providerAuth"
import * as AuthCard from "../settings/auth-cards"
import * as CloudPair from "../settings/cloud-pair"
import { button } from "../ui/button"
import { ArrowUpRight, Check, ChevronLeft, Cloud, Flower, LaptopMinimal } from "../ui/icons"
import { domStream } from "../ui/overlay/stream"
import { AUTH_SERVICE_ICONS } from "../ui/provider-icons"
import { Message, type Model, type SetupStep } from "./model"
import { done, macSetupCards, macSetupSatisfied, setupList, setupRow } from "./rows"
import { stepsOf } from "./update"

// Full-screen, distraction-free onboarding flow:
//   0. This Mac (Kanna for Mac only) → 1. GitHub (skippable) → 2. at least
//   one coding agent → 3. OpenRouter (skippable) → 4. Kanna Cloud
//   (skippable, omitted when unavailable) → 5. done.
// Reuses the AuthCard sign-in mechanics; steps that are already satisfied
// are skipped on open, and skippable steps auto-advance the moment they
// connect.

type H = HtmlBuilder<Message>

const AGENT_SERVICES: AuthServiceId[] = ["claude", "codex", "cursor"]
const SUMMARY_SERVICES: AuthServiceId[] = ["claude", "codex", "cursor", "gh", "openrouter"]

/** A title and, at most, one short line. The card under it says the rest. */
function stepHeading(title: string, description: string | undefined, h: H): Html {
  return h.div([h.Class("space-y-1.5 text-center")], [
    h.h1([h.Class("text-xl font-semibold text-foreground")], [title]),
    description ? h.p([h.Class("mx-auto max-w-sm text-sm text-muted-foreground")], [description]) : null,
  ])
}

const FOOTER_PRESS = "transition-[scale,background-color,color,border-color] duration-150 ease-snappy active:scale-[0.97]"
/** Back, Continue and the link that stands in for it: one height, so the row reads as one control. */
const FOOTER_HEIGHT = "h-11 min-h-11"

interface FooterOptions {
  canContinue: boolean
  back: boolean
  skip: boolean
  hint?: string
  link?: { href: string; label: string }
}

/**
 * Shared step footer:
 *   [ (‹)  |        Continue        ]
 *              Skip for now
 * Back is a circular icon button inline with Continue; Skip sits below.
 *
 * A step whose own action happens elsewhere (Kanna Cloud's sign-in link)
 * passes `link`: until the step is done, that link takes Continue's place,
 * so the step never shows a dead Continue next to the thing to do.
 */
function stepFooter(options: FooterOptions, h: H): Html {
  const { canContinue, link, hint } = options
  return h.div([h.Class("mt-auto space-y-2 pt-10")], [
    h.div([h.Class("flex items-center gap-2")], [
      // Back (or an equal spacer) plus a mirrored spacer on the right keep
      // Continue the same width and dead-center on every step.
      options.back
        ? button({
          variant: "outline",
          class: cn(FOOTER_HEIGHT, "w-11 shrink-0 rounded-full p-0", FOOTER_PRESS),
          attributes: [h.AriaLabel("Back"), h.OnClick(Message.ClickedBack())],
        }, [ChevronLeft({ class: "h-4 w-4" }, h)], h)
        : h.div([h.AriaHidden(true), h.Class(cn(FOOTER_HEIGHT, "w-11 shrink-0"))], []),
      link && !canContinue
        ? h.a([
          h.Href(link.href),
          h.Target("_blank"),
          h.Rel("noreferrer"),
          h.Class(cn(
            FOOTER_HEIGHT,
            "inline-flex flex-1 items-center justify-center gap-1.5 rounded-full bg-primary text-sm font-medium text-primary-foreground hover:bg-primary/90",
            FOOTER_PRESS,
          )),
        ], [link.label, ArrowUpRight({ class: "h-4 w-4" }, h)])
        // Disabled reads as not-yet, not as a broken button: a quiet muted
        // fill instead of a half-transparent primary.
        : button({
          class: cn(FOOTER_HEIGHT, "flex-1 disabled:bg-muted disabled:text-muted-foreground disabled:opacity-100", FOOTER_PRESS),
          disabled: !canContinue,
          attributes: [h.OnClick(Message.ClickedContinue())],
        }, ["Continue"], h),
      h.div([h.AriaHidden(true), h.Class(cn(FOOTER_HEIGHT, "w-11 shrink-0"))], []),
    ]),
    // The skip slot always occupies its height so the row above never jumps.
    options.skip
      ? button({
        variant: "ghost",
        class: "mx-auto flex h-10 w-auto px-4 text-muted-foreground transition-colors duration-150 hover:bg-transparent dark:hover:bg-transparent hover:border-transparent hover:text-foreground",
        attributes: [h.OnClick(Message.ClickedSkip())],
      }, ["Skip for now"], h)
      : h.div([...(hint ? [] : [h.AriaHidden(true)]), h.Class("flex h-10 items-center justify-center")], [
        hint ? h.p([h.Class("text-center text-xs text-muted-foreground")], [hint]) : null,
      ]),
  ])
}

/** A row of the final summary: done, or quietly skipped. */
function summaryRow(icon: Html, title: string, isDone: boolean, pending: string, h: H): Html {
  return setupRow({
    icon,
    title,
    muted: !isDone,
    action: isDone ? done(h) : h.span([h.Class("pr-1 text-xs text-muted-foreground/70")], [pending]),
  }, h)
}

/** The leaving step's own exit ending (its children animate too, and their ends bubble). */
export const LeavingMount = Mount.defineStream("SetupWizardLeaving", {
  args: { id: Schema.Number },
  messages: [Message.EndedLeaving],
  execute: ({ element, id }) => domStream<typeof Message.EndedLeaving.Type>((emit) => {
    const onAnimationEnd = (event: Event) => {
      if (event.target === event.currentTarget) emit(Message.EndedLeaving({ id }))
    }
    element.addEventListener("animationend", onAnimationEnd)
    return () => element.removeEventListener("animationend", onAnimationEnd)
  }),
})

interface StepContext {
  model: Model
  auth: ProviderAuth.Model
  status: ProviderAuth.SetupStatus
  stepIndex: number
  machinePaired: boolean
}

function authCard(context: StepContext, step: SetupStep, service: AuthServiceSnapshot, h: H): Html {
  const id = `${step}-${AuthCard.cardId(service)}`
  return h.submodel({
    slotId: id,
    model: context.model.cards[id] ?? AuthCard.init(id),
    view: AuthCard.view,
    viewInputs: { service, row: true },
    toParentMessage: (message) => Message.GotAuthCardMessage({ id, message }),
  })
}

/** Any step, for the one entering and the one leaving alike. */
function renderStep(current: SetupStep, context: StepContext, h: H): ReadonlyArray<Html> {
  const { model, auth, status, stepIndex, machinePaired } = context
  const service = (id: AuthServiceId) => ProviderAuth.selectAuthService(auth.snapshot, id)

  switch (current) {
    case "mac":
      return [
        stepHeading("Set up this Mac", "Keep your agents running while you're away.", h),
        h.div([h.Class("mt-8")], [
          macSetupCards(model.macState, {
            openLoginItems: Message.ClickedOpenLoginItems(),
            setLoginItem: (enabled) => Message.ToggledLoginItem({ enabled }),
            setKeepAwake: (onPower) => Message.ToggledKeepAwake({ onPower }),
            setKeepAwakeOnBattery: (onBattery) => Message.ToggledKeepAwakeOnBattery({ onBattery }),
            openFullDiskAccess: Message.ClickedOpenFullDiskAccess(),
          }, h),
        ]),
        stepFooter({ canContinue: true, back: false, skip: false }, h),
      ]
    case "github": {
      const gh = service("gh")
      return [
        stepHeading("Connect GitHub", "Clone repos and open pull requests.", h),
        setupList({ class: "mt-8" }, [gh ? authCard(context, current, gh, h) : null], h),
        stepFooter({ canContinue: status.githubConnected, back: stepIndex > 0, skip: !status.githubConnected }, h),
      ]
    }
    case "agents": {
      const agents = AGENT_SERVICES.map(service).filter((entry): entry is AuthServiceSnapshot => entry !== null)
      return [
        stepHeading("Connect your agents", "At least one to start.", h),
        setupList({ class: "mt-8" }, agents.map((agent) => authCard(context, current, agent, h)), h),
        stepFooter({ canContinue: status.anyAgentConnected, back: stepIndex > 0, skip: false }, h),
      ]
    }
    case "openrouter": {
      const openrouter = service("openrouter")
      return [
        stepHeading("Connect OpenRouter", "Powers Pi, chat names and commit messages.", h),
        setupList({ class: "mt-8" }, [openrouter ? authCard(context, current, openrouter, h) : null], h),
        stepFooter({ canContinue: status.openRouterConnected, back: true, skip: !status.openRouterConnected }, h),
      ]
    }
    case "cloud": {
      const session = model.cloud.session
      return [
        stepHeading("Use this machine anywhere", "A free URL for it, in any browser.", h),
        h.div([h.Class("mt-8")], [
          h.submodel({
            slotId: "cloud-pair",
            model: model.cloud,
            view: CloudPair.view,
            viewInputs: { showOpenButton: false },
            toParentMessage: (message) => Message.GotCloudMessage({ message }),
          }),
        ]),
        stepFooter({
          canContinue: machinePaired,
          back: true,
          skip: !machinePaired,
          ...(session.status === "waiting" && session.claimUrl
            ? { link: { href: session.claimUrl, label: "Open link & sign in" } }
            : {}),
        }, h),
      ]
    }
    case "done": {
      const session = model.cloud.session
      return [
        h.div([h.Class("flex flex-col items-center gap-4")], [
          h.div([h.Class("flex h-12 w-12 items-center justify-center rounded-full border border-emerald-500/30 bg-emerald-500/10")], [
            Check({ class: "h-6 w-6 text-emerald-500" }, h),
          ]),
          stepHeading("You're all set", undefined, h),
        ]),
        setupList({ class: "mt-8" }, [
          ...SUMMARY_SERVICES.map((id) =>
            summaryRow(AUTH_SERVICE_ICONS[id]({ class: "size-4" }, h), AUTH_SERVICE_LABELS[id], service(id)?.authStatus === "signed_in", "Skipped", h)),
          model.macStepEnabled
            ? summaryRow(LaptopMinimal({ class: "size-4" }, h), "This Mac", macSetupSatisfied(model.macState), "Partly", h)
            : null,
          model.cloudStepEnabled
            ? summaryRow(
              Cloud({ class: "size-4" }, h),
              machinePaired && session.appOrigin ? displayClaimUrl(session.appOrigin) : "Kanna Cloud",
              machinePaired,
              "Skipped",
              h,
            )
            : null,
        ], h),
        h.div([h.Class("mt-auto pt-10")], [
          button({
            class: cn(FOOTER_HEIGHT, "w-full", FOOTER_PRESS),
            attributes: [h.OnClick(Message.ClickedStartBuilding())],
          }, ["Start Building"], h),
        ]),
      ]
    }
  }
}

export const view = Submodel.defineView<Model, Message, SliceViewInputs>((model, { app }, h) => {
  const auth = app.stores.providerAuth
  if (!auth.setupWizardOpen) return null

  const steps = stepsOf(model, app)
  const stepIndex = steps.indexOf(model.step)
  const progressPercent = ((stepIndex + 1) / steps.length) * 100
  const context: StepContext = {
    model,
    auth,
    status: ProviderAuth.setupStatus(auth),
    stepIndex,
    machinePaired: model.cloud.session.status === "paired",
  }
  const leaving = model.leaving

  return h.div([h.Class("fixed inset-0 z-[70] overflow-y-auto overflow-x-hidden bg-background animate-in fade-in duration-300")], [
    // Low-emphasis escape hatch: suppresses auto-launch, keeps the Setup card.
    h.button([
      h.Type("button"),
      h.OnClick(Message.ClickedSetUpLater()),
      h.Class("absolute right-4 top-4 z-10 rounded-full px-3 py-1.5 text-xs text-muted-foreground transition-colors hover:bg-muted/50 hover:text-foreground"),
    ], ["Set up later"]),

    h.div([h.Class("mx-auto flex min-h-full w-full max-w-md flex-col px-6 pb-10 pt-14 sm:pt-20")], [
      // Logo + progress. On the last step the bar fills, then both lift
      // away and the ending stands alone (index.css .wizard-header).
      h.div([
        h.Class("wizard-header mb-10 flex flex-col items-center gap-5"),
        ...(model.step === "done" ? [h.DataAttribute("finished", "true")] : []),
      ], [
        Flower({ class: "h-7 w-7 text-logo" }, h),
        h.div([h.Class("h-1 w-44 overflow-hidden rounded-full bg-muted")], [
          // Slides inside the track rather than changing width, so the
          // round end stays round through the overshoot.
          h.div([
            h.Class("wizard-progress h-full w-full rounded-full bg-logo"),
            h.Style({ transform: `translateX(${progressPercent - 100}%)` }),
          ], []),
        ]),
      ]),

      h.div([h.Class("relative flex flex-1 flex-col")], [
        leaving
          ? h.keyed("div")(`leave-${leaving.id}`, [
            h.Inert(true),
            h.AriaHidden(true),
            h.DataAttribute("direction", leaving.direction),
            h.Class("wizard-leave pointer-events-none absolute inset-0 flex flex-col"),
            h.OnMount(LeavingMount({ id: leaving.id })),
          ], renderStep(leaving.from, context, h))
          : null,
        h.keyed("div")(model.step, [
          h.DataAttribute("direction", model.enterDirection),
          h.Class("wizard-step flex flex-1 flex-col"),
        ], renderStep(model.step, context, h)),
      ]),
    ]),
  ])
})
