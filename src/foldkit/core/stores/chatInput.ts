import { Effect, Schema } from "effect"
import { Command, type Update } from "foldkit"
import { defineMessageUnion } from "foldkit/message"
import type { ChatAttachment } from "../../../shared/types"
import { opaque } from "../schema"
import { readPersistedStore } from "../storage"

// Port of src/client/stores/chatInputStore.ts: every chat's unsent draft.

/**
 * `localStorage.setItem` is synchronous, and the persisted blob is every draft
 * in every chat. Writing it on each keystroke put a JSON.stringify plus a disk
 * write on the typing path. Writes now settle for a moment first, and flush on
 * `pagehide` so a closing tab keeps its last characters.
 *
 * The debounce is a module-level writer, as it was in React: it is the one
 * place pending text waits, the `pagehide` listener has to reach it, and a
 * Command per keystroke only hands it the latest blob (cheap). Interrupting
 * and re-dispatching a delayed Command per keystroke would do the same with a
 * race between the two (see the Commands docs on sequencing replacements).
 */
const DRAFT_PERSIST_DELAY_MS = 300

interface DebouncedWriter {
  setItem: (key: string, value: string) => void
  flush: () => void
}

function createDebouncedWriter(storage: Storage, delayMs: number): DebouncedWriter {
  const pending = new Map<string, string>()
  let timer: ReturnType<typeof setTimeout> | null = null

  const flush = () => {
    if (timer !== null) {
      clearTimeout(timer)
      timer = null
    }
    for (const [key, value] of pending) {
      try {
        storage.setItem(key, value)
      } catch {
        // Quota or private mode: the draft stays in memory for this session.
      }
    }
    pending.clear()
  }

  return {
    flush,
    setItem: (key, value) => {
      pending.set(key, value)
      if (timer === null) {
        timer = setTimeout(flush, delayMs)
      }
    },
  }
}

let debouncedWriter: DebouncedWriter | null = null

/**
 * Text typed that no saved state holds yet, by chat. zustand's set persisted
 * inside the input handler; here the keystroke reaches the store an update
 * and a Command later, which a busy page can still be waiting on when it is
 * left. The input handler notes the text at once (`noteTypedDraft`), a save
 * that carries it clears the note, and `pagehide` writes what is left.
 */
const unsaved = new Map<string, string>()

function writeUnsaved() {
  if (unsaved.size === 0) return
  try {
    const raw = window.localStorage.getItem(STORAGE_NAME)
    const blob = raw ? JSON.parse(raw) as { state?: Record<string, unknown>; version?: number } : { state: {}, version: STORAGE_VERSION }
    const state = blob.state ?? {}
    const drafts = { ...(state.drafts as Record<string, string> | undefined ?? {}) }
    for (const [chatId, value] of unsaved) {
      if (value) drafts[chatId] = value
      else delete drafts[chatId]
    }
    window.localStorage.setItem(STORAGE_NAME, JSON.stringify({ ...blob, state: { ...state, drafts } }))
  } catch {
    // Quota, private mode or a blob this can't read: the store's own save stands.
  }
  unsaved.clear()
}

/** Null where there is no `localStorage` (tests); the drafts then live in memory only. */
function getDebouncedWriter(): DebouncedWriter | null {
  if (typeof window === "undefined" || !("localStorage" in window)) return null
  if (!debouncedWriter) {
    debouncedWriter = createDebouncedWriter(window.localStorage, DRAFT_PERSIST_DELAY_MS)
    window.addEventListener("pagehide", debouncedWriter.flush)
    // After the writer's own flush: on top of the last state it saved.
    window.addEventListener("pagehide", writeUnsaved)
  }
  return debouncedWriter
}

/** The composer's input handler: this text is the chat's draft, before the store has it. */
export function noteTypedDraft(chatId: string, value: string) {
  if (!getDebouncedWriter()) return
  unsaved.set(chatId, value)
}

export interface StartedChat {
  projectId: string
  at: number
}

const StartedChatSchema = Schema.Struct({ projectId: Schema.String, at: Schema.Number })
const Attachments = Schema.Array(opaque<ChatAttachment>("ChatAttachment"))

export const Model = Schema.Struct({
  drafts: Schema.Record(Schema.String, Schema.String),
  /**
   * When each draft *appeared* — the moment the composer went from empty to
   * holding something, not the last keystroke. That's what the sidebar sorts
   * by, so a chat keeps the place it took when you started writing rather than
   * climbing a row at a time as you type. Persisted alongside the text so the
   * order survives a reload; absent for drafts written before this existed,
   * which fall back to chat activity.
   */
  draftStartedAt: Schema.Record(Schema.String, Schema.Number),
  /**
   * When each draft was last changed, text or attachments. Unlike
   * `draftStartedAt` it moves with every keystroke, so nothing that draws a
   * list reads it: it only picks between two drafts (`resolveProjectNewChat`).
   */
  draftTouchedAt: Schema.Record(Schema.String, Schema.Number),
  attachmentDrafts: Schema.Record(Schema.String, Attachments),
  /**
   * The chats this browser started as new chats, and the project each is in.
   * A new chat that is never sent from is deleted by the server once nothing
   * is connected to speak for its draft, and the draft is then under an id no
   * list shows. This is what still says which project it was being written
   * in, so that a click on the project can bring it back.
   */
  startedChats: Schema.Record(Schema.String, StartedChatSchema),
})
export type Model = typeof Model.Type

export const STORAGE_NAME = "chat-input-drafts"
/** zustand's default: the store never set one. */
export const STORAGE_VERSION = 0

export const initialModel: Model = {
  drafts: {},
  draftStartedAt: {},
  draftTouchedAt: {},
  attachmentDrafts: {},
  startedChats: {},
}

/** The persisted state over the defaults, as zustand's persist hydrates. */
export function load(storage?: Storage): Model {
  return { ...initialModel, ...readPersistedStore<Model>(STORAGE_NAME, STORAGE_VERSION, undefined, storage) }
}

/** A started chat with nothing written in it is remembered this long, for a draft still to come. */
const STARTED_CHAT_MEMORY_MS = 24 * 60 * 60 * 1000

function without<TValue>(record: Readonly<Record<string, TValue>>, key: string): Readonly<Record<string, TValue>> {
  if (!(key in record)) return record
  const { [key]: _, ...rest } = record
  return rest
}

// Messages that the store stamped with `Date.now()` carry the time instead
// (update can't read the clock); `ChangeDraft`, `ChangeAttachmentDrafts` and
// `RememberStartedChat` stamp it for a caller that has none.
export const Message = defineMessageUnion({
  ChangedDraft: { chatId: Schema.String, value: Schema.String, at: Schema.Number },
  ClearedDraft: { chatId: Schema.String },
  ChangedAttachmentDrafts: { chatId: Schema.String, attachments: Attachments, at: Schema.Number },
  ClearedAttachmentDrafts: { chatId: Schema.String },
  /** Everything one chat's draft is (text, attachments, its times), under another chat's id. */
  MovedDraft: { fromChatId: Schema.String, toChatId: Schema.String },
  RememberedStartedChat: { chatId: Schema.String, projectId: Schema.String, at: Schema.Number },
  ForgotStartedChat: { chatId: Schema.String },
  CompletedSave: {},
})
export type Message = typeof Message.Type

export const SaveDrafts = Command.define("SaveChatInputDrafts", {
  args: { state: Model },
  messages: [Message.CompletedSave],
  execute: ({ state }) => Effect.sync(() => {
    getDebouncedWriter()?.setItem(STORAGE_NAME, JSON.stringify({ state, version: STORAGE_VERSION }))
    // What this state carries is saved the ordinary way now.
    for (const [chatId, value] of unsaved) {
      if ((state.drafts[chatId] ?? "") === value) unsaved.delete(chatId)
    }
    return Message.CompletedSave()
  }),
})

export const ChangeDraft = Command.define("ChangeDraft", {
  args: { chatId: Schema.String, value: Schema.String },
  messages: [Message.ChangedDraft],
  execute: ({ chatId, value }) => Effect.sync(() => Message.ChangedDraft({ chatId, value, at: Date.now() })),
})

export const ChangeAttachmentDrafts = Command.define("ChangeAttachmentDrafts", {
  args: { chatId: Schema.String, attachments: Attachments },
  messages: [Message.ChangedAttachmentDrafts],
  execute: ({ chatId, attachments }) => Effect.sync(() => Message.ChangedAttachmentDrafts({ chatId, attachments, at: Date.now() })),
})

export const RememberStartedChat = Command.define("RememberStartedChat", {
  args: { chatId: Schema.String, projectId: Schema.String },
  messages: [Message.RememberedStartedChat],
  execute: ({ chatId, projectId }) => Effect.sync(() => Message.RememberedStartedChat({ chatId, projectId, at: Date.now() })),
})

// zustand's persist writes after every `set`, changed or not; so does this.
function saved(model: Model): Update.Return<Model, Message> {
  return { model, commands: [SaveDrafts({ state: model })] }
}

function clearedDraft(model: Model, chatId: string): Model {
  return {
    ...model,
    drafts: without(model.drafts, chatId),
    draftStartedAt: without(model.draftStartedAt, chatId),
    // Staged attachments are still a draft, last touched when they were.
    draftTouchedAt: model.attachmentDrafts[chatId] ? model.draftTouchedAt : without(model.draftTouchedAt, chatId),
  }
}

function clearedAttachmentDrafts(model: Model, chatId: string): Model {
  return {
    ...model,
    attachmentDrafts: without(model.attachmentDrafts, chatId),
    draftTouchedAt: model.drafts[chatId] ? model.draftTouchedAt : without(model.draftTouchedAt, chatId),
  }
}

export const update = (model: Model, message: Message): Update.Return<Model, Message> =>
  Message.match<Update.Return<Model, Message>>(message, {
    ChangedDraft: ({ chatId, value, at }) => {
      if (!value) return saved(clearedDraft(model, chatId))
      // Stamped on the clean → dirty flip only. Every later keystroke
      // leaves it alone, so the object identity holds still while you type
      // and the sidebar doesn't re-sort under the cursor.
      const startedAt = model.draftStartedAt[chatId]
      return saved({
        ...model,
        drafts: { ...model.drafts, [chatId]: value },
        draftStartedAt: startedAt == null ? { ...model.draftStartedAt, [chatId]: at } : model.draftStartedAt,
        draftTouchedAt: { ...model.draftTouchedAt, [chatId]: at },
      })
    },
    ClearedDraft: ({ chatId }) => saved(clearedDraft(model, chatId)),
    ChangedAttachmentDrafts: ({ chatId, attachments, at }) => {
      if (attachments.length === 0) return saved(clearedAttachmentDrafts(model, chatId))
      return saved({
        ...model,
        attachmentDrafts: { ...model.attachmentDrafts, [chatId]: attachments },
        draftTouchedAt: { ...model.draftTouchedAt, [chatId]: at },
      })
    },
    ClearedAttachmentDrafts: ({ chatId }) => saved(clearedAttachmentDrafts(model, chatId)),
    MovedDraft: ({ fromChatId, toChatId }) => {
      if (fromChatId === toChatId) return saved(model)
      const move = <TValue>(record: Readonly<Record<string, TValue>>) => {
        const value = record[fromChatId]
        const rest = without(record, fromChatId)
        return value === undefined ? rest : { ...rest, [toChatId]: value }
      }
      return saved({
        ...model,
        drafts: move(model.drafts),
        draftStartedAt: move(model.draftStartedAt),
        draftTouchedAt: move(model.draftTouchedAt),
        attachmentDrafts: move(model.attachmentDrafts),
      })
    },
    RememberedStartedChat: ({ chatId, projectId, at }) => {
      // Housekeeping rides along: a chat with no draft has nothing to be
      // found by, once it is too old to be getting one.
      const kept = Object.entries(model.startedChats).filter(([id, started]) => (
        Boolean(model.drafts[id]) || Boolean(model.attachmentDrafts[id]) || at - started.at < STARTED_CHAT_MEMORY_MS
      ))
      return saved({ ...model, startedChats: { ...Object.fromEntries(kept), [chatId]: { projectId, at } } })
    },
    ForgotStartedChat: ({ chatId }) => saved(
      chatId in model.startedChats ? { ...model, startedChats: without(model.startedChats, chatId) } : model,
    ),
    CompletedSave: () => ({ model }),
  })

/** The raw draft text, `""` when there is none (`getDraft`). */
export function getDraft(model: Model, chatId: string): string {
  return model.drafts[chatId] ?? ""
}

export function getAttachmentDrafts(model: Model, chatId: string): ReadonlyArray<ChatAttachment> {
  return model.attachmentDrafts[chatId] ?? []
}

/**
 * One chat's unsent draft, trimmed, `""` when it has none — whitespace alone is
 * not something to advertise (`useChatDraft`). Drafts live in the browser,
 * never on the server, so anything reading this is per-device.
 */
export function chatDraft(model: Model, chatId: string): string {
  return (model.drafts[chatId] ?? "").trim()
}

/**
 * Whether a chat holds an unsent draft (`useChatHasDraft`). The text changes on
 * every keystroke; whether there *is* text changes twice per draft. Surfaces
 * that only show a pencil icon or enable a "Clear Draft" item want this one.
 */
export function chatHasDraft(model: Model, chatId: string): boolean {
  return (model.drafts[chatId] ?? "").trim().length > 0
}

let lastStartTimes: { record: Record<string, number>; map: ReadonlyMap<string, number> } | null = null

function shallowEqual(left: Record<string, number>, right: Record<string, number>) {
  const leftKeys = Object.keys(left)
  if (leftKeys.length !== Object.keys(right).length) return false
  return leftKeys.every((key) => key in right && left[key] === right[key])
}

/**
 * Every chat holding an unsent draft, mapped to when that draft appeared.
 * Drives the sidebar's Relevant section: membership keeps those chats out of
 * the date buckets, and the value is what they sort by.
 *
 * `0` means "draft with no known start time" — written before the timestamp
 * existed. Callers fall back to the chat's own activity there rather than
 * sinking it to the bottom of the list.
 *
 * Compared shallowly with the last answer (`useDraftStartTimes` did the same
 * with `useShallow`), and the underlying stamps only move on the clean → dirty
 * flip, so the identity changes when a chat gains or loses a draft and at no
 * other time — never mid-sentence, which would re-sort the list you are
 * looking at.
 */
export function draftStartTimes(model: Model): ReadonlyMap<string, number> {
  const times: Record<string, number> = {}
  for (const [chatId, draft] of Object.entries(model.drafts)) {
    if (!draft.trim()) continue
    times[chatId] = model.draftStartedAt[chatId] ?? 0
  }
  if (lastStartTimes && shallowEqual(lastStartTimes.record, times)) return lastStartTimes.map
  lastStartTimes = { record: times, map: new Map(Object.entries(times)) }
  return lastStartTimes.map
}
