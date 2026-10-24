import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { fromString } from "foldkit/url"
import { AppRoute, chatRouter, routePath, urlToAppRoute } from "./route"

const parse = (href: string) => urlToAppRoute(Option.getOrThrow(fromString(`http://localhost${href}`)))

describe("routes", () => {
  test("parse every React route, query strings ignored", () => {
    expect(parse("/")._tag).toBe("Root")
    expect(parse("/home?theme=dark")._tag).toBe("Home")
    expect(parse("/settings")._tag).toBe("SettingsIndex")
    expect(parse("/settings/general")).toEqual(AppRoute.Settings({ sectionId: "general" }))
    expect(parse("/chat/demo-chat-units")).toEqual(AppRoute.Chat({ chatId: "demo-chat-units" }))
    expect(parse("/project/p1")._tag).toBe("Project")
    expect(parse("/terminal")._tag).toBe("Terminal")
    expect(parse("/workflows")._tag).toBe("Workflows")
    expect(parse("/oauth/openrouter/callback?code=x")._tag).toBe("OpenRouterCallback")
    expect(parse("/nope")._tag).toBe("NotFound")
  })

  test("build paths", () => {
    expect(chatRouter({ chatId: "abc" })).toBe("/chat/abc")
    expect(routePath(AppRoute.Settings({ sectionId: "providers" }))).toBe("/settings/providers")
  })
})
