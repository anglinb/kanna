import type { Html } from "foldkit/html"
import { deriveSentAttachments, deriveSubagentToolIds, latestWorkflows, orderTaskLog } from "../../client/components/chat-ui/widgets/derive"
import { PROVIDERS, type AgentProvider, type ChatSnapshot, type SubagentActivity } from "../../shared/types"
import type { AppModel } from "../app/slice"
import type { ChatPageSliceInputs } from "../chat/pageInputs"
import { sidebarThread } from "../chat/chatReference"
import { snapshotOf } from "../core/chatSession"
import * as ChatPreferences from "../core/stores/chatPreferences"
import * as AppDialog from "../ui/app-dialog"
import { attachmentsWidget } from "./attachments"
import { columnContext, rowMenu, type ColumnContext, type H } from "./context"
import { gitWidgetsView } from "./git"
import { HoverMessage } from "./hoverCard"
import { rowMenuView } from "./menus"
import { Message } from "./message"
import type { Model } from "./model"
import { fingerprint, ObserveWidgetsPage } from "./mounts"
import { widgetPresence } from "./parts"
import { portsWidget } from "./ports"
import { quickActionsWidget } from "./quickActions"
import { MINUTE_CLOCK_MS, schedulesWidget } from "./schedules"
import { tasksWidget } from "./tasks"
import { usageWidgets } from "./usage"
import { workflowWidget } from "./workflow"

// WidgetsSidebar (widgets/WidgetsSidebar.tsx): the right sidebar, one
// vertical, scrolling column of widgets. Git leads (branch and working tree,
// then history), then what runs on the agent's behalf (tasks, then any
// workflow opened up), what is set to run later (schedules), the files it
// sent, the servers it started and the commands that start them. Usage
// limits close the column.

const toHover = (message: HoverMessage) => Message.GotHoverMessage({ message })

export const TASKS_LIST = "tasks"
export const SCHEDULES_LIST = "schedules"
export const workflowList = (workflowId: string) => `workflow:${workflowId}`

const PROVIDER_LABELS = new Map(PROVIDERS.map((provider) => [provider.id, provider.label]))

/** The page's chat snapshot, when the session is the page's chat. */
export function pageSnapshot(app: AppModel, chatId: string | null): ChatSnapshot | null {
  if (!chatId || !app.chat || app.chat.chatId !== chatId) return null
  return snapshotOf(app.chat)
}

/** What the column reads off the page's chat (WidgetsSidebar's props from ChatPage). */
export function chatFacts(app: AppModel, chatId: string | null) {
  const snapshot = pageSnapshot(app, chatId)
  const entries = snapshot?.messages ?? []
  const subagents: readonly SubagentActivity[] = snapshot?.runtime.subagents ?? []
  return {
    entries,
    subagents,
    schedules: snapshot?.runtime.schedules ?? [],
    activeProvider: snapshot?.runtime.provider ?? null,
    toolIds: deriveSubagentToolIds(entries, subagents),
    // A workflow's own agents are on its card; in the Tasks list the run is one row.
    tasks: orderTaskLog(subagents),
    workflows: latestWorkflows(subagents),
  }
}

/** The harness the composer has selected (useComposer's selectedProvider). */
function selectedProvider(app: AppModel, chatId: string | null, activeProvider: AgentProvider | null): AgentProvider {
  const composerChatId = chatId ?? ChatPreferences.NEW_CHAT_COMPOSER_ID
  const preferences = app.stores.chatPreferences
  const state = ChatPreferences.getComposerState(preferences, app.stores.sidebar.data, composerChatId)
  const switchPending = ChatPreferences.hasPendingProviderSwitch(preferences, composerChatId) && activeProvider !== null && state.provider !== activeProvider
  return switchPending ? state.provider : activeProvider ?? state.provider
}

function columnView(context: ColumnContext, h: H): Html {
  const { model, app, chatId } = context
  const facts = chatFacts(app, chatId)
  const attachments = deriveSentAttachments(facts.entries)
  const stopping = new Set(model.stopping)
  const canOpenChats = true
  const paths = context.diffs.files.map((file) => file.path)
  const anyRunning = facts.subagents.some((task) => task.status === "running")
  const anyCounting = facts.schedules.some((schedule) => schedule.enabled && schedule.nextRunAt != null)
  const watch = {
    projectId: context.projectId,
    chatId,
    active: context.page.widgetsActive,
    isMobile: context.page.isMobile,
    widgetsChatKey: app.stores.appSettings.settings?.paneVisibility?.widgets === "project" ? null : chatId,
    filesKey: fingerprint(paths),
    reviewedPath: context.reviewedPath,
    // useNow (1s) while a task runs; useMinuteClock (20s) while a schedule counts down.
    clockMs: anyRunning ? 1_000 : anyCounting ? MINUTE_CLOCK_MS : null,
  }

  return h.div([
    h.DataAttribute("navbar-scroller", ""),
    h.Class("h-full min-h-0 overflow-y-auto overflow-x-hidden md:min-w-[370px]"),
  ], [
    // No gap: each slot carries its own top spacing, so a card's gap folds away with it.
    h.div([h.DataAttribute("widgets-stack", ""), h.Class("relative isolate flex flex-col px-2 pb-2 pt-[var(--chat-navbar-h,0px)]")], [
      ...gitWidgetsView(context, h),
      widgetPresence({ key: "tasks", show: facts.tasks.length > 0 }, [
        tasksWidget({
          tasks: facts.tasks,
          toolIds: facts.toolIds,
          entries: facts.entries,
          host: {
            list: TASKS_LIST,
            hoveredKey: model.hovered[TASKS_LIST] ?? null,
            toHover,
            stopping,
            error: model.stopError,
            showAll: model.showAllTasks,
            onShowAll: (shown) => Message.ClickedShowAllTasks({ shown }),
            now: model.now,
            menu: (task, label) => rowMenu(model, { _tag: "Task", taskId: task.id }, label, h),
            onJump: (toolId) => Message.ClickedTask({ toolId }),
            ...(canOpenChats ? { onOpenChat: (subChatId: string) => Message.ClickedSubChat({ chatId: subChatId }) } : {}),
            chatTitle: (subChatId) => sidebarThread(app, subChatId)?.title,
            chatHarness: (subChatId) => {
              const provider = sidebarThread(app, subChatId)?.row.provider
              return provider ? PROVIDER_LABELS.get(provider) : undefined
            },
          },
        }, h),
      ], h),
      widgetPresence({ key: "workflows", show: facts.workflows.length > 0 }, [
        workflowWidget(facts.workflows, {
          list: workflowList,
          hovered: model.hovered,
          toHover,
          stopping,
          onStop: (workflowId) => Message.ClickedStopTask({ taskId: workflowId }),
          now: model.now,
        }, h),
      ], h),
      widgetPresence({ key: "schedules", show: facts.schedules.length > 0 }, [
        schedulesWidget(facts.schedules, {
          list: SCHEDULES_LIST,
          hoveredKey: model.hovered[SCHEDULES_LIST] ?? null,
          toHover,
          now: model.now,
          menu: (schedule) => rowMenu(model, { _tag: "Schedule", scheduleId: schedule.id }, "Schedule actions", h),
          card: (schedule) => ({
            currentChatId: chatId,
            now: model.now,
            chatTitle: (otherChatId) => sidebarThread(app, otherChatId)?.title,
            onOpenChat: (otherChatId) => Message.ClickedScheduleRunChat({ chatId: otherChatId }),
            onEdit: Message.ClickedEditSchedule({ scheduleId: schedule.id, fromCard: true }),
          }),
        }, h),
      ], h),
      widgetPresence({ key: "attachments", show: attachments.length > 0 }, [attachmentsWidget(attachments, h)], h),
      portsWidget(context, h),
      quickActionsWidget(context, h),
      ...usageWidgets(context, selectedProvider(app, chatId, facts.activeProvider), h),
    ]),
    rowMenuView(context, facts.toolIds, h),
    h.submodel({
      slotId: "widgets-app-dialog",
      model: model.appDialog,
      view: AppDialog.view,
      toParentMessage: (message) => Message.GotAppDialogMessage({ message }),
    }),
    h.keyed("span")(JSON.stringify(watch), [h.Hidden(true), h.OnMount(ObserveWidgetsPage({ watch, paths }))], []),
  ])
}

export function view(model: Model, inputs: ChatPageSliceInputs, h: H): Html {
  const context = columnContext(model, inputs.app, inputs.page, inputs.requests)
  return context ? columnView(context, h) : null
}
