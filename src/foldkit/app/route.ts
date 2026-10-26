import { Schema, pipe } from "effect"
import { Route } from "foldkit"
import { defineRouteUnion, literal, slash, string } from "foldkit/route"

// The React client's routes (src/client/app/App.tsx). `/settings` alone
// redirects to its first section; anything unmatched renders nothing, as
// <Routes> with no match did.

export const AppRoute = defineRouteUnion({
  Root: {},
  Home: {},
  SettingsIndex: {},
  Settings: { sectionId: Schema.String },
  Chat: { chatId: Schema.String },
  Project: { projectId: Schema.String },
  Terminal: {},
  Workflows: {},
  OpenRouterCallback: {},
  NotFound: { path: Schema.String },
})
export type AppRoute = typeof AppRoute.Type

export const rootRouter = pipe(Route.root, Route.mapTo(AppRoute.Root))
export const homeRouter = pipe(literal("home"), Route.mapTo(AppRoute.Home))
export const settingsIndexRouter = pipe(literal("settings"), Route.mapTo(AppRoute.SettingsIndex))
export const settingsRouter = pipe(literal("settings"), slash(string("sectionId")), Route.mapTo(AppRoute.Settings))
export const chatRouter = pipe(literal("chat"), slash(string("chatId")), Route.mapTo(AppRoute.Chat))
export const projectRouter = pipe(literal("project"), slash(string("projectId")), Route.mapTo(AppRoute.Project))
export const terminalRouter = pipe(literal("terminal"), Route.mapTo(AppRoute.Terminal))
export const workflowsRouter = pipe(literal("workflows"), Route.mapTo(AppRoute.Workflows))
export const openRouterCallbackRouter = pipe(
  literal("oauth"),
  slash(literal("openrouter")),
  slash(literal("callback")),
  Route.mapTo(AppRoute.OpenRouterCallback),
)

const routeParser = Route.oneOf(
  rootRouter,
  homeRouter,
  settingsIndexRouter,
  settingsRouter,
  chatRouter,
  projectRouter,
  terminalRouter,
  workflowsRouter,
  openRouterCallbackRouter,
)

export const urlToAppRoute = Route.parseUrlWithFallback(routeParser, AppRoute.NotFound)

/** The path a route builds, for navigation Commands and links. */
export function routePath(route: AppRoute): string {
  return AppRoute.match(route, {
    Root: () => rootRouter(),
    Home: () => homeRouter(),
    SettingsIndex: () => settingsIndexRouter(),
    Settings: ({ sectionId }) => settingsRouter({ sectionId }),
    Chat: ({ chatId }) => chatRouter({ chatId }),
    Project: ({ projectId }) => projectRouter({ projectId }),
    Terminal: () => terminalRouter(),
    Workflows: () => workflowsRouter(),
    OpenRouterCallback: () => openRouterCallbackRouter(),
    NotFound: ({ path }) => path,
  })
}

/** The open chat, if the route is one. */
export function routeChatId(route: AppRoute): string | null {
  return route._tag === "Chat" ? route.chatId : null
}
