import { describe, test } from "bun:test"
import { Scene, Story } from "foldkit/test"
import type { ChatSchedule } from "../../shared/types"
import * as ContextMenu from "../ui/context-menu"
import { HoverMessage, ListHoverCardContent, ListHoverTracker, SyncHoverTracker } from "./hoverCard"
import * as ScheduleCard from "./scheduleCard"

// The transcript's live schedule card: its row, its menu's Edit, and its
// hover card's runs and Edit.

const SCHEDULE: ChatSchedule = {
  id: "s1",
  name: "Watch the charge limiter",
  content: "Check the limiter's logs",
  trigger: { kind: "interval", everyMs: 6 * 60 * 60_000 },
  target: { kind: "chat", chatId: "c1" },
  enabled: true,
  nextRunAt: Date.parse("2026-06-01T14:00:00Z"),
  runCount: 1,
  runs: [{ at: Date.parse("2026-06-01T08:00:00Z"), outcome: "sent", chatId: "c2" }],
  createdAt: 0,
} as unknown as ChatSchedule

const NOW = Date.parse("2026-06-01T12:00:00Z")

const view = Scene.withViewInputs(ScheduleCard.view, {
  card: { schedule: SCHEDULE, caption: "Scheduled · Every 6 hours · Check the limiter's logs", quote: false },
  currentChatId: "c1",
  now: NOW,
  chatTitle: (chatId: string) => (chatId === "c2" ? "Rate limit follow-up" : undefined),
  canOpenChats: true,
})

describe("ScheduleCard", () => {
  test("its menu's one item asks for the edit", () => {
    Story.story(
      ScheduleCard.update,
      Story.given(ScheduleCard.init("k")),
      Story.message(ScheduleCard.Message.GotMenuMessage({ message: ContextMenu.Message.RequestedContextMenu() })),
      Story.message(ScheduleCard.Message.GotMenuMessage({ message: ContextMenu.Message.ChoseItem({ value: "s1" }) })),
      Story.expectOutMessage(ScheduleCard.OutMessage.RequestedEdit({ scheduleId: "s1" })),
    )
  })

  test("Scene: the row says when it runs; its card lists the runs and edits", () => {
    Scene.scene(
      { update: ScheduleCard.update, view: view() },
      Scene.given(ScheduleCard.init("k")),
      Scene.expect(Scene.text("Watch the charge limiter")).toExist(),
      Scene.expect(Scene.text("in 2h")).toExist(),
      Scene.Mount.resolve(ListHoverTracker, HoverMessage.ChangedHoveredRow({ list: "schedule-card:k", key: "s1" })),
      Scene.expect(Scene.role("dialog")).toContainText("Sends to this chat"),
      Scene.expect(Scene.role("button", { name: /Rate limit follow-up/ })).toExist(),
      Scene.Mount.resolve(ListHoverCardContent, HoverMessage.ChangedHoveredRow({ list: "schedule-card:k", key: "s1" })),
      Scene.click(Scene.role("button", { name: "Edit by asking the agent" })),
      Scene.expectOutMessage(ScheduleCard.OutMessage.RequestedEdit({ scheduleId: "s1" })),
      Scene.Command.resolve(SyncHoverTracker, HoverMessage.CompletedSyncHoverTracker()),
    )
  })
})
