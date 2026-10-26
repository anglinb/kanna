import { describe, expect, test } from "bun:test"
import { Story } from "foldkit/test"
import { SIDEBAR_FOCUS_MODE_STORAGE_KEY } from "../../../client/lib/storageKeys"
import type { SidebarData, SidebarProjectGroup } from "../../../shared/types"
import {
  focusSidebarData,
  initialModel,
  load,
  Message,
  resolveFocusedProjectGroup,
  SaveFocusMode,
  update,
} from "./focusMode"
import { memoryStorage } from "./testing"

function group(groupKey: string): SidebarProjectGroup {
  return {
    groupKey,
    title: groupKey,
    realTitle: groupKey,
    localPath: `/repo/${groupKey}`,
    chats: [],
    previewChats: [],
    olderChats: [],
    defaultCollapsed: false,
  }
}

function data(groups: SidebarProjectGroup[]): SidebarData {
  return { projectGroups: groups }
}

describe("focus mode", () => {
  test("loads the flag the React store kept", () => {
    expect(load(memoryStorage({ [SIDEBAR_FOCUS_MODE_STORAGE_KEY]: "1" })).enabled).toBe(true)
    expect(load(memoryStorage({ [SIDEBAR_FOCUS_MODE_STORAGE_KEY]: "0" })).enabled).toBe(false)
    expect(load(memoryStorage()).enabled).toBe(false)
  })

  test("toggles the flag, and saves each change", () => {
    Story.story(
      update,
      Story.given(initialModel),
      Story.message(Message.ToggledFocusMode()),
      Story.Command.expectExact(SaveFocusMode({ enabled: true })),
      Story.Command.resolve(SaveFocusMode, Message.CompletedSave()),
      Story.model((model) => expect(model.enabled).toBe(true)),
      Story.message(Message.ToggledFocusMode()),
      Story.Command.expectExact(SaveFocusMode({ enabled: false })),
      Story.Command.resolve(SaveFocusMode, Message.CompletedSave()),
      Story.model((model) => expect(model.enabled).toBe(false)),
    )
  })

  test("setting the flag to what it already is changes nothing", () => {
    Story.story(
      update,
      Story.given(initialModel),
      Story.message(Message.ChangedFocusMode({ enabled: false })),
      Story.Command.expectNone(),
      Story.model((model) => expect(model).toBe(initialModel)),
    )
  })
})

describe("resolveFocusedProjectGroup", () => {
  const groups = [group("p1"), group("p2")]

  test("resolves the current project while focus mode is on", () => {
    expect(resolveFocusedProjectGroup(groups, true, "p2")).toBe(groups[1])
  })

  test("resolves nothing while focus mode is off", () => {
    expect(resolveFocusedProjectGroup(groups, false, "p2")).toBeNull()
  })

  test("resolves nothing when no project is current", () => {
    expect(resolveFocusedProjectGroup(groups, true, null)).toBeNull()
  })

  // A hidden or deleted project leaves the snapshot while focus is still on.
  // Falling back to every project beats showing an empty sidebar.
  test("resolves nothing when the focused project has left the snapshot", () => {
    expect(resolveFocusedProjectGroup(groups, true, "gone")).toBeNull()
  })
})

describe("focusSidebarData", () => {
  test("keeps every project when nothing is focused", () => {
    const snapshot = data([group("p1"), group("p2")])
    expect(focusSidebarData(snapshot, null)).toBe(snapshot)
  })

  test("narrows to the focused project", () => {
    const snapshot = data([group("p1"), group("p2")])
    const focused = focusSidebarData(snapshot, snapshot.projectGroups[1])
    expect(focused.projectGroups).toEqual([snapshot.projectGroups[1]])
  })

  // Identity matters: the rows below are memoized on the snapshot.
  test("keeps the snapshot itself when it already holds only the focused project", () => {
    const snapshot = data([group("p1")])
    expect(focusSidebarData(snapshot, snapshot.projectGroups[0])).toBe(snapshot)
  })
})
