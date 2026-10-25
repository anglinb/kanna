import type { HtmlBuilder } from "foldkit/html"
import type { SidebarThread } from "../../../client/lib/thread-sections"
import type { ChatSchedule, StandaloneTranscriptAttachmentMode } from "../../../shared/types"
import { transcriptMarkdown, type MarkdownChild, markdown, type MarkdownSettings } from "../../markdown"
import { Message, type Model } from "./model"

/**
 * What every row view reads besides its message: the Model (its own state),
 * how the host renders (React's TranscriptRenderOptions and which providers
 * are mounted), and the live things a reference to another chat or a
 * schedule draws from. One value per render, built by `rowContext`.
 */

/** React's `TranscriptRenderOptions`, plus which of the transcript's providers the host has. */
export interface RenderOptions {
  readonly readonly: boolean
  /** "text" draws local and chat links as inert spans (standalone exports). */
  readonly localLinkMode: "open" | "text"
  /** In "text" mode, the origin absolute chat links are recognised against. */
  readonly sourceOrigin: string | null
  readonly attachmentMode: "live" | StandaloneTranscriptAttachmentMode
  /** A loader for raw JSON exists (live snapshots omit `debugRaw`): React's `loadEntryDebugRaw !== null`. */
  readonly canLoadDebugRaw: boolean
  /** Local file links are handled (`OpenedLocalLink`) rather than followed: an `OpenLocalLinkProvider` is mounted. */
  readonly interceptLocalLinks: boolean
}

export const DEFAULT_RENDER_OPTIONS: RenderOptions = {
  readonly: false,
  localLinkMode: "open",
  sourceOrigin: null,
  attachmentMode: "live",
  canLoadDebugRaw: false,
  interceptLocalLinks: false,
}

/**
 * The open chat's schedules (React's `ChatSchedulesValue` without `onEdit`:
 * a live schedule card's Edit and hover card come with `renderScheduleCard`).
 */
export interface ScheduleReferences {
  readonly chatId: string | null
  readonly schedules: ReadonlyArray<ChatSchedule>
}

/**
 * What it takes to show another chat or a schedule from inside a chat
 * (React's ChatReferenceProvider, ChatSchedulesProvider and
 * `useSidebarThread`). Null outside a chat page (an export, a gallery),
 * where every reference draws as plain text with nothing to open.
 */
export interface References {
  /**
   * A chat can be opened from here (React's ChatReferenceActions is
   * provided): chat links, report lines and names become `OpenedChat`.
   */
  readonly canOpenChats: boolean
  /** One chat as the sidebar knows it, or null (`useSidebarThread`). */
  readonly thread: (chatId: string | null | undefined) => SidebarThread | null
  /** The sidebar snapshot has arrived (`useSidebarReady`). */
  readonly sidebarReady: boolean
  /** The project of the chat being read (`ReplyQuoteProjectContext`). */
  readonly currentProjectId: string | null
  readonly schedules: ScheduleReferences | null
  /**
   * A live chat's card: the sidebar's row (ThreadRowContent) under its
   * right-click menu and hover card, which are the sidebar slice's. Given
   * the card's box classes and caption line, returns the card. Absent: the
   * card draws as for a chat the sidebar has not heard of.
   */
  readonly renderChatCard?: (card: LiveChatCard) => import("foldkit/html").Html
  /** A live schedule's card, with its menu and hover card (SchedulesWidget's). Absent: the plain card. */
  readonly renderScheduleCard?: (card: LiveScheduleCard) => import("foldkit/html").Html
}

/** What a live chat card is asked to draw (ChatCard's props once a thread is known). */
export interface LiveChatCard {
  readonly chatId: string
  readonly thread: SidebarThread
  readonly caption: string | null
  readonly quote: boolean
  readonly said: string | undefined
}

/** What a live schedule card is asked to draw (ScheduleCardBox's props). */
export interface LiveScheduleCard {
  readonly schedule: ChatSchedule
  readonly caption: string
  readonly quote: boolean
}

export interface RowContext {
  readonly model: Model
  readonly options: RenderOptions
  readonly references: References | null
  /** Wall clock for "in 4m" and resume times, ms. The host ticks it (useMinuteClock's 20s). */
  readonly now: number
}

export function rowContext(model: Model, options: Partial<RenderOptions> = {}, references: References | null = null, now = Date.now()): RowContext {
  return { model, options: { ...DEFAULT_RENDER_OPTIONS, ...options }, references, now }
}

/** `<TranscriptMarkdown text>` for one block, with its copy buttons keyed by `key`. */
export function transcriptMarkdownChildren(text: string, key: string, context: RowContext, h: HtmlBuilder<Message>): ReadonlyArray<MarkdownChild> {
  const settings: MarkdownSettings<Message> = transcriptMarkdown<Message>({
    copyCode: (copy) => Message.ClickedCodeCopy({ key: `md:${key}`, copy }),
    ...(context.options.interceptLocalLinks ? { openLocalLink: (target) => Message.ClickedLocalLink({ target }) } : {}),
    ...(context.references?.canOpenChats ? { openChat: (chatId: string) => Message.ClickedChatLink({ chatId }) } : {}),
  }, { localLinkMode: context.options.localLinkMode, sourceOrigin: context.options.sourceOrigin })
  const copied = context.model.copied
  return markdown(text, settings, copied && copied.key === `md:${key}` ? copied.block : null, h)
}
