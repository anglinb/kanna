import type { Document, Html, HtmlBuilder } from "foldkit/html"
import { getBrowserWindowTitle } from "../../client/app/chatNotifications"
import { cn } from "../../client/lib/utils"
import { APP_NAME } from "../../shared/branding"
import { Flower } from "../ui/icons"
import { Message } from "./message"
import type { Model } from "./model"
import * as SidebarSlice from "../sidebar"
import * as HomeSlice from "../home"
import * as SettingsSlice from "../settings"
import * as ChatPageSlice from "../chat"
import * as PaletteSlice from "../palette"
import * as SetupSlice from "../setup"
import * as WorkflowsSlice from "../workflows"
import * as TerminalPageSlice from "../terminal"
import * as AppDialog from "../ui/app-dialog"
import * as ShareDialog from "../chat/shareDialog"
import * as OpenRouterCallback from "./openRouterCallback"
import { AppRoute } from "./route"
import { activeChatId, activeProjectId, sidebarData } from "./update"

// App.tsx: the auth gate, then KannaLayout (sidebar beside the routed page).

export const view = (model: Model, h: HtmlBuilder<Message>): Document => ({
  title: model.auth._tag === "Ready" && !model.pageHidden
    ? getBrowserWindowTitle({
      appName: APP_NAME,
      sidebarData: sidebarData(model),
      activeProjectId: activeProjectId(model),
      activeChatId: activeChatId(model),
    })
    : APP_NAME,
  body: bodyView(model, h),
})

function bodyView(model: Model, h: HtmlBuilder<Message>): Html {
  const auth = model.auth
  if (auth._tag === "Checking") return checkingView(h)
  if (auth._tag === "Locked") return passwordView(auth, h)
  // Rendered outside the layout: opened as a bare OAuth popup.
  if (model.route._tag === "OpenRouterCallback") {
    return h.submodel({ slotId: "openrouter-callback", model: model.openRouterCallback, view: OpenRouterCallback.view, toParentMessage: (message) => Message.GotOpenRouterCallbackMessage({ message }) })
  }
  return layoutView(model, h)
}

function checkingView(h: HtmlBuilder<Message>): Html {
  return h.div(
    [h.Class("flex min-h-[100dvh] items-center justify-center bg-background text-sm text-muted-foreground")],
    ["Checking session…"],
  )
}

function passwordView(auth: Extract<Model["auth"], { _tag: "Locked" }>, h: HtmlBuilder<Message>): Html {
  return h.div([h.Class("flex min-h-[100dvh] items-center justify-center bg-background px-6 py-10")], [
    h.div([h.Class(cn("bg-card text-card-foreground", "w-full max-w-md rounded-3xl border border-border bg-card shadow-sm"))], [
      h.div([h.Class(cn("flex flex-col space-y-1.5 p-2", "flex flex-col p-2 space-y-3 px-6 pt-6 pb-5 pl-[28px]"))], [
        h.div([h.Class("flex items-center gap-3")], [
          Flower({ class: "h-5 w-5 text-logo" }, h),
          h.div([], [
            h.h3([h.Class(cn("text-2xl font-semibold leading-none tracking-tight", "font-logo text-xl uppercase text-slate-600 dark:text-slate-100"))], [APP_NAME]),
          ]),
        ]),
        h.p([h.Class(cn("text-sm text-muted-foreground", "leading-6"))], ["Enter your password to continue."]),
      ]),
      h.div([h.Class(cn("p-6 pt-0", "px-6 pb-6"))], [
        h.form([h.Class("space-y-4"), h.OnSubmit(Message.SubmittedPassword())], [
          auth.error
            ? h.div([h.Class("rounded-2xl border border-destructive/20 bg-destructive/10 px-4 py-3 text-sm text-foreground")], [auth.error])
            : h.empty,
          h.input([
            h.Id("kanna-password"),
            h.Type("password"),
            h.Autocomplete("current-password"),
            h.Value(auth.password),
            h.OnInput((value) => Message.ChangedPassword({ value })),
            h.Placeholder("Password"),
            h.Disabled(auth.submitting),
            h.Class(cn(
              "flex w-full rounded-lg border border-border bg-background px-3 py-2 text-sm text-foreground outline-none placeholder:text-muted-foreground disabled:cursor-not-allowed disabled:opacity-50",
              "h-11 rounded-2xl bg-background",
            )),
          ]),
          h.button([
            h.Type("submit"),
            h.Disabled(auth.submitting || auth.password.length === 0),
            h.Class(cn(
              "touch-manipulation inline-flex items-center justify-center whitespace-nowrap cursor-pointer rounded-md text-sm font-medium ring-offset-background transition-all focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring focus-visible:ring-offset-2 disabled:pointer-events-none",
              "bg-primary text-primary-foreground disabled:bg-primary/50 disabled:text-primary-foreground/90 hover:bg-primary/90",
              "h-10 px-4 rounded-full py-2",
              "h-11 w-full",
            )),
          ], [auth.submitting ? "Unlocking..." : "Unlock"]),
        ]),
      ]),
    ]),
  ])
}

function layoutView(model: Model, h: HtmlBuilder<Message>): Html {
  const app = { app: model }
  return h.div([h.Class("flex h-[100dvh] min-h-[100dvh] overflow-hidden")], [
    h.submodel({ slotId: "sidebar", model: model.sidebar, view: SidebarSlice.view, viewInputs: app, toParentMessage: (message) => Message.GotSidebarMessage({ message }) }),
    pageView(model, h),
    h.submodel({ slotId: "setup", model: model.setup, view: SetupSlice.view, viewInputs: app, toParentMessage: (message) => Message.GotSetupMessage({ message }) }),
    h.submodel({ slotId: "palette", model: model.palette, view: PaletteSlice.view, viewInputs: app, toParentMessage: (message) => Message.GotPaletteMessage({ message }) }),
    h.submodel({
      slotId: "share-dialog",
      model: model.shareDialog,
      view: ShareDialog.view,
      viewInputs: { shareUrl: model.actions.standaloneShareUrl ?? undefined },
      toParentMessage: (message) => Message.GotShareDialogMessage({ message }),
    }),
    h.submodel({ slotId: "app-dialog", model: model.appDialog, view: AppDialog.view, toParentMessage: (message) => Message.GotAppDialogMessage({ message }) }),
  ])
}

function pageView(model: Model, h: HtmlBuilder<Message>): Html {
  const app = { app: model }
  const home = () => h.submodel({ slotId: "home", model: model.home, view: HomeSlice.view, viewInputs: app, toParentMessage: (message) => Message.GotHomeMessage({ message }) })
  // One function for `/` and a project's page: the view plugin gives each
  // function's result its own identity, and two arms would replace the page
  // between them. React Router rendered the same element for both routes, so
  // the page (and its effects) carried over.
  const projectsPage = () => h.div([h.Class("hidden md:contents")], [home()])
  return AppRoute.match(model.route, {
    // On mobile the sidebar fills the screen at `/` (see KannaSidebar), so
    // the projects page hides there and lives at `/home` instead. Desktop
    // shows it at both paths.
    Root: projectsPage,
    Home: () => home(),
    SettingsIndex: () => null,
    Settings: () => h.submodel({ slotId: "settings", model: model.settings, view: SettingsSlice.view, viewInputs: app, toParentMessage: (message) => Message.GotSettingsMessage({ message }) }),
    Chat: () => h.submodel({ slotId: "chat", model: model.chatPage, view: ChatPageSlice.view, viewInputs: app, toParentMessage: (message) => Message.GotChatPageMessage({ message }) }),
    Project: projectsPage,
    Terminal: () => h.submodel({ slotId: "terminal", model: model.terminalPage, view: TerminalPageSlice.view, viewInputs: app, toParentMessage: (message) => Message.GotTerminalPageMessage({ message }) }),
    Workflows: () => h.submodel({ slotId: "workflows", model: model.workflows, view: WorkflowsSlice.view, viewInputs: app, toParentMessage: (message) => Message.GotWorkflowsMessage({ message }) }),
    OpenRouterCallback: () => null,
    NotFound: () => null,
  })
}

