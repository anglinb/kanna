import { describe, expect, test } from "bun:test"
import { Story } from "foldkit/test"
import { Message, STORAGE_NAME, Save, initialModel, load, update } from "./delegate"

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
}

describe("delegate store", () => {
  test("loads what the React store persisted", () => {
    const storage = new MemoryStorage()
    storage.setItem(STORAGE_NAME, JSON.stringify({ state: { projects: { p1: { on: true, chatId: "c1" } }, paneShown: {}, viewedAt: { c1: 5 } }, version: 1 }))
    const model = load(storage as unknown as Storage)
    expect(model.projects.p1).toEqual({ on: true, chatId: "c1" })
    expect(model.viewedAt.c1).toBe(5)
    expect(model.paneShown).toEqual({})
  })

  test("a preference change is saved", () => {
    const preference = { on: true, chatId: "c1" }
    Story.story(
      update,
      Story.given(initialModel),
      Story.message(Message.ChangedPreference({ projectId: "p1", preference })),
      Story.Command.expectExact(Save({ state: { ...initialModel, projects: { p1: preference } } })),
      Story.Command.resolve(Save, Message.CompletedSave()),
      Story.model((model) => expect(model.projects.p1).toEqual(preference)),
    )
  })

  test("the same preference again leaves the model as it was", () => {
    const preference = { on: true, chatId: "c1" }
    const given = { ...initialModel, projects: { p1: preference } }
    const result = update(given, Message.ChangedPreference({ projectId: "p1", preference: { ...preference } }))
    expect(result.model).toBe(given)
  })
})
