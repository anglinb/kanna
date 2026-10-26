import { describe, expect, test } from "bun:test"
import { Story } from "foldkit/test"
import { SIDEBAR_DELEGATORS_EXPANDED_STORAGE_KEY, SIDEBAR_PINNED_EXPANDED_STORAGE_KEY } from "../../../client/lib/storageKeys"
import { initialModel, load, Message, SaveSectionOverrides, sectionExpanded, sectionOverrides, update } from "./sidebarSection"
import { memoryStorage } from "./testing"

const changed = (scope: string, sectionKey: string, expanded: boolean) =>
  Message.ChangedSectionExpanded({ scope, sectionKey, expanded })

describe("sidebar sections", () => {
  test("loads the Pinned and Delegators folds the React store kept", () => {
    const model = load(memoryStorage({
      [SIDEBAR_PINNED_EXPANDED_STORAGE_KEY]: JSON.stringify({ recents: false, "project:p1": true, bad: "x" }),
      [SIDEBAR_DELEGATORS_EXPANDED_STORAGE_KEY]: JSON.stringify({ recents: true }),
    }))
    expect(model.overrides).toEqual({
      recents: { pinned: false, delegators: true },
      "project:p1": { pinned: true },
    })
  })

  test("an unreadable key starts that section from its default", () => {
    const model = load(memoryStorage({ [SIDEBAR_PINNED_EXPANDED_STORAGE_KEY]: "{oops", [SIDEBAR_DELEGATORS_EXPANDED_STORAGE_KEY]: JSON.stringify({ a: false }) }))
    expect(model.overrides).toEqual({ a: { delegators: false } })
  })

  test("folding Pinned writes every list's Pinned fold under its key", () => {
    Story.story(
      update,
      Story.given({ overrides: { other: { pinned: true, today: false } } }),
      Story.message(changed("recents", "pinned", false)),
      Story.Command.expectExact(SaveSectionOverrides({
        storageKey: SIDEBAR_PINNED_EXPANDED_STORAGE_KEY,
        json: JSON.stringify({ other: true, recents: false }),
      })),
      Story.Command.resolve(SaveSectionOverrides, Message.CompletedSave()),
      Story.model((model) => {
        expect(sectionOverrides(model, "recents")).toEqual({ pinned: false })
        expect(sectionExpanded(model, "other", "today")).toBe(false)
      }),
    )
  })

  test("a day's section is held in memory only", () => {
    Story.story(
      update,
      Story.given(initialModel),
      Story.message(changed("recents", "Today", false)),
      Story.Command.expectNone(),
      Story.model((model) => expect(sectionExpanded(model, "recents", "Today")).toBe(false)),
    )
    expect(sectionOverrides(initialModel, "nowhere")).toBe(sectionOverrides(initialModel, "elsewhere"))
  })
})
