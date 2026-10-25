import { describe, expect, test } from "bun:test"
import { Option } from "effect"
import { fromString } from "foldkit/url"
import * as AppDialog from "../ui/app-dialog"
import { AppAction } from "./action"
import { Message } from "./message"
import type { Flags } from "./model"
import * as Stores from "./stores"
import { init, update } from "./update"

class MemoryStorage {
  values = new Map<string, string>()
  getItem(key: string) { return this.values.get(key) ?? null }
  setItem(key: string, value: string) { this.values.set(key, value) }
  removeItem(key: string) { this.values.delete(key) }
  clear() { this.values.clear() }
  key() { return null }
  get length() { return this.values.size }
}

function boot(path = "/home") {
  const flags: Flags = {
    sidebarCollapsed: false,
    systemTheme: "dark",
    initialAppSettings: null,
    stores: Stores.load(new MemoryStorage() as unknown as Storage),
  }
  return init(flags, Option.getOrThrow(fromString(`http://localhost${path}`))).model
}

describe("root actions", () => {
  test("delete asks first; confirming sends chat.delete, cancelling sends nothing", () => {
    const asked = update(boot(), Message.RequestedAppAction({ action: AppAction.DeleteChat({ chatId: "c1", title: "Fix it" }) }))
    expect(Option.isSome(asked.model.appDialog.request)).toBe(true)
    const request = Option.getOrThrow(asked.model.appDialog.request)
    expect(request.title).toBe("Delete Chat")

    const confirmed = update(asked.model, Message.GotAppDialogMessage({ message: AppDialog.Message.ClickedConfirm() }))
    expect(confirmed.model.actions.pendingDialog).toBeNull()
    expect(confirmed.commands?.map((command) => command.name)).toContain("DeleteChat")

    const cancelled = update(asked.model, Message.GotAppDialogMessage({ message: AppDialog.Message.ClickedCancel() }))
    expect(cancelled.commands?.map((command) => command.name) ?? []).not.toContain("DeleteChat")
  })

  test("rename prompts with the current title and renames only on a new one", () => {
    const asked = update(boot(), Message.RequestedAppAction({ action: AppAction.RenameChat({ chatId: "c1", title: "Old" }) }))
    const typed = update(asked.model, Message.GotAppDialogMessage({ message: AppDialog.Message.ChangedInput({ value: "New" }) }))
    const confirmed = update(typed.model, Message.GotAppDialogMessage({ message: AppDialog.Message.ClickedConfirm() }))
    expect(confirmed.commands?.map((command) => command.name)).toContain("SendActionCommand")
    const unchanged = update(asked.model, Message.GotAppDialogMessage({ message: AppDialog.Message.ClickedConfirm() }))
    expect(unchanged.commands?.map((command) => command.name) ?? []).not.toContain("SendActionCommand")
  })

  test("creating a chat makes an id first, then creates and navigates", () => {
    const asked = update(boot(), Message.RequestedAppAction({ action: AppAction.CreateChat({ projectId: "p1" }) }))
    expect(asked.commands?.map((command) => command.name)).toEqual(["PrepareCreateChat"])
  })
})
