import { Effect, Schema, Stream } from "effect"
import { Command, Subscription, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import { modifyFields } from "foldkit/struct"
import { applySidebarProjectOrder } from "../../../client/app/kannaStateHelpers"
import { stabilizeSidebarData } from "../../../client/app/sidebarStability"
import { formatProjectRepoBranch } from "../../../client/lib/project-label"
import { applySidebarPatch, type SidebarPatch } from "../../../shared/sidebar-patch"
import type { KannaStatus, SidebarChatRow, SidebarData, SidebarProjectGroup } from "../../../shared/types"
import { opaque } from "../schema"
import { KannaSocketService, topicStream } from "../socket"

// Port of src/client/stores/sidebarStore.ts, plus the patch bookkeeping
// useKannaState's sidebar subscription did before handing the store a
// snapshot (the `held` copy and the resubscribe on a patch that doesn't
// apply), so the root only has to feed it the topic's pushes.
//
// The React store existed to keep the snapshot out of the React tree (every
// sidebar push re-rendered the app). Here it is one field of the root Model;
// what still matters is identity: a push that changes nothing keeps `data`
// as it was, and an unchanged group keeps its object, so memoized views
// (`h.lazy`) below skip their work.

const SidebarDataSchema = opaque<SidebarData>("SidebarData")

/** The server's last snapshot as sent, which a patch applies to (not `data`, which carries the local drag order). */
interface HeldSnapshot {
  revision: number | null
  data: SidebarData
}

export const Model = Schema.Struct({
  data: SidebarDataSchema,
  ready: Schema.Boolean,
  /**
   * Drag-reorder applied locally until the server echoes it back. Cleared once
   * the pushed order matches, so a failed reorder snaps back rather than sticks.
   */
  optimisticProjectOrder: Schema.NullOr(Schema.Array(Schema.String)),
  held: Schema.NullOr(opaque<HeldSnapshot>("HeldSidebarSnapshot")),
  /**
   * Bumped when a patch doesn't start from `held` or doesn't apply: the two
   * fell out of step. The root's `sidebar` subscription lists this in its
   * dependencies, so a bump closes it and subscribes afresh, which starts
   * over with a reset.
   */
  subscriptionGeneration: Schema.Number,
})
export type Model = typeof Model.Type

const EMPTY_SIDEBAR_DATA: SidebarData = { projectGroups: [] }

export const initialModel: Model = {
  data: EMPTY_SIDEBAR_DATA,
  ready: false,
  optimisticProjectOrder: null,
  held: null,
  subscriptionGeneration: 0,
}

/** What the root subscribes to (`{ type: "sidebar", patches: true }`) and what arrives on it. */
export type SidebarPush = SidebarData | SidebarPatch

export const Message = defineMessageUnion({
  /** A push on the `sidebar` topic: a full snapshot or a patch. */
  ReceivedSidebarPush: { push: opaque<SidebarPush>("SidebarPush") },
  /** A whole snapshot from elsewhere (`setSnapshot`). */
  ReceivedSidebarSnapshot: { snapshot: SidebarDataSchema },
  /** A drag-reorder, ahead of the server; null drops it. */
  ChangedOptimisticProjectOrder: { projectIds: Schema.NullOr(Schema.Array(Schema.String)) },
  CompletedWarn: {},
})
export type Message = typeof Message.Type

/**
 * Facts the root acts on. A snapshot was applied: the pending-send model
 * prunes against it (`PendingSend.ReceivedSidebarSnapshot`), and the command
 * error clears, as useKannaState's subscription did on every push.
 */
export const OutMessage = defineMessageUnion({
  AppliedSidebarSnapshot: { projectGroups: Schema.Array(opaque<SidebarProjectGroup>("SidebarProjectGroup")) },
})
export type OutMessage = typeof OutMessage.Type

export const WarnPatchFailed = Command.define("WarnSidebarPatchFailed", {
  args: { error: Schema.String },
  messages: [Message.CompletedWarn],
  execute: ({ error }) => Effect.sync(() => {
    console.warn("[sidebar] patch did not apply, resubscribing:", error)
    return Message.CompletedWarn()
  }),
})

type Return = Update.ReturnWithOutMessage<Model, Message, OutMessage>

function applyOptimisticOrder(data: SidebarData, order: ReadonlyArray<string> | null): SidebarData {
  const projectGroups = applySidebarProjectOrder(data.projectGroups, order as string[] | null)
  return projectGroups === data.projectGroups ? data : { ...data, projectGroups }
}

/** `setSnapshot`. */
function applySnapshot(model: Model, snapshot: SidebarData): Model {
  // Stabilize against what we already hold before applying the local order,
  // so an unchanged group keeps its identity through both steps.
  const stabilized = stabilizeSidebarData(model.data, snapshot)
  const ordered = applyOptimisticOrder(stabilized, model.optimisticProjectOrder)
  const orderSettled = model.optimisticProjectOrder !== null
    && applySidebarProjectOrder(stabilized.projectGroups, model.optimisticProjectOrder as string[])
      === stabilized.projectGroups
  return modifyFields(model, {
    data: () => ordered,
    ready: () => true,
    optimisticProjectOrder: (order) => (orderSettled ? null : order),
  })
}

function applied(model: Model, snapshot: SidebarData): Return {
  return {
    model: applySnapshot(model, snapshot),
    outMessage: OutMessage.AppliedSidebarSnapshot({ projectGroups: snapshot.projectGroups }),
  }
}

function resubscribe(model: Model, error?: string): Return {
  return {
    model: modifyFields(model, { held: () => null, subscriptionGeneration: (generation) => generation + 1 }),
    commands: error === undefined ? [] : [WarnPatchFailed({ error })],
  }
}

export const update = (model: Model, message: Message): Return =>
  Message.match<Return>(message, {
    ReceivedSidebarPush: ({ push }) => {
      if ("projectGroups" in push) {
        return applied(modifyFields(model, { held: () => ({ revision: null, data: push }) }), push)
      }
      if (push.from !== null && push.from !== model.held?.revision) return resubscribe(model)
      let data: SidebarData
      try {
        data = applySidebarPatch(model.held?.data ?? null, push)
      } catch (error) {
        return resubscribe(model, error instanceof Error ? error.message : String(error))
      }
      return applied(modifyFields(model, { held: () => ({ revision: push.to, data }) }), data)
    },
    ReceivedSidebarSnapshot: ({ snapshot }) => applied(model, snapshot),
    ChangedOptimisticProjectOrder: ({ projectIds }) => ({
      model: modifyFields(model, {
        optimisticProjectOrder: () => projectIds,
        data: (data) => applyOptimisticOrder(data, projectIds),
      }),
    }),
    CompletedWarn: () => ({ model }),
  })

/**
 * The `sidebar` topic, in patches (see shared/sidebar-patch.ts). Restarted
 * whenever `subscriptionGeneration` moves, which is how a patch that doesn't
 * apply gets a fresh subscription and, with it, a reset.
 */
export const subscriptions = Subscription.make<Model, Message, KannaSocketService>()((entry) => ({
  sidebar: entry(
    { generation: Schema.Number },
    {
      modelToDependencies: (model) => ({ generation: model.subscriptionGeneration }),
      dependenciesToStream: () =>
        topicStream<SidebarPush>({ type: "sidebar", patches: true }).pipe(
          Stream.map((push) => Message.ReceivedSidebarPush({ push })),
        ),
    },
  ),
}))

// Selectors. Each React hook selected one scalar so its component re-rendered
// only when that answer changed; these are the same questions as functions.

/** The whole snapshot. Only the sidebar itself and the open palette want this. */
export function sidebarData(model: Model): SidebarData {
  return model.data
}

export function sidebarReady(model: Model): boolean {
  return model.ready
}

/** The snapshot as it stands (`getSidebarProjectGroups`). */
export function sidebarProjectGroups(model: Model): SidebarData["projectGroups"] {
  return model.data.projectGroups
}

/** A chat's row, archived ones aside: what `findSidebarChat` read off the store. */
export function findSidebarChatRow(data: SidebarData, chatId: string): SidebarChatRow | null {
  for (const group of data.projectGroups) {
    const chat = group.chats.find((row) => row.chatId === chatId)
    if (chat) return chat
  }
  return null
}

/** Every chat row in the snapshot — for lookups inside event handlers. */
export function findSidebarChat(model: Model, chatId: string): SidebarChatRow | null {
  return findSidebarChatRow(model.data, chatId)
}

/**
 * Which project a chat belongs to. Returns null for an unknown chat so the
 * caller can fall back to its own selection.
 */
export function projectIdForChat(model: Model, chatId: string | null): string | null {
  if (!chatId) return null
  for (const group of model.data.projectGroups) {
    if (group.chats.some((chat) => chat.chatId === chatId)) return group.groupKey
    if ((group.archivedChats ?? []).some((chat) => chat.chatId === chatId)) return group.groupKey
  }
  return null
}

/**
 * The chat whose agent this chat reports to, or null for a chat of the user's
 * own. Read live rather than from how the chat began: the link can be moved
 * to another chat after the fact.
 */
export function parentChatId(model: Model, chatId: string | null): string | null {
  return parentChatIdOf(model.data, chatId)
}

/** `parentChatId` on a snapshot. An archived sub-chat still has its parent. */
export function parentChatIdOf(data: SidebarData, chatId: string | null): string | null {
  if (!chatId) return null
  for (const group of data.projectGroups) {
    const chat = group.chats.find((candidate) => candidate.chatId === chatId)
      ?? group.archivedChats?.find((candidate) => candidate.chatId === chatId)
    if (chat) return chat.parentChatId ?? null
  }
  return null
}

/**
 * Whether the chat is a delegator, as the sidebar has it now. Known from app
 * start, before the chat's own snapshot, which is what lets a delegator's
 * page open with its list already in the pane.
 */
export function chatIsDelegator(model: Model, chatId: string | null): boolean {
  if (!chatId) return false
  for (const group of model.data.projectGroups) {
    const chat = group.chats.find((candidate) => candidate.chatId === chatId)
      ?? group.archivedChats?.find((candidate) => candidate.chatId === chatId)
    if (chat) return Boolean(chat.delegator)
  }
  return false
}

export function projectRepoUrl(model: Model, projectId: string | null): string | undefined {
  return projectId
    ? model.data.projectGroups.find((group) => group.groupKey === projectId)?.repoUrl
    : undefined
}

/**
 * Does a chat exist in the snapshot at all? Archived counts — viewing an
 * archived chat is ordinary navigation, so only a deleted chat is "gone".
 */
export function chatExists(model: Model, chatId: string | null): boolean {
  if (!chatId) return false
  return model.data.projectGroups.some((group) =>
    group.chats.some((chat) => chat.chatId === chatId)
    || (group.archivedChats ?? []).some((chat) => chat.chatId === chatId))
}

/**
 * The chat's status as the sidebar last heard it. The sidebar is subscribed from
 * app start, so this is known the moment a chat opens, well before that chat's
 * own snapshot arrives.
 */
export function sidebarChatStatus(model: Model, chatId: string | null): KannaStatus | null {
  if (!chatId) return null
  for (const group of model.data.projectGroups) {
    const chat = group.chats.find((row) => row.chatId === chatId)
      ?? (group.archivedChats ?? []).find((row) => row.chatId === chatId)
    if (chat) return chat.status
  }
  return null
}

/**
 * Whether the sidebar lists the chat as a new chat: no message yet, and still
 * under the name it was made with. The same test the chat's own snapshot is
 * put to once it arrives, so the new chat page can be up before that.
 */
export function sidebarChatIsNew(model: Model, chatId: string | null): boolean {
  if (!chatId) return false
  for (const group of model.data.projectGroups) {
    const chat = group.chats.find((row) => row.chatId === chatId)
    if (chat) return chat.lastMessageAt == null && chat.title === "New Chat"
  }
  return false
}

/** The lead project group's identity — the app's fallback when nothing is open. */
export function firstProjectGroup(model: Model): { groupKey: string | null; localPath: string | null } {
  return {
    groupKey: model.data.projectGroups[0]?.groupKey ?? null,
    localPath: model.data.projectGroups[0]?.localPath ?? null,
  }
}

/**
 * `repo/branch` for the project the composer is pointing at, resolved the way
 * the sidebar resolves it: by id first, falling back to the path when no chat
 * is open.
 */
export function navbarRepoLabel(model: Model, projectId: string | null, localPath: string | undefined): string | null {
  const groups = model.data.projectGroups
  const group = groups.find((item) => item.groupKey === projectId)
    ?? groups.find((item) => item.localPath === localPath)
  return group ? formatProjectRepoBranch(group) : null
}
